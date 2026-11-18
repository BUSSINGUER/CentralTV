import { DetectedMediaType } from './MediaTypeDetector';

export interface PlaybackAttempt {
  mode: 'original' | 'proxy';
  url: string;
  label: string;
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
  forceProxy: boolean
): PlaybackAttempt[] {
  if (!rawUrl) return [];
  if (rawUrl.startsWith('/api/stream')) {
    return [{ mode: 'proxy', url: rawUrl, label: 'Proxy Interno (/api/stream)' }];
  }

  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isHttp = /^http:\/\//i.test(rawUrl);
  const configuredProxyUrl = applyStreamProxyUrl(rawUrl, streamProxyPrefix);
  const internalProxyUrl = applyStreamProxyUrl(rawUrl, '');

  const pushProxyAttempts = (list: PlaybackAttempt[], prefixLabel: string) => {
    list.push({
      mode: 'proxy',
      url: configuredProxyUrl,
      label: streamProxyPrefix.trim() ? prefixLabel : 'Proxy Interno (/api/stream)',
    });
    if (configuredProxyUrl !== internalProxyUrl) {
      list.push({
        mode: 'proxy',
        url: internalProxyUrl,
        label: 'Proxy Interno (/api/stream)',
      });
    }
  };

  if (forceProxy) {
    const list: PlaybackAttempt[] = [];
    pushProxyAttempts(list, 'Proxy Configurado');
    return list;
  }

  if (isHttp) {
    const list: PlaybackAttempt[] = [];
    const isHlsOrTs = mediaType === 'hls' || mediaType === 'mpegts';

    if (isHttpsPage) {
      if (autoProxyHttpStreams || isHlsOrTs) {
        pushProxyAttempts(list, 'Proxy Automático (HTTP em HTTPS)');
        list.push({
          mode: 'original',
          url: rawUrl,
          label: 'Stream Direto Original (Fallback)',
        });
      } else {
        list.push({ mode: 'original', url: rawUrl, label: 'HTTP Direto' });
        pushProxyAttempts(list, 'Fallback Proxy Interno');
      }
      return list;
    }

    if (isHlsOrTs && autoProxyHttpStreams) {
      pushProxyAttempts(list, 'Proxy Automático CORS');
      list.push({ mode: 'original', url: rawUrl, label: 'URL Original HTTP' });
      return list;
    }

    list.push({ mode: 'original', url: rawUrl, label: 'Stream Direto HTTP' });
    pushProxyAttempts(list, 'Fallback Proxy Interno');
    return list;
  }

  const list: PlaybackAttempt[] = [
    { mode: 'original', url: rawUrl, label: 'Stream Direto HTTPS' },
  ];
  if (
    /^https:\/\//i.test(rawUrl) &&
    (mediaType === 'hls' || mediaType === 'dash' || mediaType === 'mpegts' || autoProxyHttpStreams)
  ) {
    pushProxyAttempts(list, 'Fallback Proxy Interno');
  }
  return list;
}
