import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import {
  assertSafePublicUrl,
  classifyTextPlaylistKind,
  createServer,
  redactUrlCredentialsServer,
  rewriteHlsManifest,
  sniffStreamBytes,
} from '../server';
import {
  detectMediaTypeFromUrl,
  isLikelyDynamicVodUrl,
  mapBackendFormatToMediaType,
} from '../src/components/player/MediaTypeDetector';
import { buildPlaybackAttempts } from '../src/components/player/MediaSourceResolver';
import {
  probeSingleSource,
  runHealthCheckForItem,
} from '../src/services/pipeline';
import { redactUrlCredentials } from '../src/services/streamOrigins';
import { CatalogItem } from '../src/types/streaming';

let server: http.Server;
let baseUrl = '';

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

test('SSRF protection blocks loopback, private, link-local, metadata, and file URLs', async () => {
  const blockedUrls = [
    'http://127.0.0.1:8080/video.mp4',
    'http://localhost:3000/secret',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal.m3u8',
    'http://192.168.1.10/stream.ts',
    'http://[::1]/stream.mp4',
    'http://metadata.google.internal/computeMetadata/v1/',
    'file:///etc/passwd',
  ];

  for (const url of blockedUrls) {
    await assert.rejects(() => assertSafePublicUrl(url));
  }

  const okParsed = await assertSafePublicUrl(
    'https://media.w3.org/2010/05/sintel/trailer.mp4'
  );
  assert.equal(okParsed.hostname, 'media.w3.org');
});

test('Stream byte sniffing detects HTML traps, M3U playlists, HLS, MP4, MKV, MPEG-TS, and DASH', () => {
  const htmlBytes = Buffer.from('<!DOCTYPE html><html><body>Wait...</body></html>');
  assert.equal(sniffStreamBytes(htmlBytes).isHtml, true);

  const m3uList = Buffer.from(
    '#EXTM3U\n#EXTINF:-1 tvg-id="globo" group-title="TV",Globo HD\nhttp://cdn.example.com/globo.ts\n'
  );
  assert.equal(classifyTextPlaylistKind(m3uList.toString('utf8')), 'm3u_list');
  assert.equal(sniffStreamBytes(m3uList).isM3uList, true);

  const hlsPlaylist = Buffer.from(
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n'
  );
  assert.equal(classifyTextPlaylistKind(hlsPlaylist.toString('utf8')), 'hls');
  assert.equal(sniffStreamBytes(hlsPlaylist).mediaType, 'hls');
  assert.equal(sniffStreamBytes(hlsPlaylist).engine, 'hls');

  const mp4Header = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  assert.equal(sniffStreamBytes(mp4Header).mediaType, 'mp4');
  assert.equal(sniffStreamBytes(mp4Header).engine, 'native');

  const mkvHeader = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42]);
  assert.equal(sniffStreamBytes(mkvHeader).mediaType, 'mkv');

  const tsPacket = Uint8Array.from([0x47, 0x40, 0x00, 0x10]);
  assert.equal(sniffStreamBytes(tsPacket).mediaType, 'mpegts');
  assert.equal(sniffStreamBytes(tsPacket).engine, 'mpegts');

  const dashManifest = Buffer.from('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>');
  assert.equal(sniffStreamBytes(dashManifest).mediaType, 'dash');
  assert.equal(sniffStreamBytes(dashManifest).engine, 'shaka');
});

test('rewriteHlsManifest rewrites relative segments, sub-manifests, and EXT-X-KEY URIs safely', () => {
  const raw = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
    '#EXTINF:6.0,',
    'segments/seg_001.ts?token=secret123',
    '#EXTINF:6.0,',
    'https://cdn2.example.org/segments/seg_002.ts',
  ].join('\n');

  const rewritten = rewriteHlsManifest(
    raw,
    'https://cdn1.example.org/hls/master.m3u8'
  );

  assert.match(
    rewritten,
    /URI="\/api\/stream\?url=https%3A%2F%2Fcdn1\.example\.org%2Fhls%2Fkeys%2Fenc\.key"/
  );
  assert.match(
    rewritten,
    /\/api\/stream\?url=https%3A%2F%2Fcdn1\.example\.org%2Fhls%2Fsegments%2Fseg_001\.ts%3Ftoken%3Dsecret123/
  );
  assert.match(
    rewritten,
    /\/api\/stream\?url=https%3A%2F%2Fcdn2\.example\.org%2Fsegments%2Fseg_002\.ts/
  );
});

test('Credential redaction hides user:pass, query tokens, and Xtream path credentials', () => {
  const url = 'http://user123:pass456@iptv.example.com:8080/movie/alice/secret99/4421.mp4?token=abc&sig=xyz';
  const clientRedacted = redactUrlCredentials(url);
  const serverRedacted = redactUrlCredentialsServer(url);

  for (const out of [clientRedacted, serverRedacted]) {
    assert.equal(out.includes('user123'), false);
    assert.equal(out.includes('pass456'), false);
    assert.equal(out.includes('alice'), false);
    assert.equal(out.includes('secret99'), false);
    assert.equal(out.includes('abc'), false);
    assert.equal(out.includes('xyz'), false);
  }
});

test('MediaTypeDetector and MediaSourceResolver preserve original URL and build deduplicated attempts', () => {
  assert.equal(
    detectMediaTypeFromUrl('https://cdn.example.com/movie.mp4?auth=1', false),
    'mp4'
  );
  assert.equal(
    mapBackendFormatToMediaType('hls', 'application/vnd.apple.mpegurl', false),
    'hls'
  );
  assert.equal(
    isLikelyDynamicVodUrl('https://cdn.example.com/play?id=123&token=xyz'),
    true
  );
  assert.equal(
    isLikelyDynamicVodUrl('https://media.w3.org/2010/05/sintel/trailer.mp4'),
    false
  );

  const original = 'http://origin.example.com/vod/redirect?id=5';
  const resolved = 'https://cdn-edge.example.net/files/movie.mp4?expires=999';
  const attempts = buildPlaybackAttempts(
    original,
    'mp4',
    '',
    true,
    false,
    resolved
  );

  assert.ok(attempts.length >= 2);
  assert.equal(attempts[0].mode, 'resolved');
  assert.equal(attempts[0].url, resolved);
  assert.ok(attempts.some((a) => a.url.includes('/api/stream?url=') && a.url.includes(encodeURIComponent(original))));
  // Verify no duplicate attempt URLs
  const uniqueUrls = new Set(attempts.map((a) => a.url));
  assert.equal(uniqueUrls.size, attempts.length);
});

test('Express proxy blocks SSRF and unauthorized cross-site requests with HTTP 403', async () => {
  const ssrfResp = await fetch(
    `${baseUrl}/api/stream?url=${encodeURIComponent('http://127.0.0.1:8080/test.mp4')}`,
    { headers: { Origin: baseUrl } }
  );
  assert.equal(ssrfResp.status, 403);
  assert.equal(ssrfResp.headers.get('x-aura-error-code'), 'ssrf_blocked');

  const unauthResp = await fetch(
    `${baseUrl}/api/stream?url=${encodeURIComponent('https://example.org/unlisted.mp4')}`,
    { headers: { Origin: 'https://evil-attacker.example' } }
  );
  assert.equal(unauthResp.status, 403);
  assert.equal(unauthResp.headers.get('x-aura-error-code'), 'origin_not_allowed');
});

test('Live public MP4, HLS, DASH, and HTML challenge detection via /api/resolve-vod and /api/stream', async () => {
  const mp4Url = 'https://media.w3.org/2010/05/sintel/trailer.mp4';
  const resolveMp4 = await fetch(
    `${baseUrl}/api/resolve-vod?url=${encodeURIComponent(mp4Url)}`,
    { headers: { Origin: baseUrl } }
  );
  assert.equal(resolveMp4.status, 200);
  const mp4Data = (await resolveMp4.json()) as {
    ok: boolean;
    validationState: string;
    mediaType: string;
    detectedEngine: string;
  };
  assert.equal(mp4Data.ok, true);
  assert.equal(mp4Data.validationState, 'media_available');
  assert.equal(mp4Data.mediaType, 'mp4');
  assert.equal(mp4Data.detectedEngine, 'native');

  // Stream proxy supports Range / 206 and streams binary MP4 bytes
  const streamMp4 = await fetch(
    `${baseUrl}/api/stream?url=${encodeURIComponent(mp4Url)}`,
    {
      headers: {
        Origin: baseUrl,
        Range: 'bytes=0-255',
      },
    }
  );
  assert.equal(streamMp4.status, 206);
  assert.ok(streamMp4.headers.get('content-range')?.startsWith('bytes 0-255/'));
  assert.match(streamMp4.headers.get('content-type') || '', /video\/mp4/i);
  const mp4Bytes = new Uint8Array(await streamMp4.arrayBuffer());
  assert.equal(mp4Bytes.byteLength, 256);
  assert.equal(sniffStreamBytes(mp4Bytes).mediaType, 'mp4');

  // HLS resolution & manifest rewrite via /api/stream
  const hlsUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  const resolveHls = await fetch(
    `${baseUrl}/api/resolve-vod?url=${encodeURIComponent(hlsUrl)}`,
    { headers: { Origin: baseUrl } }
  );
  const hlsData = (await resolveHls.json()) as {
    ok: boolean;
    validationState: string;
    mediaType: string;
    detectedEngine: string;
  };
  assert.equal(hlsData.ok, true);
  assert.equal(hlsData.validationState, 'media_available');
  assert.equal(hlsData.mediaType, 'hls');
  assert.equal(hlsData.detectedEngine, 'hls');

  const streamHls = await fetch(
    `${baseUrl}/api/stream?url=${encodeURIComponent(hlsUrl)}`,
    { headers: { Origin: baseUrl } }
  );
  assert.equal(streamHls.status, 200);
  const hlsText = await streamHls.text();
  assert.match(hlsText, /^#EXTM3U/);
  assert.match(hlsText, /\/api\/stream\?url=https%3A%2F%2Ftest-streams\.mux\.dev/);

  // DASH resolution
  const dashUrl = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
  const resolveDash = await fetch(
    `${baseUrl}/api/resolve-vod?url=${encodeURIComponent(dashUrl)}`,
    { headers: { Origin: baseUrl } }
  );
  const dashData = (await resolveDash.json()) as {
    ok: boolean;
    validationState: string;
    mediaType: string;
    detectedEngine: string;
  };
  assert.equal(dashData.ok, true);
  assert.equal(dashData.validationState, 'media_available');
  assert.equal(dashData.mediaType, 'dash');
  assert.equal(dashData.detectedEngine, 'shaka');

  // HTML page must NEVER pass through /api/stream as video, and /api/resolve-vod marks html_challenge
  const htmlUrl = 'https://example.com/';
  const resolveHtml = await fetch(
    `${baseUrl}/api/resolve-vod?url=${encodeURIComponent(htmlUrl)}`,
    { headers: { Origin: baseUrl } }
  );
  const htmlData = (await resolveHtml.json()) as {
    validationState: string;
    isHtml?: boolean;
  };
  assert.equal(htmlData.validationState, 'html_challenge');
  assert.equal(htmlData.isHtml, true);

  const streamHtml = await fetch(
    `${baseUrl}/api/stream?url=${encodeURIComponent(htmlUrl)}`,
    { headers: { Origin: baseUrl } }
  );
  assert.equal(streamHtml.status, 502);
  assert.equal(streamHtml.headers.get('x-aura-error-code'), 'upstream_html');
});

test('Pipeline health check preserves original URL and never marks CORS/Proxy/HTML blocks as offline', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('proxy-blocked')) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
      }
      if (urlStr.includes('cors-blocked')) {
        return new Response(
          JSON.stringify({
            ok: false,
            validationState: 'cors_blocked',
            status: 0,
            reason: 'CORS block',
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes('html-challenge')) {
        return new Response(
          JSON.stringify({
            ok: true,
            validationState: 'html_challenge',
            status: 200,
            reason: 'HTML protection',
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          validationState: 'offline',
          status: 404,
          reason: 'HTTP 404',
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const proxyBlocked = await probeSingleSource(
      { id: '1', label: 'P', url: 'https://cdn.example/proxy-blocked.mp4', status: 'pending' },
      3000
    );
    assert.equal(proxyBlocked.validationState, 'proxy_blocked');
    assert.notEqual(proxyBlocked.status, 'offline');

    const corsBlocked = await probeSingleSource(
      { id: '2', label: 'C', url: 'https://cdn.example/cors-blocked.mp4', status: 'pending' },
      3000
    );
    assert.equal(corsBlocked.validationState, 'cors_blocked');
    assert.notEqual(corsBlocked.status, 'offline');

    const baseItem: CatalogItem = {
      id: 'item-cors',
      title: 'Item CORS Test',
      type: 'movie',
      year: 2024,
      genres: [],
      ageRating: 'L',
      duration: '1h',
      durationSeconds: 3600,
      platform: 'netflix',
      synopsis: '',
      cast: [],
      director: '',
      youtubeTrailerId: '',
      posterImage: '',
      backdropImage: '',
      categories: [],
      sources: [
        { id: 's1', label: 'CORS', url: 'https://cdn.example/cors-blocked.mp4', status: 'pending' },
      ],
    };

    const checkedCorsItem = await runHealthCheckForItem(baseItem, 3000);
    assert.equal(checkedCorsItem.status, 'pendente');

    const realOfflineItem = await runHealthCheckForItem(
      {
        ...baseItem,
        id: 'item-off',
        sources: [
          { id: 's2', label: 'Dead', url: 'https://cdn.example/not-found.mp4', status: 'pending' },
        ],
      },
      3000
    );
    assert.equal(realOfflineItem.status, 'offline');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
