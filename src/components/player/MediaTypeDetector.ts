export type DetectedMediaType =
  | 'mp4'
  | 'm4v'
  | 'webm'
  | 'mkv'
  | 'avi'
  | 'mov'
  | 'hls'
  | 'mpegts'
  | 'dash'
  | 'audio'
  | 'm3u_playlist'
  | 'unknown';

export type HybridEngineKind =
  | 'native-html5'
  | 'native-hls'
  | 'hls.js'
  | 'shaka'
  | 'mpegts.js'
  | 'none';

export function unwrapTargetUrl(streamUrl: string): string {
  try {
    if (streamUrl.startsWith('/api/stream')) {
      const qs = streamUrl.split('?')[1] || '';
      const inner = new URLSearchParams(qs).get('url');
      if (inner) return inner;
    }
  } catch {
    // Ignore
  }
  return streamUrl;
}

export function getCleanPath(streamUrl: string): string {
  const effective = unwrapTargetUrl(streamUrl);
  try {
    return new URL(effective).pathname.toLowerCase();
  } catch {
    return effective.split('?')[0].split('#')[0].toLowerCase();
  }
}

export function detectMediaTypeFromUrl(
  streamUrl: string,
  isLive: boolean
): DetectedMediaType {
  const cleanPath = getCleanPath(streamUrl);
  const lower = unwrapTargetUrl(streamUrl).toLowerCase();

  if (cleanPath.endsWith('.mp4') || cleanPath.endsWith('.m4v')) return 'mp4';
  if (cleanPath.endsWith('.webm')) return 'webm';
  if (cleanPath.endsWith('.mkv')) return 'mkv';
  if (cleanPath.endsWith('.avi')) return 'avi';
  if (cleanPath.endsWith('.mov')) return 'mov';
  if (cleanPath.endsWith('.mpd') || lower.includes('.mpd?')) return 'dash';
  if (cleanPath.endsWith('.m3u8') || lower.includes('.m3u8?')) return 'hls';
  if (cleanPath.endsWith('.ts') || lower.includes('output=ts')) return 'mpegts';
  if (
    cleanPath.endsWith('.mp3') ||
    cleanPath.endsWith('.aac') ||
    cleanPath.endsWith('.ogg') ||
    cleanPath.endsWith('.flac')
  ) {
    return 'audio';
  }
  if (isLive) return 'mpegts';
  return 'unknown';
}

export function evaluateNativeCodecSupport(
  video: HTMLVideoElement,
  mediaType: DetectedMediaType
): { canAttemptNative: boolean; note: string } {
  if (mediaType === 'mp4' || mediaType === 'm4v') {
    const test = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
    return {
      canAttemptNative: Boolean(test),
      note: `video/mp4: ${test || 'maybe'}`,
    };
  }
  if (mediaType === 'webm') {
    const test = video.canPlayType('video/webm; codecs="vp9, opus"');
    return {
      canAttemptNative: Boolean(test),
      note: `video/webm: ${test || 'maybe'}`,
    };
  }
  if (mediaType === 'audio') {
    return {
      canAttemptNative: true,
      note: `audio/mpeg: ${video.canPlayType('audio/mpeg') || 'maybe'}`,
    };
  }
  if (mediaType === 'hls') {
    const apple =
      video.canPlayType('application/vnd.apple.mpegurl') ||
      video.canPlayType('application/x-mpegURL');
    return {
      canAttemptNative: Boolean(apple),
      note: apple ? `HLS nativo: ${apple}` : 'HLS nativo indisponível; usando HLS.js',
    };
  }
  return {
    canAttemptNative: true,
    note: 'Detecção automática pelo fluxo de mídia',
  };
}

export function classifyM3uContent(text: string): 'hls' | 'm3u_playlist' | 'unknown' {
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
    return 'm3u_playlist';
  }
  if (hasHlsDirective) {
    return 'hls';
  }
  return 'unknown';
}
