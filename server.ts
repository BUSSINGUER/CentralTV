import 'dotenv/config';
import dns from 'dns/promises';
import express from 'express';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

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

async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
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

async function fetchWithSafeRedirects(
  initialUrl: string,
  init: RequestInit,
  autoAuthorizeRedirects = false
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= 5; hop++) {
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
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }
  throw new Error('Excesso de redirecionamentos HTTP.');
}

function classifyTextPlaylistKind(text: string): 'hls' | 'm3u_list' | 'unknown' {
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

function rewriteHlsManifest(
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

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

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

  // Helper: Server-side Stream Health Check (GET Range: bytes=0-2047 + real content/byte sniff + SSRF protection)
  // Never trusts HEAD 200 alone (providers like XUI.one return HEAD 200 video/mp4 while GET returns 200 text/html)
  const checkStreamHealth = async (targetUrl: string, timeoutMs: number) => {
    if (!isValidHttpUrl(targetUrl)) {
      return { ok: false, status: 0, reason: 'URL inválida' };
    }

    const startedAt = Date.now();
    try {
      await assertSafePublicUrl(targetUrl);
    } catch (err) {
      return {
        ok: false,
        status: 403,
        latencyMs: Date.now() - startedAt,
        reason: err instanceof Error ? err.message : 'Host bloqueado (SSRF)',
      };
    }

    const commonHeaders = {
      'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
      'Accept-Encoding': 'identity',
      Accept: '*/*',
    };

    const sniffEngineFromContentType = (
      ct: string,
      urlStr: string
    ): 'hls' | 'mpegts' | 'shaka' | 'native' | undefined => {
      const cleanPath = urlStr.split('?')[0].toLowerCase();
      if (cleanPath.endsWith('.mpd') || ct.includes('dash+xml')) return 'shaka';
      if (ct.includes('mpegurl') || cleanPath.endsWith('.m3u8')) return 'hls';
      if (ct.includes('mp2t') || ct.includes('x-flv') || cleanPath.endsWith('.ts')) {
        return 'mpegts';
      }
      if (
        ct.includes('mp4') ||
        ct.includes('webm') ||
        ct.includes('matroska') ||
        ct.includes('quicktime') ||
        ct.includes('x-msvideo') ||
        cleanPath.endsWith('.mp4') ||
        cleanPath.endsWith('.m4v') ||
        cleanPath.endsWith('.webm') ||
        cleanPath.endsWith('.mkv') ||
        cleanPath.endsWith('.avi') ||
        cleanPath.endsWith('.mov')
      ) {
        return 'native';
      }
      return undefined;
    };

    const sniffEngineFromBytes = (
      bytes: Uint8Array
    ): {
      engine?: 'hls' | 'mpegts' | 'shaka' | 'native';
      isHtml: boolean;
      isM3uList: boolean;
    } => {
      if (bytes.length === 0) return { isHtml: false, isM3uList: false };
      const headText = Buffer.from(bytes.slice(0, 1024))
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart();
      const headLower = headText.toLowerCase();

      if (
        headLower.startsWith('<!doctype') ||
        headLower.startsWith('<html') ||
        headLower.startsWith('<head') ||
        headLower.startsWith('<body') ||
        (headLower.startsWith('<') && headLower.includes('<html'))
      ) {
        return { isHtml: true, isM3uList: false };
      }
      if (headText.includes('<MPD')) {
        return { engine: 'shaka', isHtml: false, isM3uList: false };
      }
      if (headText.startsWith('#EXTM3U')) {
        const kind = classifyTextPlaylistKind(headText);
        if (kind === 'm3u_list') {
          return { isHtml: false, isM3uList: true };
        }
        return { engine: 'hls', isHtml: false, isM3uList: false };
      }
      if (bytes[0] === 0x47 || headLower.startsWith('flv')) {
        return { engine: 'mpegts', isHtml: false, isM3uList: false };
      }
      if (
        (bytes.length >= 8 &&
          bytes[4] === 0x66 &&
          bytes[5] === 0x74 &&
          bytes[6] === 0x79 &&
          bytes[7] === 0x70) ||
        (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
      ) {
        return { engine: 'native', isHtml: false, isM3uList: false };
      }
      return { isHtml: false, isM3uList: false };
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { response: getResp, finalUrl } = await fetchWithSafeRedirects(
        targetUrl,
        {
          method: 'GET',
          headers: {
            ...commonHeaders,
            Range: 'bytes=0-2047',
          },
          signal: controller.signal,
        },
        true
      );

      const contentType = (getResp.headers.get('content-type') || '').toLowerCase();
      const acceptRanges = getResp.headers.get('accept-ranges') || '';
      const isHtmlHeader = contentType.includes('text/html');
      const responsiveStatus = getResp.status >= 200 && getResp.status < 500;

      const result = {
        ok: responsiveStatus,
        status: getResp.status,
        finalUrl,
        contentType,
        acceptRanges,
        detectedEngine: sniffEngineFromContentType(contentType, finalUrl),
        latencyMs: Date.now() - startedAt,
        reason: isHtmlHeader
          ? `Servidor online (Proteção/HTML HTTP ${getResp.status})`
          : responsiveStatus
            ? 'Stream ativo'
            : `HTTP ${getResp.status}`,
      };

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
            const sniffed = sniffEngineFromBytes(firstRead.value);
            if (sniffed.isHtml) {
              await reader.cancel().catch(() => {});
              return {
                ...result,
                ok: true,
                reason: `Servidor online (Proteção HTML detectada HTTP ${getResp.status})`,
              };
            }
            if (sniffed.isM3uList) {
              await reader.cancel().catch(() => {});
              return {
                ...result,
                ok: false,
                reason: 'URL aponta para uma lista M3U de canais e não para um stream HLS/vídeo direto',
              };
            }
            if (sniffed.engine) {
              result.detectedEngine = sniffed.engine;
            }
          }
          await reader.cancel().catch(() => {});
        } catch {
          await (getResp.body as any)?.cancel?.().catch(() => {});
        }
      } else {
        await (getResp.body as any)?.cancel?.().catch(() => {});
      }

      return result;
    } catch (err) {
      return {
        ok: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        reason: err instanceof Error ? err.message : 'Timeout / Falha de rede',
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  // 2. Stream Health Check routes (GET /api/check-stream?url=... and POST /api/stream/probe)
  app.get('/api/check-stream', async (req, res) => {
    const targetUrl = String(req.query.url || '');
    const timeoutMs = Math.min(
      Math.max(Number(req.query.timeoutMs || 6500), 1500),
      15000
    );
    const result = await checkStreamHealth(targetUrl, timeoutMs);
    res.json(result);
  });

  app.post('/api/stream/probe', async (req, res) => {
    const body = (req.body || {}) as { url?: string; timeoutMs?: number };
    const targetUrl = String(body.url || '');
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs || 6500), 1500),
      15000
    );
    const result = await checkStreamHealth(targetUrl, timeoutMs);
    res.json(result);
  });

  // 3. Direct HTTP/HTTPS Server-Side Stream Proxy (/api/stream?url=... and alias /api/stream/proxy)
  // Enforces SSRF protection, origin allowlist, preserves query/auth params, forwards Range/200/206,
  // streams binary data without full-file buffering, and rewrites relative HLS manifest URLs.
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

    if (!isOriginAuthorized(parsedTarget.hostname)) {
      res.setHeader('X-Aura-Error-Code', 'origin_not_allowed');
      res
        .status(403)
        .send(
          `Origem "${parsedTarget.hostname}" não autorizada na allowlist do proxy.`
        );
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Range, Origin, Accept, Content-Type'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Aura-Error-Code, X-Aura-Upstream-Status, X-Aura-Upstream-Content-Type'
    );

    const controller = new AbortController();
    req.on('close', () => {
      controller.abort();
    });

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
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

      const looksLikeBinaryVideo =
        !isPlaylistMimeOrExt &&
        (lowerCt.startsWith('video/') ||
          lowerCt.startsWith('audio/') ||
          cleanFinalPath.endsWith('.mp4') ||
          cleanFinalPath.endsWith('.m4v') ||
          cleanFinalPath.endsWith('.webm') ||
          cleanFinalPath.endsWith('.ts') ||
          cleanFinalPath.endsWith('.mp3') ||
          cleanFinalPath.endsWith('.aac'));

      const maybePlaylist =
        !looksLikeBinaryVideo &&
        (isPlaylistMimeOrExt ||
          lowerCt.includes('text/plain') ||
          lowerCt.includes('application/octet-stream') ||
          !lowerCt);

      const reader = upstream.body.getReader();
      let firstChunk: Uint8Array | undefined;

      if (maybePlaylist) {
        const firstRead = await reader.read();
        if (!firstRead.done && firstRead.value) {
          firstChunk = firstRead.value;
          const headText = Buffer.from(
            firstChunk.slice(0, Math.min(2048, firstChunk.byteLength))
          )
            .toString('utf8')
            .replace(/^\uFEFF/, '')
            .trimStart();
          const headLower = headText.toLowerCase();

          if (
            headLower.startsWith('<!doctype') ||
            headLower.startsWith('<html') ||
            (headLower.startsWith('<') && headLower.includes('<html'))
          ) {
            await reader.cancel().catch(() => {});
            res.setHeader('X-Aura-Error-Code', 'upstream_html');
            res
              .status(502)
              .send(
                `Servidor de origem retornou HTML (HTTP ${upstream.status}) em vez de mídia.`
              );
            return;
          }

          if (headText.startsWith('#EXTM3U')) {
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
      if (!upstream.headers.get('accept-ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      let pushedFirst = false;
      const nodeStream = new Readable({
        async read() {
          try {
            if (!pushedFirst && firstChunk) {
              pushedFirst = true;
              this.push(Buffer.from(firstChunk));
              return;
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
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Aura-Error-Code, X-Aura-Upstream-Status, X-Aura-Upstream-Content-Type'
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Aura Stream server running at http://localhost:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

