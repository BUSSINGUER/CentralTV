import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import Hls from 'hls.js';
import { directFragmentUrl } from '../src/components/player/directHlsFragments';
import {
  createServer,
  rewriteHlsManifest,
  sanitizeAuthorizedOriginHeaders,
  sniffStreamBytes,
} from '../server';
import {
  classifyM3uContent,
  fixNestedProxyPath,
  isHtmlResponseText,
} from '../src/components/player/MediaTypeDetector';
import {
  applyStreamProxyUrl,
  buildPlaybackAttempts,
} from '../src/components/player/MediaSourceResolver';
import {
  LIVE_FIRST_FRAME_TIMEOUT_MS,
  LIVE_FROZEN_TIMEOUT_MS,
  LIVE_WATCHDOG_INTERVAL_MS,
  LIVE_LATENCY_PROFILES,
  applyLiveLatencyProfileToHls,
  buildLiveHlsConfig,
  getSavedLiveLatencyProfile,
  isFatalPlaylistHlsError,
  saveLiveLatencyProfile,
} from '../src/components/player/liveHlsConfig';

let server: http.Server;
let baseUrl = '';

test('Only eligible HTTPS fragments can leave the same-origin media proxy', () => {
  const page = 'https://tv.example/';
  const request = (url: string) => '/api/stream?url=' + encodeURIComponent(url);
  assert.equal(directFragmentUrl(request('https://media.example/demo.ts'), page)?.pathname, '/demo.ts');
  assert.equal(directFragmentUrl(request('http://media.example/demo.ts'), page), undefined);
  assert.equal(directFragmentUrl(request('https://media.example/demo.ts') + '&ua=custom', page), undefined);
  assert.equal(directFragmentUrl('https://other.example' + request('https://media.example/demo.ts'), page), undefined);
});

test('List proxy forwards a decoded upstream body without its compressed length', async () => {
  const upstream = 'https://example.com/catalogo.txt';
  const body = 'canal: Teste\nfonte: https://example.com/stream.m3u8\n';
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (input, init) => String(input) === upstream
      ? Promise.resolve(new Response(body, {
          headers: { 'content-type': 'text/plain', 'content-length': '16', 'content-encoding': 'gzip' },
        }))
      : realFetch(input, init);
    const response = await realFetch(baseUrl + '/api/fetch-list?url=' + encodeURIComponent(upstream));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), body);
  } finally {
    globalThis.fetch = realFetch;
  }
});

before(async () => {
  const app = await createServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

test('HTML & non-HLS manifest detection rejects HTTP 200 traps cleanly', () => {
  assert.equal(isHtmlResponseText('<!doctype html><html><body>Wait</body></html>'), true);
  assert.equal(isHtmlResponseText('  \uFEFF<html><head><title>WAF</title></head>'), true);
  assert.equal(isHtmlResponseText('#EXTM3U\n#EXT-X-VERSION:3\n'), false);

  assert.equal(classifyM3uContent('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts'), 'hls');
  assert.equal(classifyM3uContent('#EXTM3U\n#EXTINF:-1 tvg-name="Ch1",Channel 1\nhttp://a/1.ts'), 'm3u_playlist');
  assert.equal(classifyM3uContent('{"error":"token expired"}'), 'unknown');
  assert.equal(classifyM3uContent('#EXTM3U\n'), 'unknown');
});

test('Proxy rejects HTTP 200 HTML, JSON garbage, and bare #EXTM3U on .m3u8 URLs with exact error headers', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      if (urlStr === 'https://example.com/live/html200.m3u8') {
        return new Response('<!DOCTYPE html><html><body>Challenge</body></html>', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        });
      }
      if (urlStr === 'https://example.com/live/json200.m3u8') {
        return new Response('{"code":403,"msg":"invalid session"}', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        });
      }
      if (urlStr === 'https://example.com/live/empty-extm3u.m3u8') {
        return new Response('#EXTM3U\n# only comment\n', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const htmlStreamResp = await realFetch(
      `${baseUrl}/api/stream?url=${encodeURIComponent('https://example.com/live/html200.m3u8')}`,
      { headers: { Origin: baseUrl } }
    );
    assert.equal(htmlStreamResp.status, 502);
    assert.equal(htmlStreamResp.headers.get('x-aura-error-code'), 'upstream_html');
    assert.equal(htmlStreamResp.headers.get('x-aura-upstream-status'), '200');

    const jsonStreamResp = await realFetch(
      `${baseUrl}/api/stream?url=${encodeURIComponent('https://example.com/live/json200.m3u8')}`,
      { headers: { Origin: baseUrl } }
    );
    assert.equal(jsonStreamResp.status, 422);
    assert.equal(jsonStreamResp.headers.get('x-aura-error-code'), 'invalid_hls_manifest');
    assert.equal(jsonStreamResp.headers.get('x-aura-upstream-status'), '200');

    const bareExtm3uResp = await realFetch(
      `${baseUrl}/api/stream?url=${encodeURIComponent('https://example.com/live/empty-extm3u.m3u8')}`,
      { headers: { Origin: baseUrl } }
    );
    assert.equal(bareExtm3uResp.status, 422);
    assert.equal(bareExtm3uResp.headers.get('x-aura-error-code'), 'invalid_hls_manifest');

    const resolveJsonResp = await realFetch(
      `${baseUrl}/api/resolve-vod?url=${encodeURIComponent('https://example.com/live/json200.m3u8')}&forceRefresh=1`,
      { headers: { Origin: baseUrl } }
    );
    const resolvedJson = (await resolveJsonResp.json()) as {
      ok: boolean;
      validationState: string;
    };
    assert.equal(resolvedJson.ok, false);
    assert.equal(resolvedJson.validationState, 'offline');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fixNestedProxyPath repairs relative URLs resolved against external ?url= proxy manifests', () => {
  const manifestUrl =
    'https://proxy.example.net/fetch?url=https%3A%2F%2Forigin.example.org%2Flive%2Fch1%2Fmaster.m3u8';
  const brokenHlsJsUrl = 'https://proxy.example.net/seg_001.ts?token=abc';
  const fixed = fixNestedProxyPath(manifestUrl, brokenHlsJsUrl);
  assert.equal(fixed, 'https://proxy.example.net/live/ch1/seg_001.ts?token=abc');

  // Internal /api/stream URLs remain untouched because server rewrites lines directly
  const internalFixed = fixNestedProxyPath(
    'https://app.local/api/stream?url=https%3A%2F%2Forigin.example.org%2Fmaster.m3u8',
    'https://app.local/seg.ts'
  );
  assert.equal(internalFixed, 'https://app.local/seg.ts');
});

test('Authorized origin headers are sanitized, forwarded by /api/stream, and propagated across child playlists/keys/segments', async () => {
  // Sanitizer rejects CRLF injection and localhost/private referers
  const sanitizedEvil = sanitizeAuthorizedOriginHeaders({
    referer: 'http://127.0.0.1:3000/admin',
    origin: 'https://player.example.com\r\nX-Injected: evil',
    userAgent: 'CustomPlayer/1.0\nEvil: 1',
  });
  assert.equal(sanitizedEvil.referer, undefined);
  assert.equal(sanitizedEvil.origin, undefined);
  assert.equal(sanitizedEvil.userAgent, undefined);

  const validHeaders = {
    referer: 'https://partner.example.com/live',
    userAgent: 'PartnerApp/2.1',
    origin: 'https://partner.example.com',
  };

  // rewriteHlsManifest propagates authorized headers onto single/double quoted URIs & relative segments
  const manifest = [
    '#EXTM3U',
    "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"PT\",URI='audio/pt.m3u8'",
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/live.key"',
    '#EXT-X-MAP:URI="init/segment.mp4"',
    '#EXTINF:4.0,',
    'chunks/seg_100.ts',
  ].join('\n');

  const rewritten = rewriteHlsManifest(
    manifest,
    'https://cdn.example.org/hls/channel/index.m3u8',
    validHeaders
  );

  assert.match(rewritten, /audio%2Fpt\.m3u8/);
  assert.match(rewritten, /keys%2Flive\.key/);
  assert.match(rewritten, /init%2Fsegment\.mp4/);
  assert.match(rewritten, /chunks%2Fseg_100\.ts/);
  assert.match(
    rewritten,
    /referer=https%3A%2F%2Fpartner\.example\.com%2Flive/
  );
  assert.match(rewritten, /ua=PartnerApp%2F2\.1/);
  assert.match(rewritten, /origin=https%3A%2F%2Fpartner\.example\.com/);

  // Client attempt builder prioritizes proxy with forwarded headers when headers are present
  const attempts = buildPlaybackAttempts(
    'https://cdn.example.org/hls/master.m3u8',
    'hls',
    '',
    true,
    false,
    undefined,
    validHeaders
  );
  assert.ok(attempts[0].mode === 'proxy');
  assert.match(attempts[0].url, /referer=https%3A%2F%2Fpartner\.example\.com%2Flive/);
  assert.match(attempts[0].url, /ua=PartnerApp%2F2\.1/);

  // End-to-end header forwarding verification through /api/stream
  const realFetch = globalThis.fetch;
  let capturedUpstreamHeaders: Record<string, string> = {};
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      if (urlStr === 'https://example.com/auth/master.m3u8') {
        const hdrs = (init?.headers || {}) as Record<string, string>;
        capturedUpstreamHeaders = { ...hdrs };
        return new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nsub/playlist.m3u8\n',
          {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const proxiedMasterUrl = applyStreamProxyUrl(
      'https://example.com/auth/master.m3u8',
      '',
      validHeaders
    );
    const resp = await realFetch(`${baseUrl}${proxiedMasterUrl}`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(resp.status, 200);
    assert.equal(capturedUpstreamHeaders['Referer'], validHeaders.referer);
    assert.equal(capturedUpstreamHeaders['User-Agent'], validHeaders.userAgent);
    assert.equal(capturedUpstreamHeaders['Origin'], validHeaders.origin);

    const body = await resp.text();
    assert.match(
      body,
      /\/api\/stream\?url=https%3A%2F%2Fexample\.com%2Fauth%2Fsub%2Fplaylist\.m3u8&referer=https%3A%2F%2Fpartner\.example\.com%2Flive&ua=PartnerApp%2F2\.1&origin=https%3A%2F%2Fpartner\.example\.com/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Fatal playlist errors are strictly separated from transient fragment errors, and live watchdog timings match spec', () => {
  assert.equal(LIVE_FIRST_FRAME_TIMEOUT_MS, 12_000);
  assert.equal(LIVE_FROZEN_TIMEOUT_MS, 25_000);
  assert.equal(LIVE_WATCHDOG_INTERVAL_MS, 2_000);

  // Fatal playlist errors must advance/fail immediately rather than calling startLoad()
  for (const detail of [
    Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
    Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
    Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
    Hls.ErrorDetails.LEVEL_LOAD_ERROR,
    Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT,
    Hls.ErrorDetails.LEVEL_EMPTY_ERROR,
  ]) {
    assert.equal(isFatalPlaylistHlsError(detail), true, `${detail} should be fatal playlist error`);
  }

  // Transient fragment/key errors remain eligible for stream recovery
  for (const detail of [
    Hls.ErrorDetails.FRAG_LOAD_ERROR,
    Hls.ErrorDetails.FRAG_LOAD_TIMEOUT,
    Hls.ErrorDetails.KEY_LOAD_ERROR,
  ]) {
    assert.equal(isFatalPlaylistHlsError(detail), false, `${detail} should allow transient recovery`);
  }
});

test('All three live HLS latency profiles adapt to segment targetduration, persist cleanly, and switch mid-stream without reinit', () => {
  assert.deepEqual(
    LIVE_LATENCY_PROFILES.map((p) => p.id),
    ['realtime', 'balanced', 'stable']
  );

  // Mock localStorage in Node environment to test save/load persistence
  const store = new Map<string, string>();
  const origWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
  };

  try {
    assert.equal(getSavedLiveLatencyProfile(), 'balanced');
    saveLiveLatencyProfile('realtime');
    assert.equal(getSavedLiveLatencyProfile(), 'realtime');
    saveLiveLatencyProfile('stable');
    assert.equal(getSavedLiveLatencyProfile(), 'stable');
    saveLiveLatencyProfile('balanced');
    assert.equal(getSavedLiveLatencyProfile(), 'balanced');
  } finally {
    (globalThis as { window?: unknown }).window = origWindow;
  }

  // Validate relative scaling across targetdurations (2s short segments vs 8s long segments)
  const rtShort = buildLiveHlsConfig('realtime', 2);
  const balShort = buildLiveHlsConfig('balanced', 2);
  const stabShort = buildLiveHlsConfig('stable', 2);

  assert.ok((rtShort.liveSyncDurationCount ?? 0) >= 1 && (rtShort.liveSyncDurationCount ?? 0) <= 2);
  assert.equal(balShort.liveSyncDurationCount, 3);
  assert.equal(balShort.maxLiveSyncPlaybackRate, 1.03);
  assert.ok((stabShort.liveSyncDurationCount ?? 0) >= 5 && (stabShort.liveSyncDurationCount ?? 0) <= 6);
  assert.ok((rtShort.maxBufferLength ?? 0) < (balShort.maxBufferLength ?? 0));
  assert.ok((balShort.maxBufferLength ?? 0) < (stabShort.maxBufferLength ?? 0));

  const balLong = buildLiveHlsConfig('balanced', 8);
  assert.ok((balLong.maxBufferLength ?? 0) > (balShort.maxBufferLength ?? 0));
  assert.equal(balLong.lowLatencyMode, false);

  // Mid-stream switching applies settings in-place and returns false (no teardown/reinit)
  const mockHls = {
    config: { ...buildLiveHlsConfig('balanced', 6) } as Hls['config'],
  };
  assert.equal(applyLiveLatencyProfileToHls(mockHls, 'realtime', 6), false);
  assert.equal(mockHls.config.liveSyncDurationCount, 1.5);
  assert.equal(applyLiveLatencyProfileToHls(mockHls, 'stable', 6), false);
  assert.equal(mockHls.config.liveSyncDurationCount, 5.5);
  assert.equal(applyLiveLatencyProfileToHls(mockHls, 'balanced', 6), false);
  assert.equal(mockHls.config.liveSyncDurationCount, 3.0);
  assert.equal(mockHls.config.maxLiveSyncPlaybackRate, 1.03);
});

test('Real public HLS playback chain: master playlist -> child variant playlist -> binary MPEG-TS segment via /api/stream', async () => {
  const masterUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  const masterResp = await fetch(
    `${baseUrl}/api/stream?url=${encodeURIComponent(masterUrl)}`,
    { headers: { Origin: baseUrl } }
  );
  assert.equal(masterResp.status, 200);
  const masterText = await masterResp.text();
  assert.match(masterText, /^#EXTM3U/);

  const variantMatch = masterText.match(/^(\/api\/stream\?url=[^\s]+)$/m);
  assert.ok(variantMatch, 'Master playlist should rewrite child variant playlist to /api/stream');

  const childResp = await fetch(`${baseUrl}${variantMatch[1]}`, {
    headers: { Origin: baseUrl },
  });
  assert.equal(childResp.status, 200);
  const childText = await childResp.text();
  assert.match(childText, /#EXT-X-TARGETDURATION:/);
  assert.equal(classifyM3uContent(childText), 'hls');

  const segMatch = childText.match(/^(\/api\/stream\?url=[^\s]+)$/m);
  assert.ok(segMatch, 'Child playlist should rewrite segment URI to /api/stream');

  const segResp = await fetch(`${baseUrl}${segMatch[1]}`, {
    headers: { Origin: baseUrl, Range: 'bytes=0-187' },
  });
  assert.ok(segResp.status === 200 || segResp.status === 206);
  const segBytes = new Uint8Array(await segResp.arrayBuffer());
  assert.ok(segBytes.byteLength >= 4);
  assert.equal(sniffStreamBytes(segBytes).mediaType, 'mpegts');
});
