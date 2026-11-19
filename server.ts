import 'dotenv/config';
import dns from 'dns/promises';
import express from 'express';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import {
  deleteListDecoupledFromPostgres,
  dismissItemHistoryInPostgres,
  getUserFavoritesFromPostgres,
  getUserWatchHistoryFromPostgres,
  listListsFromPostgres,
  listMigrationBackups,
  listServersFromPostgres,
  listWorksFromPostgres,
  migrateIndexedDbWithBackup,
  rollbackMigrationBackup,
  ServerRecord,
  setUserFavoritesInPostgres,
  syncCatalogBatchToPostgres,
  updateServerSyncStatusInPostgres,
  updateWorkStatusOrDeleteInPostgres,
  upsertServerInPostgres,
  upsertUserWatchHistoryInPostgres,
} from './src/db/catalogRepository.ts';
import { AuthRequest, requireAuth } from './src/middleware/auth.ts';
import type {
  CatalogItem,
  M3uListRecord,
  PublishStatus,
  WatchHistoryRecord,
} from './src/types/streaming.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

type MappedPlatform =
  | 'netflix'
  | 'disney'
  | 'hbo'
  | 'hulu'
  | 'prime'
  | 'apple';

interface ParsedEpgProgram {
  id: string;
  channelId: string;
  title: string;
  description?: string;
  startMs: number;
  stopMs: number;
}

const DEFAULT_ALLOWED_HOSTS = [
  'topcdn.live',
  'media.w3.org',
  'interactive-examples.mdn.mozilla.net',
  'test-streams.mux.dev',
  'commondatastorage.googleapis.com',
  'storage.googleapis.com',
  'bitdash-a.akamaihd.net',
  'dash.akamaized.net',
  'demo.unified-streaming.com',
];

const authorizedStreamHosts = new Set<string>(
  [
    ...DEFAULT_ALLOWED_HOSTS,
    ...(process.env.ALLOWED_STREAM_ORIGINS || '')
      .split(',')
      .map((item) => {
        const trimmed = item.trim().toLowerCase();
        if (!trimmed) return '';
        try {
          if (/^https?:\/\//i.test(trimmed)) {
            return new URL(trimmed).hostname.toLowerCase();
          }
          return trimmed.split(':')[0];
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  ]
);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let val = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    val = (val << 8) + num;
  }
  return val >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  const inRange = (start: string, prefix: number) => {
    const base = ipv4ToInt(start);
    if (base === null) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (n & mask) === (base & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) ||
    inRange('127.0.0.0', 8) ||
    inRange('169.254.0.0', 16) ||
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.0.2.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) ||
    inRange('198.51.100.0', 24) ||
    inRange('203.0.113.0', 24) ||
    inRange('224.0.0.0', 4) ||
    inRange('240.0.0.0', 4)
  );
}

function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!ip) return true;

  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    return isBlockedIpv4(ip);
  }
  if (ipVersion === 6) {
    if (ip === '::' || ip === '::1') return true;
    // IPv4-mapped IPv6 dotted form: ::ffff:127.0.0.1
    const dottedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (dottedMatch) {
      return isBlockedIpv4(dottedMatch[1]);
    }
    // IPv4-mapped IPv6 hex form: ::ffff:7f00:1
    const hexMatch = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIpv4(v4);
    }
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    const firstHextet = parseInt(ip.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'metadata' ||
    h === 'metadata.google.internal'
  ) {
    return true;
  }
  return false;
}

export function redactUrlCredentialsServer(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';

    const sensitiveParams = [
      'username',
      'user',
      'password',
      'pass',
      'pwd',
      'token',
      'auth',
      'apikey',
      'api_key',
      'key',
      'sig',
      'signature',
    ];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (sensitiveParams.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '***');
      }
    }

    parsed.pathname = parsed.pathname.replace(
      /^(\/(?:live|movie|series))\/([^/]+)\/([^/]+)(\/.*)?$/i,
      '$1/***/***$4'
    );
    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
  }
}

export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Apenas URLs http:// ou https:// são permitidas.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) {
    throw new Error('Acesso bloqueado a host interno ou localhost (SSRF).');
  }

  if (net.isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new Error('Acesso bloqueado a faixa de IP privada/reservada (SSRF).');
    }
    return parsed;
  }

  const records = await dns.lookup(host, { all: true });
  if (!records || records.length === 0) {
    throw new Error('Host não encontrado na resolução DNS.');
  }
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new Error('Acesso bloqueado a endereço IP interno/privado (SSRF).');
    }
  }

  return parsed;
}

function isOriginAuthorized(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (authorizedStreamHosts.has('*') || authorizedStreamHosts.has(clean)) {
    return true;
  }
  for (const allowed of authorizedStreamHosts) {
    if (allowed.startsWith('*.') && clean.endsWith(allowed.slice(1))) {
      return true;
    }
  }
  return false;
}

function authorizeHostname(hostname: string): void {
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (clean && !isBlockedHostname(clean)) {
    authorizedStreamHosts.add(clean);
  }
}

function isTrustedAppRequest(req: express.Request): boolean {
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'same-origin' || secFetchSite === 'same-site') {
    return true;
  }

  const reqHost = String(req.headers.host || '').split(':')[0].toLowerCase();
  const originHeader = String(req.headers.origin || req.headers.referer || '').trim();
  if (originHeader) {
    try {
      const originHost = new URL(originHeader).hostname.toLowerCase();
      if (
        originHost === reqHost ||
        originHost === 'localhost' ||
        originHost === '127.0.0.1' ||
        originHost.endsWith('.run.app')
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

interface RedirectHopInfo {
  status: number;
  urlRedacted: string;
}

async function fetchWithSafeRedirects(
  initialUrl: string,
  init: RequestInit,
  autoAuthorizeRedirects = false
): Promise<{ response: Response; finalUrl: string; redirects: RedirectHopInfo[] }> {
  let currentUrl = initialUrl;
  const redirects: RedirectHopInfo[] = [];
  for (let hop = 0; hop <= 6; hop++) {
    const safeParsed = await assertSafePublicUrl(currentUrl);
    if (autoAuthorizeRedirects && hop > 0) {
      authorizeHostname(safeParsed.hostname);
    }

    const response = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
    });

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      const location = response.headers.get('location')!;
      await response.body?.cancel().catch(() => {});
      const nextUrl = new URL(location, currentUrl).toString();
      redirects.push({
        status: response.status,
        urlRedacted: redactUrlCredentialsServer(nextUrl),
      });
      currentUrl = nextUrl;
      continue;
    }

    return { response, finalUrl: currentUrl, redirects };
  }
  throw new Error('Excesso de redirecionamentos HTTP.');
}

export function classifyTextPlaylistKind(
  text: string
): 'hls' | 'm3u_list' | 'unknown' {
  const clean = text.replace(/^\uFEFF/, '').trimStart();
  if (!clean.startsWith('#EXTM3U')) return 'unknown';

  const hasHlsDirective =
    /#EXT-X-(?:TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|VERSION|KEY|MAP|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS|ENDLIST|MEDIA)\b/i.test(
      clean
    ) || /#EXTINF:\s*\d+(?:\.\d+)?\s*,/i.test(clean);

  const hasM3uListAttrs =
    /\b(?:tvg-name|tvg-logo|tvg-id|group-title)\s*=/i.test(clean) ||
    /#EXTINF:\s*-1\b/i.test(clean);

  if (hasM3uListAttrs && !hasHlsDirective) {
    return 'm3u_list';
  }
  if (hasHlsDirective) {
    return 'hls';
  }
  return 'unknown';
}

export function sniffStreamBytes(bytes: Uint8Array): {
  engine?: 'hls' | 'mpegts' | 'shaka' | 'native';
  mediaType?: 'mp4' | 'webm' | 'mkv' | 'hls' | 'mpegts' | 'dash';
  isHtml: boolean;
  isM3uList: boolean;
} {
  if (bytes.length === 0) return { isHtml: false, isM3uList: false };
  const headText = Buffer.from(bytes.slice(0, Math.min(2048, bytes.byteLength)))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  const headLower = headText.toLowerCase();

  if (
    headLower.startsWith('<!doctype') ||
    headLower.startsWith('<html') ||
    headLower.startsWith('<head') ||
    headLower.startsWith('<body') ||
    headLower.startsWith('<script') ||
    (headLower.startsWith('<') &&
      (headLower.includes('<html') ||
        headLower.includes('<head') ||
        headLower.includes('<title>')))
  ) {
    return { isHtml: true, isM3uList: false };
  }
  if (headText.includes('<MPD')) {
    return { engine: 'shaka', mediaType: 'dash', isHtml: false, isM3uList: false };
  }
  if (headText.startsWith('#EXTM3U')) {
    const kind = classifyTextPlaylistKind(headText);
    if (kind === 'm3u_list') {
      return { isHtml: false, isM3uList: true };
    }
    return { engine: 'hls', mediaType: 'hls', isHtml: false, isM3uList: false };
  }
  if (bytes[0] === 0x47 || headLower.startsWith('flv')) {
    return { engine: 'mpegts', mediaType: 'mpegts', isHtml: false, isM3uList: false };
  }
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return { engine: 'native', mediaType: 'mp4', isHtml: false, isM3uList: false };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return { engine: 'native', mediaType: 'mkv', isHtml: false, isM3uList: false };
  }
  return { isHtml: false, isM3uList: false };
}

export function rewriteHlsManifest(
  rawPlaylist: string,
  baseUrl: string
): string {
  return rawPlaylist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_m, uri) => {
          try {
            const abs = new URL(uri, baseUrl);
            if (
              (abs.protocol === 'http:' || abs.protocol === 'https:') &&
              !isBlockedHostname(abs.hostname)
            ) {
              authorizeHostname(abs.hostname);
              return `URI="/api/stream?url=${encodeURIComponent(abs.toString())}"`;
            }
            return _m;
          } catch {
            return _m;
          }
        });
      }
      try {
        const abs = new URL(trimmed, baseUrl);
        if (
          (abs.protocol === 'http:' || abs.protocol === 'https:') &&
          !isBlockedHostname(abs.hostname)
        ) {
          authorizeHostname(abs.hostname);
          return `/api/stream?url=${encodeURIComponent(abs.toString())}`;
        }
        return line;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function parseXmltvTimestamp(raw: string): number | null {
  // Format: YYYYMMDDHHmmss +HHMM or YYYYMMDDHHmmss
  const m = raw
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (tz) {
    const formattedTz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const ms = Date.parse(`${iso}${formattedTz}`);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(`${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function parseXmltvContent(xmlText: string): ParsedEpgProgram[] {
  const now = Date.now();
  const minWindow = now - 6 * 3600 * 1000;
  const maxWindow = now + 24 * 3600 * 1000;

  const programs: ParsedEpgProgram[] = [];
  const progRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi;
  let match: RegExpExecArray | null;

  while ((match = progRegex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const inner = match[2];

    const startMatch = attrs.match(/start="([^"]+)"/i);
    const stopMatch = attrs.match(/stop="([^"]+)"/i);
    const channelMatch = attrs.match(/channel="([^"]+)"/i);
    if (!startMatch || !channelMatch) continue;

    const startMs = parseXmltvTimestamp(startMatch[1]);
    const stopMs = stopMatch
      ? parseXmltvTimestamp(stopMatch[1])
      : startMs
        ? startMs + 3600 * 1000
        : null;
    if (!startMs || !stopMs) continue;

    // Keep programs within active window (-6h to +24h) to keep IndexedDB fast
    if (stopMs < minWindow || startMs > maxWindow) continue;

    const titleMatch = inner.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;

    const descMatch = inner.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i);
    const channelId = decodeXmlEntities(channelMatch[1]);
    const title = decodeXmlEntities(titleMatch[1]);
    const description = descMatch ? decodeXmlEntities(descMatch[1]) : undefined;

    programs.push({
      id: `${channelId}::${startMs}`,
      channelId,
      title,
      description,
      startMs,
      stopMs,
    });
  }

  return programs;
}

function mapProviderNameToPlatform(name: string): MappedPlatform | null {
  const n = name.toLowerCase();
  if (n.includes('netflix')) return 'netflix';
  if (n.includes('disney')) return 'disney';
  if (
    n.includes('hbo') ||
    n === 'max' ||
    n.includes('max ') ||
    n.includes('warner')
  ) {
    return 'hbo';
  }
  if (n.includes('hulu') || n.includes('star+') || n.includes('star plus')) {
    return 'hulu';
  }
  if (n.includes('prime video') || n.includes('amazon')) return 'prime';
  if (n.includes('apple tv')) return 'apple';
  return null;
}

function isValidHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function createServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // 1. Unified List Fetcher Proxy (/api/fetch-list?url=... and /api/m3u/fetch?url=...)
  // Supports M3U playlists (streaming), JSON catalog feeds, and detects accidental HTML pages
  const handleFetchList = async (
    req: express.Request,
    res: express.Response
  ) => {
    const targetUrl = String(req.query.url || '').trim();
    if (!isValidHttpUrl(targetUrl)) {
      res.status(400).json({ error: 'URL inválida. Informe um link http:// ou https://.' });
      return;
    }

    try {
      const safeParsed = await assertSafePublicUrl(targetUrl);
      authorizeHostname(safeParsed.hostname);
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : 'Host não permitido.',
      });
      return;
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const { response: upstream } = await fetchWithSafeRedirects(
        targetUrl,
        {
          headers: {
            'User-Agent': 'AuraStream-List-Importer/1.0',
            Accept:
              'application/json, application/x-mpegurl, audio/x-mpegurl, text/plain, */*',
          },
          signal: controller.signal,
        },
        true
      );

      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel().catch(() => {});
        res.status(upstream.status || 502).json({
          error: `Falha ao acessar URL (HTTP ${upstream.status}).`,
        });
        return;
      }

      const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        await upstream.body.cancel().catch(() => {});
        res.status(422).json({
          isHtml: true,
          error:
            'A URL informada retornou uma página HTML (site web) e não um arquivo de lista M3U ou catálogo JSON direto.',
        });
        return;
      }

      const reader = upstream.body.getReader();
      let firstChunk: Uint8Array | undefined;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          firstChunk = value;
          break;
        }
      }

      if (!firstChunk) {
        res.status(422).json({
          error: 'O servidor retornou uma resposta vazia.',
        });
        return;
      }

      const headSample = Buffer.from(firstChunk.slice(0, 1024))
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart();
      const headLower = headSample.toLowerCase();

      if (
        headLower.startsWith('<!doctype') ||
        headLower.startsWith('<html') ||
        headLower.startsWith('<head') ||
        headLower.startsWith('<body') ||
        (headLower.startsWith('<') && headLower.includes('<html'))
      ) {
        await reader.cancel().catch(() => {});
        res.status(422).json({
          isHtml: true,
          error:
            'O link informado aponta para uma página HTML, e não para uma lista M3U (#EXTM3U) ou catálogo JSON direto.',
        });
        return;
      }

      let detectedFormat: 'json' | 'm3u' | 'unknown' = 'unknown';
      if (
        headSample.startsWith('{') ||
        headSample.startsWith('[') ||
        contentType.includes('application/json') ||
        contentType.includes('+json')
      ) {
        detectedFormat = 'json';
      } else if (
        headSample.includes('#EXTM3U') ||
        headSample.includes('#EXTINF') ||
        contentType.includes('mpegurl') ||
        /^https?:\/\//i.test(headSample)
      ) {
        detectedFormat = 'm3u';
      }

      const contentLength = upstream.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('X-List-Format', detectedFormat);
      res.setHeader(
        'Content-Type',
        detectedFormat === 'json'
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8'
      );

      res.write(Buffer.from(firstChunk));

      const restStream = new Readable({
        async read() {
          try {
            const { value, done } = await reader.read();
            if (done) {
              this.push(null);
            } else {
              this.push(Buffer.from(value));
            }
          } catch (err) {
            this.destroy(err instanceof Error ? err : new Error('Stream read error'));
          }
        },
      });

      req.on('close', () => {
        restStream.destroy();
        reader.cancel().catch(() => {});
      });

      restStream.pipe(res);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      const message =
        err instanceof Error ? err.message : 'Erro ao acessar URL da lista.';
      if (!res.headersSent) {
        res.status(502).json({ error: message });
      }
    } finally {
      clearTimeout(timeoutId);
    }
  };

  app.get('/api/fetch-list', handleFetchList);
  app.get('/api/m3u/fetch', handleFetchList);

  // Origin Allowlist management for /api/stream
  app.get('/api/stream/allowlist', (_req, res) => {
    res.json({
      hosts: Array.from(authorizedStreamHosts).sort(),
    });
  });

  app.post('/api/stream/authorize-origins', async (req, res) => {
    const body = (req.body || {}) as {
      urls?: string[];
      origins?: string[];
    };
    const candidates = [
      ...(Array.isArray(body.urls) ? body.urls : []),
      ...(Array.isArray(body.origins) ? body.origins : []),
    ];

    const added: string[] = [];
    const rejected: Array<{ input: string; reason: string }> = [];

    for (const raw of candidates.slice(0, 200)) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const candidateUrl = /^https?:\/\//i.test(raw.trim())
        ? raw.trim()
        : `https://${raw.trim()}`;
      try {
        const parsed = await assertSafePublicUrl(candidateUrl);
        authorizeHostname(parsed.hostname);
        added.push(parsed.hostname.toLowerCase());
      } catch (err) {
        rejected.push({
          input: raw.slice(0, 80),
          reason: err instanceof Error ? err.message : 'Host inválido',
        });
      }
    }

    res.json({
      ok: true,
      added: Array.from(new Set(added)),
      rejected,
    });
  });

  type VodResolutionPayload = {
    ok: boolean;
    validationState:
      | 'server_reachable'
      | 'media_available'
      | 'html_challenge'
      | 'offline';
    status: number;
    originalUrl: string;
    resolvedUrl: string;
    finalUrlRedacted: string;
    redirectCount: number;
    redirects: RedirectHopInfo[];
    contentType: string;
    acceptRanges: string;
    mediaType: string;
    detectedEngine?: 'hls' | 'mpegts' | 'shaka' | 'native';
    isHtml?: boolean;
    isM3uList?: boolean;
    latencyMs: number;
    reason: string;
  };

  const vodResolutionCache = new Map<
    string,
    { expiresAt: number; data: VodResolutionPayload }
  >();
  const VOD_CACHE_TTL_MS = 5 * 60 * 1000;

  const sniffFromContentTypeAndUrl = (
    ct: string,
    urlStr: string
  ): {
    engine?: 'hls' | 'mpegts' | 'shaka' | 'native';
    mediaType: string;
  } => {
    const cleanPath = urlStr.split('?')[0].toLowerCase();
    const lowerUrl = urlStr.toLowerCase();
    if (cleanPath.endsWith('.mpd') || lowerUrl.includes('.mpd?') || ct.includes('dash+xml')) {
      return { engine: 'shaka', mediaType: 'dash' };
    }
    if (ct.includes('mpegurl') || cleanPath.endsWith('.m3u8') || lowerUrl.includes('.m3u8?')) {
      return { engine: 'hls', mediaType: 'hls' };
    }
    if (
      ct.includes('mp2t') ||
      ct.includes('x-flv') ||
      cleanPath.endsWith('.ts') ||
      lowerUrl.includes('output=ts')
    ) {
      return { engine: 'mpegts', mediaType: 'mpegts' };
    }
    if (cleanPath.endsWith('.webm') || ct.includes('webm')) {
      return { engine: 'native', mediaType: 'webm' };
    }
    if (cleanPath.endsWith('.mkv') || ct.includes('matroska')) {
      return { engine: 'native', mediaType: 'mkv' };
    }
    if (cleanPath.endsWith('.mov') || ct.includes('quicktime')) {
      return { engine: 'native', mediaType: 'mov' };
    }
    if (cleanPath.endsWith('.avi') || ct.includes('x-msvideo')) {
      return { engine: 'native', mediaType: 'avi' };
    }
    if (
      ct.includes('mp4') ||
      cleanPath.endsWith('.mp4') ||
      cleanPath.endsWith('.m4v')
    ) {
      return { engine: 'native', mediaType: 'mp4' };
    }
    if (ct.startsWith('audio/') || /\.(mp3|aac|ogg|flac)$/i.test(cleanPath)) {
      return { engine: 'native', mediaType: 'audio' };
    }
    return { mediaType: 'unknown' };
  };

  // Helper: Server-side Stream Health Check & Dynamic VOD Resolver (GET Range + byte sniff + SSRF protection)
  const resolveAndProbeStream = async (
    targetUrl: string,
    timeoutMs: number,
    forceRefresh = false
  ): Promise<VodResolutionPayload> => {
    const startedAt = Date.now();
    if (!isValidHttpUrl(targetUrl)) {
      return {
        ok: false,
        validationState: 'offline',
        status: 0,
        originalUrl: targetUrl,
        resolvedUrl: targetUrl,
        finalUrlRedacted: redactUrlCredentialsServer(targetUrl),
        redirectCount: 0,
        redirects: [],
        contentType: '',
        acceptRanges: '',
        mediaType: 'unknown',
        latencyMs: 0,
        reason: 'URL inválida',
      };
    }

    if (!forceRefresh) {
      const cached = vodResolutionCache.get(targetUrl);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }
    }

    try {
      const parsedInit = await assertSafePublicUrl(targetUrl);
      authorizeHostname(parsedInit.hostname);
    } catch (err) {
      return {
        ok: false,
        validationState: 'offline',
        status: 403,
        originalUrl: targetUrl,
        resolvedUrl: targetUrl,
        finalUrlRedacted: redactUrlCredentialsServer(targetUrl),
        redirectCount: 0,
        redirects: [],
        contentType: '',
        acceptRanges: '',
        mediaType: 'unknown',
        latencyMs: Date.now() - startedAt,
        reason: err instanceof Error ? err.message : 'Host bloqueado (SSRF)',
      };
    }

    const commonHeaders = {
      'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
      'Accept-Encoding': 'identity',
      Accept: '*/*',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { response: getResp, finalUrl, redirects } =
        await fetchWithSafeRedirects(
          targetUrl,
          {
            method: 'GET',
            headers: {
              ...commonHeaders,
              Range: 'bytes=0-4095',
            },
            signal: controller.signal,
          },
          true
        );

      const safeFinal = await assertSafePublicUrl(finalUrl);
      authorizeHostname(safeFinal.hostname);

      const contentType = (getResp.headers.get('content-type') || '').toLowerCase();
      const acceptRanges = getResp.headers.get('accept-ranges') || '';
      const isHtmlHeader = contentType.includes('text/html');
      const responsiveStatus = getResp.status >= 200 && getResp.status < 500;
      const inferred = sniffFromContentTypeAndUrl(contentType, finalUrl);

      let detectedEngine = inferred.engine;
      let mediaType = inferred.mediaType;
      let isHtml = isHtmlHeader;
      let isM3uList = false;

      if (getResp.body) {
        try {
          const reader = getResp.body.getReader();
          const firstRead = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: true }>((resolve) =>
              setTimeout(() => resolve({ value: undefined, done: true }), 1500)
            ),
          ]);
          if (firstRead.value) {
            const sniffed = sniffStreamBytes(firstRead.value);
            if (sniffed.isHtml) {
              isHtml = true;
            }
            if (sniffed.isM3uList) {
              isM3uList = true;
            }
            if (sniffed.engine) {
              detectedEngine = sniffed.engine;
            }
            if (sniffed.mediaType) {
              mediaType = sniffed.mediaType;
            }
          }
          await reader.cancel().catch(() => {});
        } catch {
          await (getResp.body as any)?.cancel?.().catch(() => {});
        }
      } else {
        await (getResp.body as any)?.cancel?.().catch(() => {});
      }

      const latencyMs = Date.now() - startedAt;

      let payload: VodResolutionPayload;
      if (isM3uList) {
        payload = {
          ok: false,
          validationState: 'offline',
          status: getResp.status,
          originalUrl: targetUrl,
          resolvedUrl: finalUrl,
          finalUrlRedacted: redactUrlCredentialsServer(finalUrl),
          redirectCount: redirects.length,
          redirects,
          contentType,
          acceptRanges,
          mediaType: 'm3u_playlist',
          isM3uList: true,
          latencyMs,
          reason:
            'URL aponta para uma lista M3U de canais e não para um stream HLS/vídeo direto',
        };
      } else if (isHtml) {
        payload = {
          ok: true,
          validationState: 'html_challenge',
          status: getResp.status,
          originalUrl: targetUrl,
          resolvedUrl: finalUrl,
          finalUrlRedacted: redactUrlCredentialsServer(finalUrl),
          redirectCount: redirects.length,
          redirects,
          contentType,
          acceptRanges,
          mediaType,
          detectedEngine,
          isHtml: true,
          latencyMs,
          reason: `Servidor acessível (Proteção HTML detectada HTTP ${getResp.status})`,
        };
      } else if (getResp.status >= 200 && getResp.status < 300) {
        const hasMediaSignal =
          Boolean(detectedEngine) ||
          contentType.startsWith('video/') ||
          contentType.startsWith('audio/') ||
          contentType.includes('mpegurl') ||
          contentType.includes('octet-stream');
        payload = {
          ok: true,
          validationState: hasMediaSignal ? 'media_available' : 'server_reachable',
          status: getResp.status,
          originalUrl: targetUrl,
          resolvedUrl: finalUrl,
          finalUrlRedacted: redactUrlCredentialsServer(finalUrl),
          redirectCount: redirects.length,
          redirects,
          contentType,
          acceptRanges,
          mediaType,
          detectedEngine,
          latencyMs,
          reason: hasMediaSignal
            ? `Mídia disponível (${contentType || mediaType})`
            : `Servidor acessível (HTTP ${getResp.status})`,
        };
      } else if (responsiveStatus) {
        payload = {
          ok: true,
          validationState: 'server_reachable',
          status: getResp.status,
          originalUrl: targetUrl,
          resolvedUrl: finalUrl,
          finalUrlRedacted: redactUrlCredentialsServer(finalUrl),
          redirectCount: redirects.length,
          redirects,
          contentType,
          acceptRanges,
          mediaType,
          detectedEngine,
          latencyMs,
          reason: `Servidor acessível (HTTP ${getResp.status})`,
        };
      } else {
        payload = {
          ok: false,
          validationState: 'offline',
          status: getResp.status,
          originalUrl: targetUrl,
          resolvedUrl: finalUrl,
          finalUrlRedacted: redactUrlCredentialsServer(finalUrl),
          redirectCount: redirects.length,
          redirects,
          contentType,
          acceptRanges,
          mediaType,
          detectedEngine,
          latencyMs,
          reason: `HTTP ${getResp.status}`,
        };
      }

      if (payload.ok && payload.validationState === 'media_available') {
        if (vodResolutionCache.size >= 500) {
          const oldestKey = vodResolutionCache.keys().next().value;
          if (oldestKey) vodResolutionCache.delete(oldestKey);
        }
        vodResolutionCache.set(targetUrl, {
          expiresAt: Date.now() + VOD_CACHE_TTL_MS,
          data: payload,
        });
      }

      return payload;
    } catch (err) {
      return {
        ok: false,
        validationState: 'offline',
        status: 0,
        originalUrl: targetUrl,
        resolvedUrl: targetUrl,
        finalUrlRedacted: redactUrlCredentialsServer(targetUrl),
        redirectCount: 0,
        redirects: [],
        contentType: '',
        acceptRanges: '',
        mediaType: 'unknown',
        latencyMs: Date.now() - startedAt,
        reason: err instanceof Error ? err.message : 'Timeout / Falha de rede',
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  // 2. Dynamic VOD Resolver (/api/resolve-vod)
  const handleResolveVod = async (
    req: express.Request,
    res: express.Response
  ) => {
    const body = (req.body || {}) as {
      url?: string;
      timeoutMs?: number;
      forceRefresh?: boolean;
    };
    const targetUrl = String(req.query.url || body.url || '').trim();
    if (!isValidHttpUrl(targetUrl)) {
      res.status(400).json({
        ok: false,
        validationState: 'offline',
        reason: 'URL inválida.',
      });
      return;
    }

    let parsedTarget: URL;
    try {
      parsedTarget = await assertSafePublicUrl(targetUrl);
    } catch (err) {
      res.status(403).json({
        ok: false,
        validationState: 'offline',
        reason: err instanceof Error ? err.message : 'Host bloqueado (SSRF).',
      });
      return;
    }

    const trustedRequest = isTrustedAppRequest(req);
    if (!isOriginAuthorized(parsedTarget.hostname) && !trustedRequest) {
      res.status(403).json({
        ok: false,
        validationState: 'proxy_blocked',
        reason: `Origem "${parsedTarget.hostname}" não autorizada.`,
      });
      return;
    }
    authorizeHostname(parsedTarget.hostname);

    const timeoutMs = Math.min(
      Math.max(Number(req.query.timeoutMs || body.timeoutMs || 6500), 1500),
      15000
    );
    const forceRefresh =
      req.query.forceRefresh === '1' ||
      req.query.forceRefresh === 'true' ||
      Boolean(body.forceRefresh);

    const result = await resolveAndProbeStream(
      targetUrl,
      timeoutMs,
      forceRefresh
    );
    res.json(result);
  };

  app.get('/api/resolve-vod', handleResolveVod);
  app.post('/api/resolve-vod', handleResolveVod);

  // 2b. Stream Health Check routes (GET /api/check-stream?url=... and POST /api/stream/probe)
  app.get('/api/check-stream', async (req, res) => {
    const targetUrl = String(req.query.url || '');
    const timeoutMs = Math.min(
      Math.max(Number(req.query.timeoutMs || 6500), 1500),
      15000
    );
    const result = await resolveAndProbeStream(targetUrl, timeoutMs, true);
    res.json({
      ...result,
      finalUrl: result.finalUrlRedacted,
    });
  });

  app.post('/api/stream/probe', async (req, res) => {
    const body = (req.body || {}) as { url?: string; timeoutMs?: number };
    const targetUrl = String(body.url || '');
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs || 6500), 1500),
      15000
    );
    const result = await resolveAndProbeStream(targetUrl, timeoutMs, true);
    res.json({
      ...result,
      finalUrl: result.finalUrlRedacted,
    });
  });

  // 3. Direct HTTP/HTTPS Server-Side Stream Proxy (/api/stream?url=... and alias /api/stream/proxy)
  // Enforces SSRF protection, origin allowlist + safe public CDN redirect authorization,
  // forwards Range/200/206, inspects first chunk to never return HTML as video,
  // streams binary data without full-file buffering, and rewrites relative HLS manifest URLs.
  const inferContentTypeFromPath = (urlPath: string): string => {
    if (urlPath.endsWith('.mp4') || urlPath.endsWith('.m4v')) return 'video/mp4';
    if (urlPath.endsWith('.webm')) return 'video/webm';
    if (urlPath.endsWith('.mkv')) return 'video/x-matroska';
    if (urlPath.endsWith('.mov')) return 'video/quicktime';
    if (urlPath.endsWith('.ts')) return 'video/mp2t';
    if (urlPath.endsWith('.mp3')) return 'audio/mpeg';
    if (urlPath.endsWith('.aac')) return 'audio/aac';
    return '';
  };

  const handleStreamProxy = async (
    req: express.Request,
    res: express.Response
  ) => {
    const targetUrl = String(req.query.url || '').trim();
    if (!isValidHttpUrl(targetUrl)) {
      res.setHeader('X-Aura-Error-Code', 'invalid_url');
      res.status(400).send('URL inválida.');
      return;
    }

    let parsedTarget: URL;
    try {
      parsedTarget = await assertSafePublicUrl(targetUrl);
    } catch (err) {
      res.setHeader('X-Aura-Error-Code', 'ssrf_blocked');
      res
        .status(403)
        .send(err instanceof Error ? err.message : 'Host bloqueado por SSRF.');
      return;
    }

    if (!isOriginAuthorized(parsedTarget.hostname) && !isTrustedAppRequest(req)) {
      res.setHeader('X-Aura-Error-Code', 'origin_not_allowed');
      res
        .status(403)
        .send(
          `Origem "${parsedTarget.hostname}" não autorizada na allowlist do proxy.`
        );
      return;
    }
    authorizeHostname(parsedTarget.hostname);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Range, Origin, Accept, Content-Type'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Aura-Error-Code, X-Aura-Upstream-Status, X-Aura-Upstream-Content-Type, X-Aura-Resolved-Host'
    );

    const controller = new AbortController();
    req.on('close', () => {
      controller.abort();
    });

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        Connection: 'keep-alive',
      };
      if (req.headers.range) {
        headers['Range'] = String(req.headers.range);
      }

      const upstreamMethod = req.method === 'HEAD' ? 'HEAD' : 'GET';
      const { response: upstream, finalUrl } = await fetchWithSafeRedirects(
        targetUrl,
        {
          method: upstreamMethod,
          headers,
          signal: controller.signal,
        },
        true
      );

      const safeFinal = await assertSafePublicUrl(finalUrl);
      authorizeHostname(safeFinal.hostname);
      res.setHeader('X-Aura-Resolved-Host', safeFinal.hostname);

      const contentType = upstream.headers.get('content-type') || '';
      const lowerCt = contentType.toLowerCase();
      res.setHeader('X-Aura-Upstream-Status', String(upstream.status));
      if (contentType) {
        res.setHeader('X-Aura-Upstream-Content-Type', contentType);
      }

      if (lowerCt.includes('text/html')) {
        await upstream.body?.cancel().catch(() => {});
        res.setHeader('X-Aura-Error-Code', 'upstream_html');
        res
          .status(502)
          .send(
            `Servidor de origem retornou HTML (HTTP ${upstream.status}) em vez de stream de mídia.`
          );
        return;
      }

      if (upstream.status >= 400) {
        await upstream.body?.cancel().catch(() => {});
        res.setHeader('X-Aura-Error-Code', 'upstream_http_error');
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);
        res
          .status(upstream.status)
          .send(`Servidor de origem respondeu HTTP ${upstream.status}.`);
        return;
      }

      if (upstreamMethod === 'HEAD') {
        await upstream.body?.cancel().catch(() => {});
        res.status(upstream.status);
        for (const h of [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
          'cache-control',
        ]) {
          const val = upstream.headers.get(h);
          if (val) res.setHeader(h, val);
        }
        if (!upstream.headers.get('accept-ranges')) {
          res.setHeader('Accept-Ranges', 'bytes');
        }
        res.end();
        return;
      }

      if (!upstream.body) {
        res.status(upstream.status).end();
        return;
      }

      const cleanFinalPath = finalUrl.split('?')[0].toLowerCase();
      const isPlaylistMimeOrExt =
        lowerCt.includes('mpegurl') ||
        cleanFinalPath.endsWith('.m3u8') ||
        cleanFinalPath.endsWith('.m3u');

      // ALWAYS read the very first chunk (without buffering the rest of the file)
      // so HTML traps disguised as video/mp4 or 206 Partial Content are NEVER forwarded as video.
      const reader = upstream.body.getReader();
      let firstChunk: Uint8Array | undefined;
      while (true) {
        const firstRead = await reader.read();
        if (firstRead.done) break;
        if (firstRead.value && firstRead.value.byteLength > 0) {
          firstChunk = firstRead.value;
          break;
        }
      }

      if (firstChunk) {
        const sniffed = sniffStreamBytes(firstChunk);
        if (sniffed.isHtml) {
          await reader.cancel().catch(() => {});
          res.setHeader('X-Aura-Error-Code', 'upstream_html');
          res
            .status(502)
            .send(
              `Servidor de origem retornou HTML (HTTP ${upstream.status}) em vez de stream binário.`
            );
          return;
        }

        const headTextStart = Buffer.from(
          firstChunk.slice(0, Math.min(64, firstChunk.byteLength))
        )
          .toString('utf8')
          .replace(/^\uFEFF/, '')
          .trimStart();

        if (headTextStart.startsWith('#EXTM3U') || isPlaylistMimeOrExt) {
          if (headTextStart.startsWith('#EXTM3U')) {
            // Buffer bounded manifest only (max 5 MB) so movies are never loaded into RAM
            const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
            const chunks: Uint8Array[] = [firstChunk];
            let totalBytes = firstChunk.byteLength;

            while (totalBytes < MAX_MANIFEST_BYTES) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                chunks.push(value);
                totalBytes += value.byteLength;
              }
            }

            if (totalBytes >= MAX_MANIFEST_BYTES) {
              await reader.cancel().catch(() => {});
              res.setHeader('X-Aura-Error-Code', 'manifest_too_large');
              res.status(413).send('Manifesto excedeu limite seguro de 5 MB.');
              return;
            }

            const fullText = Buffer.concat(
              chunks.map((c) => Buffer.from(c))
            ).toString('utf8');

            const kind = classifyTextPlaylistKind(fullText);
            if (kind === 'm3u_list') {
              res.setHeader('X-Aura-Error-Code', 'm3u_playlist_not_hls');
              res
                .status(422)
                .send(
                  'A URL aponta para uma lista M3U de canais (#EXTINF:-1), e não para um manifesto HLS (.m3u8).'
                );
              return;
            }

            const rewritten = rewriteHlsManifest(fullText, finalUrl);
            res.status(upstream.status);
            res.setHeader(
              'Content-Type',
              lowerCt.includes('mpegurl')
                ? contentType
                : 'application/vnd.apple.mpegurl; charset=utf-8'
            );
            res.send(rewritten);
            return;
          }
        }
      }

      // Stream binary response (200 / 206) directly without buffering file in memory
      res.status(upstream.status);
      for (const h of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
      ]) {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      if (
        !contentType ||
        lowerCt === 'application/octet-stream' ||
        lowerCt === 'binary/octet-stream'
      ) {
        const inferredCt = inferContentTypeFromPath(cleanFinalPath);
        if (inferredCt) {
          res.setHeader('Content-Type', inferredCt);
        }
      }
      if (!upstream.headers.get('accept-ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      let pushedFirst = false;
      const nodeStream = new Readable({
        async read() {
          try {
            if (!pushedFirst) {
              pushedFirst = true;
              if (firstChunk) {
                this.push(Buffer.from(firstChunk));
                return;
              }
            }
            const { value, done } = await reader.read();
            if (done) {
              this.push(null);
            } else {
              this.push(Buffer.from(value));
            }
          } catch (err) {
            this.destroy(
              err instanceof Error ? err : new Error('Upstream stream error')
            );
          }
        },
      });

      req.on('close', () => {
        nodeStream.destroy();
        reader.cancel().catch(() => {});
      });
      nodeStream.on('error', () => {
        if (!res.headersSent) res.status(502);
        res.end();
      });
      nodeStream.pipe(res);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      if (!res.headersSent) {
        res.setHeader('X-Aura-Error-Code', 'upstream_network_error');
        res
          .status(502)
          .send(
            err instanceof Error ? err.message : 'Stream indisponível'
          );
      }
    }
  };

  app.options(['/api/stream', '/api/stream/proxy'], (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Range, Origin, Accept, Content-Type'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Aura-Error-Code, X-Aura-Upstream-Status, X-Aura-Upstream-Content-Type, X-Aura-Resolved-Host'
    );
    res.status(204).end();
  });
  app.head('/api/stream', handleStreamProxy);
  app.head('/api/stream/proxy', handleStreamProxy);
  app.get('/api/stream', handleStreamProxy);
  app.get('/api/stream/proxy', handleStreamProxy);

  // 4. EPG XMLTV (.xml / .xml.gz) Fetch & Parser
  app.get('/api/epg/fetch', async (req, res) => {
    const targetUrl = String(req.query.url || '');
    if (!isValidHttpUrl(targetUrl)) {
      res.status(400).json({ error: 'URL EPG inválida.' });
      return;
    }

    try {
      const upstream = await fetch(targetUrl, {
        headers: { 'User-Agent': 'AuraStream-EPG-Client/1.0' },
        signal: AbortSignal.timeout(30000),
      });

      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: `Falha ao baixar EPG (HTTP ${upstream.status}).`,
        });
        return;
      }

      const rawBuffer = Buffer.from(await upstream.arrayBuffer());
      const isGzip =
        targetUrl.toLowerCase().endsWith('.gz') ||
        (rawBuffer.length >= 2 &&
          rawBuffer[0] === 0x1f &&
          rawBuffer[1] === 0x8b);

      const xmlBuffer = isGzip ? zlib.gunzipSync(rawBuffer) : rawBuffer;
      const xmlText = xmlBuffer.toString('utf-8');
      const programs = parseXmltvContent(xmlText);

      res.json({
        totalPrograms: programs.length,
        programs,
      });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'Erro ao processar arquivo EPG XMLTV.',
      });
    }
  });

  // 5. TMDB Enrichment Proxy (pt-BR + Watch Providers BR + Networks)
  app.post('/api/tmdb/enrich', async (req, res) => {
    const body = (req.body || {}) as {
      title?: string;
      year?: number;
      type?: string;
      tmdbApiKey?: string;
    };

    const apiKey = (body.tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
    if (!apiKey) {
      res.status(400).json({
        error: 'TMDB API Key não configurada.',
        missingKey: true,
      });
      return;
    }

    const title = String(body.title || '').trim();
    if (!title) {
      res.status(400).json({ error: 'Título ausente para busca no TMDB.' });
      return;
    }

    const mediaKind =
      body.type === 'series' || body.type === 'serie' ? 'tv' : 'movie';
    const isBearer = apiKey.length > 45;

    const tmdbFetch = async (endpoint: string) => {
      const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
      if (!isBearer) {
        url.searchParams.set('api_key', apiKey);
      }
      const resp = await fetch(url.toString(), {
        headers: isBearer
          ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
          : { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        throw new Error(`TMDB HTTP ${resp.status}`);
      }
      return resp.json() as Promise<Record<string, unknown>>;
    };

    try {
      const searchParams = new URLSearchParams({
        query: title,
        language: 'pt-BR',
        include_adult: 'false',
      });
      if (body.year) {
        searchParams.set(
          mediaKind === 'movie' ? 'year' : 'first_air_date_year',
          String(body.year)
        );
      }

      let searchData = (await tmdbFetch(
        `/search/${mediaKind}?${searchParams.toString()}`
      )) as { results?: Array<{ id: number }> };

      if ((!searchData.results || searchData.results.length === 0) && body.year) {
        searchParams.delete(
          mediaKind === 'movie' ? 'year' : 'first_air_date_year'
        );
        searchData = (await tmdbFetch(
          `/search/${mediaKind}?${searchParams.toString()}`
        )) as { results?: Array<{ id: number }> };
      }

      const firstMatch = searchData.results?.[0];
      if (!firstMatch) {
        res.json({ found: false });
        return;
      }

      const details = (await tmdbFetch(
        `/${mediaKind}/${firstMatch.id}?language=pt-BR&append_to_response=credits,watch/providers,videos`
      )) as {
        id: number;
        title?: string;
        name?: string;
        overview?: string;
        vote_average?: number;
        runtime?: number;
        number_of_seasons?: number;
        release_date?: string;
        first_air_date?: string;
        poster_path?: string | null;
        backdrop_path?: string | null;
        genres?: Array<{ id: number; name: string }>;
        networks?: Array<{ name: string }>;
        production_companies?: Array<{ name: string }>;
        credits?: {
          cast?: Array<{ name: string }>;
          crew?: Array<{ name: string; job: string }>;
        };
        'watch/providers'?: {
          results?: {
            BR?: {
              flatrate?: Array<{ provider_name: string }>;
              ads?: Array<{ provider_name: string }>;
              free?: Array<{ provider_name: string }>;
            };
          };
        };
        videos?: {
          results?: Array<{
            key: string;
            site: string;
            type: string;
            iso_639_1?: string;
          }>;
        };
      };

      const brProviders = details['watch/providers']?.results?.BR;
      const providerCandidates: string[] = [
        ...(brProviders?.flatrate?.map((p) => p.provider_name) || []),
        ...(brProviders?.ads?.map((p) => p.provider_name) || []),
        ...(brProviders?.free?.map((p) => p.provider_name) || []),
        ...(details.networks?.map((n) => n.name) || []),
        ...(details.production_companies?.map((c) => c.name) || []),
      ];

      let detectedPlatform: MappedPlatform | null = null;
      for (const candidate of providerCandidates) {
        const mapped = mapProviderNameToPlatform(candidate);
        if (mapped) {
          detectedPlatform = mapped;
          break;
        }
      }

      const cast = (details.credits?.cast || [])
        .slice(0, 6)
        .map((c) => c.name);
      const director =
        details.credits?.crew?.find((c) => c.job === 'Director')?.name ||
        details.networks?.[0]?.name ||
        '';

      const runtimeMins = details.runtime || 0;
      const duration =
        mediaKind === 'tv'
          ? details.number_of_seasons
            ? `${details.number_of_seasons} ${
                details.number_of_seasons === 1 ? 'Temporada' : 'Temporadas'
              }`
            : 'Série'
          : runtimeMins > 0
            ? `${Math.floor(runtimeMins / 60)}h ${runtimeMins % 60}min`
            : '2h 00min';

      const durationSeconds =
        runtimeMins > 0 ? runtimeMins * 60 : mediaKind === 'tv' ? 3000 : 7200;

      const dateStr = details.release_date || details.first_air_date || '';
      const parsedYear = dateStr ? Number(dateStr.slice(0, 4)) : undefined;

      const ytVideo =
        details.videos?.results?.find(
          (v) =>
            v.site === 'YouTube' &&
            v.type === 'Trailer' &&
            v.iso_639_1 === 'pt'
        ) ||
        details.videos?.results?.find(
          (v) => v.site === 'YouTube' && v.type === 'Trailer'
        );

      res.json({
        found: true,
        tmdbId: details.id,
        title: details.title || details.name || title,
        year: parsedYear || body.year,
        synopsis: details.overview || '',
        voteAverage:
          typeof details.vote_average === 'number'
            ? Number(details.vote_average.toFixed(1))
            : undefined,
        genres: (details.genres || []).map((g) => g.name),
        cast,
        director,
        duration,
        durationSeconds,
        posterImage: details.poster_path
          ? `https://image.tmdb.org/t/p/w780${details.poster_path}`
          : undefined,
        backdropImage: details.backdrop_path
          ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}`
          : undefined,
        platform: detectedPlatform,
        youtubeTrailerId: ytVideo?.key,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro na API do TMDB.',
      });
    }
  });

  // 6. YouTube Trailer Search (Data API v3 or automatic embed search fallback)
  app.get('/api/youtube/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) {
      res.status(400).json({ error: 'Consulta vazia.' });
      return;
    }

    const headerKey = String(req.headers['x-youtube-key'] || '').trim();
    const apiKey = headerKey || (process.env.YOUTUBE_API_KEY || '').trim();

    if (apiKey) {
      try {
        const ytUrl = new URL('https://www.googleapis.com/youtube/v3/search');
        ytUrl.searchParams.set('part', 'snippet');
        ytUrl.searchParams.set('type', 'video');
        ytUrl.searchParams.set('maxResults', '3');
        ytUrl.searchParams.set('relevanceLanguage', 'pt');
        ytUrl.searchParams.set('q', query);
        ytUrl.searchParams.set('key', apiKey);

        const ytResp = await fetch(ytUrl.toString(), {
          signal: AbortSignal.timeout(8000),
        });
        if (ytResp.ok) {
          const data = (await ytResp.json()) as {
            items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>;
          };
          const first = data.items?.find((i) => i.id?.videoId);
          if (first?.id?.videoId) {
            res.json({
              videoId: first.id.videoId,
              title: first.snippet?.title || query,
              source: 'youtube-api',
            });
            return;
          }
        }
      } catch {
        // Fall through to automatic embed search fallback
      }
    }

    try {
      const searchPageUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
        query
      )}`;
      const pageResp = await fetch(searchPageUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (pageResp.ok) {
        const html = await pageResp.text();
        const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        if (match?.[1]) {
          res.json({
            videoId: match[1],
            title: query,
            source: 'youtube-fallback',
          });
          return;
        }
      }
    } catch {
      // Ignore network fallback failure
    }

    res.json({ videoId: null, source: 'none' });
  });

  // 7. Phase 02: Persistent Catalog, Decoupled Lists, User Library/History & Migration Routes
  app.get('/api/catalog', requireAuth, async (req: AuthRequest, res) => {
    try {
      const includeArchived =
        req.query.includeArchived === '1' || req.query.includeArchived === 'true';
      const statusParam = req.query.status as PublishStatus | undefined;
      const [worksList, listsRows] = await Promise.all([
        listWorksFromPostgres({
          includeArchived,
          status: statusParam,
        }),
        listListsFromPostgres(),
      ]);
      res.json({ works: worksList, lists: listsRows });
    } catch (error) {
      console.error('GET /api/catalog failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao consultar catálogo.',
      });
    }
  });

  app.post('/api/catalog/sync', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as {
        items?: CatalogItem[];
        list?: M3uListRecord;
        mergeWithoutOverwrite?: boolean;
      };
      const result = await syncCatalogBatchToPostgres({
        items: Array.isArray(body.items) ? body.items : [],
        list: body.list,
        mergeWithoutOverwrite: Boolean(body.mergeWithoutOverwrite),
      });
      res.json(result);
    } catch (error) {
      console.error('POST /api/catalog/sync failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao sincronizar catálogo.',
      });
    }
  });

  app.patch('/api/catalog/works/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workId = String(req.params.id || '').trim();
      if (!workId) {
        res.status(400).json({ error: 'ID da obra ausente.' });
        return;
      }
      await updateWorkStatusOrDeleteInPostgres({
        workId,
        action: 'update',
        patch: (req.body || {}) as Partial<CatalogItem>,
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('PATCH /api/catalog/works/:id failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao atualizar obra.',
      });
    }
  });

  app.delete('/api/catalog/works/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workId = String(req.params.id || '').trim();
      if (!workId) {
        res.status(400).json({ error: 'ID da obra ausente.' });
        return;
      }
      await updateWorkStatusOrDeleteInPostgres({
        workId,
        action: 'delete',
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('DELETE /api/catalog/works/:id failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao remover obra.',
      });
    }
  });

  app.delete('/api/lists/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const listId = String(req.params.id || '').trim();
      if (!listId) {
        res.status(400).json({ error: 'ID da lista ausente.' });
        return;
      }
      const result = await deleteListDecoupledFromPostgres(listId);
      res.json(result);
    } catch (error) {
      console.error('DELETE /api/lists/:id failed:', error);
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Falha ao excluir lista desacoplada.',
      });
    }
  });

  app.get('/api/user/library', requireAuth, async (req: AuthRequest, res) => {
    try {
      const myListIds = await getUserFavoritesFromPostgres(req.user!.uid);
      res.json({ myListIds });
    } catch (error) {
      console.error('GET /api/user/library failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao carregar biblioteca.',
      });
    }
  });

  app.put('/api/user/library', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as { myListIds?: string[] };
      const myListIds = await setUserFavoritesInPostgres(
        req.user!.uid,
        Array.isArray(body.myListIds) ? body.myListIds : []
      );
      res.json({ myListIds });
    } catch (error) {
      console.error('PUT /api/user/library failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao salvar biblioteca.',
      });
    }
  });

  app.get('/api/user/history', requireAuth, async (req: AuthRequest, res) => {
    try {
      const history = await getUserWatchHistoryFromPostgres(req.user!.uid);
      res.json({ history });
    } catch (error) {
      console.error('GET /api/user/history failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao carregar histórico.',
      });
    }
  });

  app.post('/api/user/history', requireAuth, async (req: AuthRequest, res) => {
    try {
      const record = req.body as WatchHistoryRecord;
      if (!record || !record.id || !record.itemId) {
        res.status(400).json({ error: 'Registro de histórico inválido.' });
        return;
      }
      await upsertUserWatchHistoryInPostgres(req.user!.uid, record);
      res.json({ ok: true });
    } catch (error) {
      console.error('POST /api/user/history failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao salvar progresso.',
      });
    }
  });

  app.post(
    '/api/user/history/:workId/dismiss',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const workId = String(req.params.workId || '').trim();
        if (!workId) {
          res.status(400).json({ error: 'ID da obra ausente.' });
          return;
        }
        await dismissItemHistoryInPostgres(req.user!.uid, workId);
        res.json({ ok: true });
      } catch (error) {
        console.error('POST /api/user/history/:workId/dismiss failed:', error);
        res.status(500).json({
          error:
            error instanceof Error
              ? error.message
              : 'Falha ao remover de Continuar Assistindo.',
        });
      }
    }
  );

  app.post('/api/migration/import', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as {
        source?: 'indexeddb_auto' | 'manual_admin';
        items?: CatalogItem[];
        lists?: M3uListRecord[];
        myListIds?: string[];
        watchHistory?: WatchHistoryRecord[];
      };
      const summary = await migrateIndexedDbWithBackup(req.user!.uid, {
        source: body.source || 'indexeddb_auto',
        items: Array.isArray(body.items) ? body.items : [],
        lists: Array.isArray(body.lists) ? body.lists : [],
        myListIds: Array.isArray(body.myListIds) ? body.myListIds : [],
        watchHistory: Array.isArray(body.watchHistory) ? body.watchHistory : [],
      });
      res.json(summary);
    } catch (error) {
      console.error('POST /api/migration/import failed:', error);
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Falha ao migrar dados para o banco persistente.',
      });
    }
  });

  app.get('/api/migration/backups', requireAuth, async (req: AuthRequest, res) => {
    try {
      const backups = await listMigrationBackups(req.user!.uid);
      res.json({ backups });
    } catch (error) {
      console.error('GET /api/migration/backups failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao listar backups.',
      });
    }
  });

  app.post('/api/migration/rollback', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as { backupId?: string };
      if (!body.backupId) {
        res.status(400).json({ error: 'backupId obrigatório.' });
        return;
      }
      const result = await rollbackMigrationBackup(body.backupId, req.user!.uid);
      res.json(result);
    } catch (error) {
      console.error('POST /api/migration/rollback failed:', error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Falha ao executar rollback.',
      });
    }
  });

  // 8. Phase 03: Content Servers Management & Multi-Format Importers (Xtream, Saimo, M3U, JSON)
  app.get('/api/servers', requireAuth, async (_req: AuthRequest, res) => {
    try {
      const serversList = await listServersFromPostgres();
      res.json({ servers: serversList });
    } catch (error) {
      console.error('GET /api/servers failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Falha ao listar servidores.',
      });
    }
  });

  app.post('/api/servers', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Partial<ServerRecord>;
      if (!body.name || !body.baseUrl) {
        res.status(400).json({ error: 'Nome e URL base do servidor são obrigatórios.' });
        return;
      }
      const now = Date.now();
      const serverId = body.id || `srv-${crypto.randomUUID().slice(0, 12)}`;
      const record: ServerRecord = {
        id: serverId,
        name: body.name.trim(),
        baseUrl: body.baseUrl.trim(),
        serverType: body.serverType || 'm3u',
        username: body.username?.trim() || undefined,
        password: body.password?.trim() || undefined,
        lastSyncStatus: body.lastSyncStatus || 'untested',
        itemCount: body.itemCount || 0,
        createdAt: body.createdAt || now,
        updatedAt: now,
      };
      await upsertServerInPostgres(record);
      res.json({ ok: true, server: record });
    } catch (error) {
      console.error('POST /api/servers failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Falha ao salvar servidor.',
      });
    }
  });

  app.post('/api/servers/:id/test', requireAuth, async (req: AuthRequest, res) => {
    try {
      const serverId = String(req.params.id || '').trim();
      const serversList = await listServersFromPostgres();
      const srv = serversList.find((s) => s.id === serverId);
      if (!srv) {
        res.status(404).json({ error: 'Servidor não encontrado.' });
        return;
      }

      const startedAt = Date.now();
      let testUrl = srv.baseUrl;
      if (srv.serverType === 'xtream' && srv.username && srv.password) {
        const norm = srv.baseUrl.replace(/\/+$/, '');
        testUrl = `${norm}/player_api.php?username=${encodeURIComponent(
          srv.username
        )}&password=${encodeURIComponent(srv.password)}`;
      }

      const probe = await resolveAndProbeStream(testUrl, 8000, true);
      const latencyMs = Date.now() - startedAt;

      const status = probe.ok ? 'nominal' : 'error';
      const reason = probe.reason || (probe.ok ? 'Conexão bem-sucedida' : 'Falha de conexão');

      await updateServerSyncStatusInPostgres(serverId, status, srv.itemCount, reason);

      res.json({
        ok: probe.ok,
        status,
        latencyMs,
        reason,
        resolvedUrl: probe.finalUrlRedacted,
      });
    } catch (error) {
      console.error('POST /api/servers/:id/test failed:', error);
      res.status(500).json({
        ok: false,
        status: 'error',
        latencyMs: 0,
        reason: error instanceof Error ? error.message : 'Erro no teste de conexão',
      });
    }
  });

  app.post('/api/servers/:id/sync', requireAuth, async (req: AuthRequest, res) => {
    try {
      const serverId = String(req.params.id || '').trim();
      const serversList = await listServersFromPostgres();
      const srv = serversList.find((s) => s.id === serverId);
      if (!srv) {
        res.status(404).json({ error: 'Servidor não encontrado.' });
        return;
      }

      await updateServerSyncStatusInPostgres(serverId, 'syncing', srv.itemCount, 'Sincronização em andamento...');

      const listId = `list-srv-${serverId}`;
      const now = Date.now();
      let importedCount = 0;

      if (srv.serverType === 'xtream' && srv.username && srv.password) {
        const norm = srv.baseUrl.replace(/\/+$/, '');
        const vodUrl = `${norm}/player_api.php?username=${encodeURIComponent(
          srv.username
        )}&password=${encodeURIComponent(srv.password)}&action=get_vod_streams`;
        const seriesUrl = `${norm}/player_api.php?username=${encodeURIComponent(
          srv.username
        )}&password=${encodeURIComponent(srv.password)}&action=get_series`;

        const [vodResp, seriesResp] = await Promise.all([
          fetch(vodUrl, { signal: AbortSignal.timeout(20000) }).catch(() => null),
          fetch(seriesUrl, { signal: AbortSignal.timeout(20000) }).catch(() => null),
        ]);

        const items: CatalogItem[] = [];
        if (vodResp && vodResp.ok) {
          const vodList = (await vodResp.json().catch(() => [])) as Array<{
            stream_id: number | string;
            name: string;
            stream_icon?: string;
            category_id?: string;
            container_extension?: string;
          }>;
          for (const v of vodList.slice(0, 1000)) {
            const ext = v.container_extension || 'mp4';
            const streamUrl = `${norm}/movie/${encodeURIComponent(srv.username)}/${encodeURIComponent(
              srv.password
            )}/${v.stream_id}.${ext}`;
            items.push({
              id: `xtream-m-${v.stream_id}`,
              title: v.name,
              type: 'movie',
              mediaKind: 'movie',
              year: new Date().getFullYear(),
              genres: ['Xtream VOD'],
              ageRating: '14',
              duration: '2h 00min',
              durationSeconds: 7200,
              platform: 'netflix',
              synopsis: `Conteúdo VOD importado do servidor Xtream ${srv.name}.`,
              cast: [],
              director: srv.name,
              youtubeTrailerId: '',
              posterImage: v.stream_icon || '',
              backdropImage: v.stream_icon || '',
              categories: ['populares'],
              sources: [
                {
                  id: `src-xtream-m-${v.stream_id}`,
                  label: 'Fonte 1 · HD',
                  qualityTag: 'HD',
                  resolutionTag: 'HD',
                  url: streamUrl,
                  listId,
                  status: 'pending',
                },
              ],
              status: 'publicado',
              archived: false,
              healthChecked: false,
              tmdbEnriched: false,
              youtubeEnriched: false,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        if (seriesResp && seriesResp.ok) {
          const seriesList = (await seriesResp.json().catch(() => [])) as Array<{
            series_id: number | string;
            name: string;
            cover?: string;
            plot?: string;
            cast?: string;
            director?: string;
            genre?: string;
          }>;
          for (const s of seriesList.slice(0, 200)) {
            const seriesStreamUrl = `${norm}/series/${encodeURIComponent(srv.username)}/${encodeURIComponent(
              srv.password
            )}/${s.series_id}.mp4`;
            items.push({
              id: `xtream-s-${s.series_id}`,
              title: s.name,
              type: 'series',
              mediaKind: 'series',
              year: new Date().getFullYear(),
              genres: s.genre ? s.genre.split(',') : ['Séries'],
              ageRating: '14',
              duration: '1 Temporada',
              durationSeconds: 3000,
              platform: 'netflix',
              synopsis: s.plot || `Série importada do servidor Xtream ${srv.name}.`,
              cast: s.cast ? s.cast.split(',') : [],
              director: s.director || s.name,
              youtubeTrailerId: '',
              posterImage: s.cover || '',
              backdropImage: s.cover || '',
              categories: ['populares'],
              sources: [],
              episodes: [
                {
                  id: `s1e1-${s.series_id}`,
                  season: 1,
                  episode: 1,
                  title: 'Episódio 1',
                  sources: [
                    {
                      id: `src-xtream-s-${s.series_id}-e1`,
                      label: 'Fonte 1 · HD',
                      qualityTag: 'HD',
                      resolutionTag: 'HD',
                      url: seriesStreamUrl,
                      listId,
                      status: 'pending',
                    },
                  ],
                },
              ],
              status: 'publicado',
              archived: false,
              healthChecked: false,
              tmdbEnriched: false,
              youtubeEnriched: false,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        if (items.length > 0) {
          const resSync = await syncCatalogBatchToPostgres({
            items,
            list: {
              id: listId,
              name: srv.name,
              sourceType: 'xtream',
              xtreamCredentials: {
                serverUrl: srv.baseUrl,
                username: srv.username,
                password: srv.password,
              },
              importedAt: now,
              totalEntries: items.length,
              newItemsCreated: items.length,
              mergedSourcesCount: 0,
              ignoredDuplicatesCount: 0,
            },
          });
          importedCount = items.length;
        }
      } else {
        // M3U / JSON / Saimo sync via URL fetch
        const targetUrl = srv.baseUrl;
        const fetchResp = await fetch(`/api/fetch-list?url=${encodeURIComponent(targetUrl)}`, {
          signal: AbortSignal.timeout(25000),
        }).catch(() => null);

        if (!fetchResp || !fetchResp.ok) {
          throw new Error('Falha ao baixar lista remota do servidor.');
        }

        const text = await fetchResp.text();
        const lines = text.split(/\r?\n/);
        const items: CatalogItem[] = [];

        // Saimo / M3U parse loop
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          if (/^https?:\/\//i.test(trimmed)) {
            items.push({
              id: `item-${crypto.randomUUID().slice(0, 10)}`,
              title: `Stream ${items.length + 1} (${srv.name})`,
              type: 'movie',
              mediaKind: 'movie',
              year: 2024,
              genres: ['Geral'],
              ageRating: '14',
              duration: '2h 00min',
              durationSeconds: 7200,
              platform: 'netflix',
              synopsis: `Stream importado do servidor ${srv.name}.`,
              cast: [],
              director: srv.name,
              youtubeTrailerId: '',
              posterImage: '',
              backdropImage: '',
              categories: ['populares'],
              sources: [
                {
                  id: `src-${crypto.randomUUID().slice(0, 8)}`,
                  label: 'Fonte 1 · HD',
                  qualityTag: 'HD',
                  resolutionTag: 'HD',
                  url: trimmed,
                  listId,
                  status: 'pending',
                },
              ],
              status: 'publicado',
              archived: false,
              healthChecked: false,
              tmdbEnriched: false,
              youtubeEnriched: false,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        if (items.length > 0) {
          await syncCatalogBatchToPostgres({
            items,
            list: {
              id: listId,
              name: srv.name,
              sourceType: 'url',
              sourceLocation: targetUrl,
              importedAt: now,
              totalEntries: items.length,
              newItemsCreated: items.length,
              mergedSourcesCount: 0,
              ignoredDuplicatesCount: 0,
            },
          });
          importedCount = items.length;
        }
      }

      await updateServerSyncStatusInPostgres(serverId, 'nominal', importedCount, 'Sincronizado com sucesso');
      res.json({ ok: true, itemCount: importedCount });
    } catch (error) {
      const serverId = String(req.params.id || '').trim();
      const reason = error instanceof Error ? error.message : 'Erro na sincronização';
      await updateServerSyncStatusInPostgres(serverId, 'error', 0, reason);
      console.error('POST /api/servers/:id/sync failed:', error);
      res.status(500).json({
        ok: false,
        error: reason,
      });
    }
  });

  app.delete('/api/servers/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const serverId = String(req.params.id || '').trim();
      if (!serverId) {
        res.status(400).json({ error: 'ID do servidor ausente.' });
        return;
      }
      await deleteServerInPostgres(serverId);
      res.json({ ok: true });
    } catch (error) {
      console.error('DELETE /api/servers/:id failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Falha ao remover servidor.',
      });
    }
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build não encontrado.');
      }
    });
  }

  return app;
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  createServer()
    .then((app) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`Aura Stream server running at http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}


