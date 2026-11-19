import { SourceValidationState } from '../../types/streaming';
import { DetectedMediaType, unwrapTargetUrl } from './MediaTypeDetector';

export interface PlaybackAttempt {
  mode: 'original' | 'proxy' | 'resolved';
  url: string;
  label: string;
}

export interface RedirectHopInfo {
  status: number;
  urlRedacted: string;
}

export interface ResolvedVodResult {
  ok: boolean;
  validationState: SourceValidationState;
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
  fromCache?: boolean;
}

const CLIENT_VOD_CACHE_TTL_MS = 5 * 60 * 1000;
const clientVodCache = new Map<
  string,
  { expiresAt: number; data: ResolvedVodResult }
>();

export function invalidateResolvedVodCache(rawUrl?: string): void {
  if (!rawUrl) {
    clientVodCache.clear();
    return;
  }
  clientVodCache.delete(rawUrl);
  clientVodCache.delete(unwrapTargetUrl(rawUrl));
}

export async function resolveVodSource(
  rawUrl: string,
  options?: {
    timeoutMs?: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }
): Promise<ResolvedVodResult> {
  const effectiveUrl = unwrapTargetUrl(rawUrl).trim();
  const forceRefresh = Boolean(options?.forceRefresh);
  const timeoutMs = options?.timeoutMs ?? 6500;

  if (!effectiveUrl || !/^https?:\/\//i.test(effectiveUrl)) {
    return {
      ok: false,
      validationState: 'unverified',
      status: 0,
      originalUrl: rawUrl,
      resolvedUrl: rawUrl,
      finalUrlRedacted: rawUrl,
      redirectCount: 0,
      redirects: [],
      contentType: '',
      acceptRanges: '',
      mediaType: 'unknown',
      latencyMs: 0,
      reason: 'URL não requer resolução remota.',
    };
  }

  if (!forceRefresh) {
    const cached = clientVodCache.get(effectiveUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.data, fromCache: true };
    }
  }

  const startedAt = performance.now();
  try {
    const resp = await fetch(
      `/api/resolve-vod?url=${encodeURIComponent(effectiveUrl)}&timeoutMs=${timeoutMs}${
        forceRefresh ? '&forceRefresh=1' : ''
      }`,
      {
        method: 'GET',
        signal: options?.signal,
      }
    );

    const data = (await resp.json().catch(() => null)) as ResolvedVodResult | null;
    if (!data) {
      return {
        ok: false,
        validationState: resp.status === 403 ? 'proxy_blocked' : 'unverified',
        status: resp.status,
        originalUrl: effectiveUrl,
        resolvedUrl: effectiveUrl,
        finalUrlRedacted: effectiveUrl,
        redirectCount: 0,
        redirects: [],
        contentType: '',
        acceptRanges: '',
        mediaType: 'unknown',
        latencyMs: Math.round(performance.now() - startedAt),
        reason: `Falha ao interpretar resposta do resolvedor (HTTP ${resp.status}).`,
      };
    }

    const normalized: ResolvedVodResult = {
      ...data,
      originalUrl: data.originalUrl || effectiveUrl,
      resolvedUrl: data.resolvedUrl || effectiveUrl,
      redirectCount: data.redirectCount ?? (data.redirects?.length || 0),
      redirects: data.redirects || [],
      fromCache: false,
    };

    if (
      normalized.ok &&
      normalized.validationState === 'media_available' &&
      clientVodCache.size < 300
    ) {
      clientVodCache.set(effectiveUrl, {
        expiresAt: Date.now() + CLIENT_VOD_CACHE_TTL_MS,
        data: normalized,
      });
    }

    return normalized;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw err;
    }
    return {
      ok: false,
      validationState: 'proxy_blocked',
      status: 0,
      originalUrl: effectiveUrl,
      resolvedUrl: effectiveUrl,
      finalUrlRedacted: effectiveUrl,
      redirectCount: 0,
      redirects: [],
      contentType: '',
      acceptRanges: '',
      mediaType: 'unknown',
      latencyMs: Math.round(performance.now() - startedAt),
      reason:
        err instanceof Error
          ? err.message
          : 'Erro ao consultar /api/resolve-vod.',
    };
  }
}

export function applyStreamProxyUrl(rawUrl: string, proxyPrefix = ''): string {
  const prefix = proxyPrefix.trim();
  if (!prefix) {
    return `/api/stream?url=${encodeURIComponent(rawUrl)}`;
  }
  if (prefix.includes('{url}')) {
    return prefix.replace('{url}', encodeURIComponent(rawUrl));
  }
  if (prefix.endsWith('=') || prefix.endsWith('?url=')) {
    return `${prefix}${encodeURIComponent(rawUrl)}`;
  }
  if (prefix.endsWith('/')) {
    return `${prefix}${rawUrl}`;
  }
  return `${prefix}${encodeURIComponent(rawUrl)}`;
}

export function buildPlaybackAttempts(
  rawUrl: string,
  mediaType: DetectedMediaType,
  streamProxyPrefix: string,
  autoProxyHttpStreams: boolean,
  forceProxy: boolean,
  resolvedUrl?: string
): PlaybackAttempt[] {
  if (!rawUrl) return [];
  if (rawUrl.startsWith('/api/stream')) {
    return [{ mode: 'proxy', url: rawUrl, label: 'Proxy Interno (/api/stream)' }];
  }

  const effectiveResolved =
    resolvedUrl && resolvedUrl.trim() && resolvedUrl.trim() !== rawUrl.trim()
      ? resolvedUrl.trim()
      : undefined;

  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  const list: PlaybackAttempt[] = [];
  const seenUrls = new Set<string>();

  const pushUnique = (attempt: PlaybackAttempt) => {
    if (!attempt.url || seenUrls.has(attempt.url)) return;
    seenUrls.add(attempt.url);
    list.push(attempt);
  };

  const pushProxyAttempts = (target: string, prefixLabel: string) => {
    const configuredProxyUrl = applyStreamProxyUrl(target, streamProxyPrefix);
    const internalProxyUrl = applyStreamProxyUrl(target, '');
    pushUnique({
      mode: 'proxy',
      url: configuredProxyUrl,
      label: streamProxyPrefix.trim() ? prefixLabel : 'Proxy Interno (/api/stream)',
    });
    if (configuredProxyUrl !== internalProxyUrl) {
      pushUnique({
        mode: 'proxy',
        url: internalProxyUrl,
        label: 'Proxy Interno (/api/stream)',
      });
    }
  };

  if (forceProxy) {
    if (effectiveResolved) {
      pushProxyAttempts(effectiveResolved, 'Proxy Configurado (URL Resolvida)');
    }
    pushProxyAttempts(rawUrl, 'Proxy Configurado');
    return list;
  }

  const primaryUrl = effectiveResolved || rawUrl;
  const primaryMode: PlaybackAttempt['mode'] = effectiveResolved
    ? 'resolved'
    : 'original';
  const primaryIsHttp = /^http:\/\//i.test(primaryUrl);
  const isAdaptiveStream =
    mediaType === 'hls' || mediaType === 'mpegts' || mediaType === 'dash';
  const isDirectVideoFile =
    mediaType === 'mp4' ||
    mediaType === 'm4v' ||
    mediaType === 'webm' ||
    mediaType === 'mkv' ||
    mediaType === 'mov' ||
    mediaType === 'audio';

  if (primaryIsHttp) {
    if (isHttpsPage) {
      if (autoProxyHttpStreams || isAdaptiveStream) {
        pushProxyAttempts(
          primaryUrl,
          effectiveResolved
            ? 'Proxy Automático (URL Resolvida)'
            : 'Proxy Automático (HTTP em HTTPS)'
        );
        if (isDirectVideoFile) {
          pushUnique({
            mode: primaryMode,
            url: primaryUrl.replace(/^http:\/\//i, 'https://'),
            label: 'Upgrade HTTPS Direto (Fallback)',
          });
        }
        pushUnique({
          mode: primaryMode,
          url: primaryUrl,
          label: 'Stream Direto Original (Fallback)',
        });
      } else {
        pushUnique({
          mode: primaryMode,
          url: primaryUrl,
          label: effectiveResolved ? 'URL Resolvida (HTTP)' : 'HTTP Direto',
        });
        pushProxyAttempts(primaryUrl, 'Fallback Proxy Interno');
      }
    } else if (isAdaptiveStream && autoProxyHttpStreams) {
      pushProxyAttempts(primaryUrl, 'Proxy Automático CORS');
      pushUnique({
        mode: primaryMode,
        url: primaryUrl,
        label: effectiveResolved ? 'URL Resolvida HTTP' : 'URL Original HTTP',
      });
    } else {
      pushUnique({
        mode: primaryMode,
        url: primaryUrl,
        label: effectiveResolved ? 'URL Resolvida HTTP' : 'Stream Direto HTTP',
      });
      pushProxyAttempts(primaryUrl, 'Fallback Proxy Interno');
    }
  } else {
    pushUnique({
      mode: primaryMode,
      url: primaryUrl,
      label: effectiveResolved ? 'URL Resolvida HTTPS' : 'Stream Direto HTTPS',
    });
    if (
      /^https:\/\//i.test(primaryUrl) &&
      (isAdaptiveStream || autoProxyHttpStreams)
    ) {
      pushProxyAttempts(primaryUrl, 'Fallback Proxy Interno');
    }
  }

  // Always retain fallback to original URL (proxied & direct) if we started from a resolved redirect
  if (effectiveResolved) {
    pushProxyAttempts(rawUrl, 'Fallback URL Original via Proxy');
    if (!isHttpsPage || /^https:\/\//i.test(rawUrl)) {
      pushUnique({
        mode: 'original',
        url: rawUrl,
        label: 'URL Original Direta (Fallback)',
      });
    }
  }

  return list;
}
