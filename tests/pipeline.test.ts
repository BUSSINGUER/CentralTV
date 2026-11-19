import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { createServer } from '../server.ts';
import { db } from '../src/db/database';
import {
  processItemFullPipeline,
  runHealthCheckForItem,
  runTmdbEnrichmentForItem,
} from '../src/services/pipeline';
import type { AppSettings, CatalogItem } from '../src/types/streaming';

const TEST_SETTINGS: AppSettings = {
  key: 'config',
  tmdbApiKey: 'test-tmdb-key',
  youtubeApiKey: 'test-yt-key',
  epgUrl: '',
  streamProxyPrefix: '',
  autoProxyHttpStreams: true,
  batchSize: 4,
  probeTimeoutMs: 3000,
  isLoggedIn: false,
  userName: 'Admin',
  userEmail: 'admin@example.com',
};

function makeBaseItem(
  overrides: Partial<CatalogItem> & { id: string; title: string }
): CatalogItem {
  const now = Date.now();
  return {
    type: 'movie',
    mediaKind: 'movie',
    year: 2024,
    genres: [],
    ageRating: '14',
    duration: '1h 40min',
    durationSeconds: 6000,
    platform: 'netflix',
    synopsis: '',
    cast: [],
    director: '',
    youtubeTrailerId: '',
    posterImage: '',
    backdropImage: '',
    categories: ['populares'],
    sources: [],
    status: 'pendente',
    healthChecked: false,
    tmdbEnriched: false,
    youtubeEnriched: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('Series with episode sources skips episode probing and enriches TMDB + YouTube directly', async () => {
  const originalFetch = globalThis.fetch;
  const originalPut = db.mediaItems.put.bind(db.mediaItems);
  const savedItems: CatalogItem[] = [];
  const calledUrls: string[] = [];

  (db.mediaItems as unknown as { put: (item: CatalogItem) => Promise<string> }).put = async (
    item: CatalogItem
  ) => {
    savedItems.push(item);
    return item.id;
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    calledUrls.push(urlStr);
    if (urlStr.includes('/api/tmdb/enrich')) {
      return new Response(
        JSON.stringify({
          found: true,
          tmdbId: 94997,
          title: 'A Casa do Dragão',
          year: 2022,
          synopsis: 'Série épica Targaryen.',
          voteAverage: 8.4,
          genres: ['Drama', 'Fantasia'],
          platform: 'hbo',
          posterImage: 'https://image.tmdb.org/t/p/w780/hotd.jpg',
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes('/api/youtube/search')) {
      return new Response(
        JSON.stringify({ videoId: 'DotnJ7tTA34', source: 'youtube-api' }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch URL for series test: ${urlStr}`);
  }) as typeof fetch;

  try {
    const seriesItem = makeBaseItem({
      id: 'series-hotd',
      title: 'House of the Dragon',
      type: 'series',
      mediaKind: 'series',
      sources: [],
      episodes: [
        {
          id: 's1e1',
          season: 1,
          episode: 1,
          title: 'Episódio 1',
          duration: '60min',
          synopsis: '',
          sources: [
            {
              id: 'ep-src-1',
              label: 'Principal',
              url: 'https://cdn.example.com/hotd-s01e01.mp4',
              status: 'pending',
            },
          ],
        },
      ],
    });

    const healthOnly = await runHealthCheckForItem(seriesItem, 3000);
    assert.equal(healthOnly.status, 'aprovado');
    assert.equal(healthOnly.healthChecked, true);

    const processed = await processItemFullPipeline(seriesItem, TEST_SETTINGS);
    assert.equal(processed.status, 'aprovado');
    assert.equal(processed.tmdbEnriched, true);
    assert.equal(processed.tmdbId, 94997);
    assert.equal(processed.platform, 'hbo');
    assert.equal(processed.youtubeTrailerId, 'DotnJ7tTA34');
    assert.equal(calledUrls.some((u) => u.includes('/api/check-stream')), false);
    assert.equal(savedItems.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    (db.mediaItems as unknown as { put: typeof originalPut }).put = originalPut;
  }
});

test('CORS/Proxy blocked pendente item keeps status pendente and still enriches TMDB + YouTube', async () => {
  const originalFetch = globalThis.fetch;
  const originalPut = db.mediaItems.put.bind(db.mediaItems);
  const savedItems: CatalogItem[] = [];

  (db.mediaItems as unknown as { put: (item: CatalogItem) => Promise<string> }).put = async (
    item: CatalogItem
  ) => {
    savedItems.push(item);
    return item.id;
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    if (urlStr.includes('/api/check-stream')) {
      return new Response(
        JSON.stringify({
          ok: false,
          validationState: 'cors_blocked',
          status: 0,
          reason: 'CORS block on origin',
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes('/api/tmdb/enrich')) {
      return new Response(
        JSON.stringify({
          found: true,
          tmdbId: 693134,
          title: 'Duna: Parte Dois',
          year: 2024,
          synopsis: 'Paul Atreides se une a Chani.',
          voteAverage: 8.3,
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes('/api/youtube/search')) {
      return new Response(JSON.stringify({ videoId: 'U2Qp5pL3ovA' }), {
        status: 200,
      });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const corsMovie = makeBaseItem({
      id: 'movie-cors-enrich',
      title: 'Duna Parte 2',
      sources: [
        {
          id: 'src-cors',
          label: 'Principal',
          url: 'https://cdn.example.com/dune2.mp4',
          status: 'pending',
        },
      ],
    });

    const processed = await processItemFullPipeline(corsMovie, TEST_SETTINGS);
    assert.equal(processed.status, 'pendente');
    assert.equal(processed.healthChecked, true);
    assert.equal(processed.tmdbEnriched, true);
    assert.equal(processed.tmdbId, 693134);
    assert.equal(processed.youtubeTrailerId, 'U2Qp5pL3ovA');
    assert.equal(savedItems.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    (db.mediaItems as unknown as { put: typeof originalPut }).put = originalPut;
  }
});

test('TMDB HTTP 429 retries cleanly and API errors never crash item pipeline', async () => {
  const originalFetch = globalThis.fetch;
  const originalPut = db.mediaItems.put.bind(db.mediaItems);
  let tmdbAttempts = 0;

  (db.mediaItems as unknown as { put: (item: CatalogItem) => Promise<string> }).put = async (
    item: CatalogItem
  ) => item.id;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    if (urlStr.includes('/api/tmdb/enrich')) {
      tmdbAttempts += 1;
      if (tmdbAttempts === 1) {
        return new Response(JSON.stringify({ error: 'TMDB HTTP 429' }), {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          found: true,
          tmdbId: 550,
          title: 'Clube da Luta',
          year: 1999,
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes('/api/check-stream')) {
      return new Response(
        JSON.stringify({ ok: true, validationState: 'media_available', status: 200 }),
        { status: 200 }
      );
    }
    if (urlStr.includes('/api/youtube/search')) {
      return new Response('Bad Gateway', { status: 502 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const movie = makeBaseItem({
      id: 'movie-retry-429',
      title: 'Fight Club',
      sources: [
        {
          id: 'src-ok',
          label: 'Principal',
          url: 'https://cdn.example.com/fightclub.mp4',
          status: 'pending',
        },
      ],
    });

    const tmdbRes = await runTmdbEnrichmentForItem(movie, 'key');
    assert.equal(tmdbAttempts, 2);
    assert.equal(tmdbRes.item.tmdbEnriched, true);
    assert.equal(tmdbRes.item.tmdbId, 550);

    tmdbAttempts = 0;
    const processed = await processItemFullPipeline(movie, TEST_SETTINGS);
    assert.equal(processed.status, 'aprovado');
    assert.equal(processed.tmdbEnriched, true);
    assert.equal(processed.youtubeEnriched, true);
  } finally {
    globalThis.fetch = originalFetch;
    (db.mediaItems as unknown as { put: typeof originalPut }).put = originalPut;
  }
});

test('Pipeline honors AbortSignal cancellation without writing partial records', async () => {
  const originalPut = db.mediaItems.put.bind(db.mediaItems);
  let putCalled = false;
  (db.mediaItems as unknown as { put: (item: CatalogItem) => Promise<string> }).put = async (
    item: CatalogItem
  ) => {
    putCalled = true;
    return item.id;
  };

  try {
    const controller = new AbortController();
    controller.abort();
    const movie = makeBaseItem({
      id: 'movie-abort',
      title: 'Aborted Item',
      sources: [
        { id: 's1', label: 'P', url: 'https://cdn.example.com/a.mp4', status: 'pending' },
      ],
    });

    await assert.rejects(
      () =>
        processItemFullPipeline(movie, TEST_SETTINGS, undefined, {
          signal: controller.signal,
        }),
      (err: Error) => err.name === 'AbortError'
    );
    assert.equal(putCalled, false);
  } finally {
    (db.mediaItems as unknown as { put: typeof originalPut }).put = originalPut;
  }
});

test('Vite dev server attaches HMR WebSocket to the same HTTP port and accepts preview host upgrades', async () => {
  const httpServer = http.createServer();
  const app = await createServer(httpServer);
  httpServer.on('request', app);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });

  try {
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;

    const clientResp = await fetch(`http://127.0.0.1:${port}/@vite/client`);
    assert.equal(clientResp.status, 200);
    const clientText = await clientResp.text();
    const tokenMatch =
      clientText.match(/__WS_TOKEN__\s*=\s*"([^"]+)"/) ||
      clientText.match(/wsToken\s*=\s*"([^"]+)"/);

    const wsPath = tokenMatch?.[1]
      ? `/?token=${encodeURIComponent(tokenMatch[1])}`
      : '/';
    const previewHost = 'ais-dev-preview.us-east5.run.app';
    const wsKey = crypto.randomBytes(16).toString('base64');

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: wsPath,
        headers: {
          Host: previewHost,
          ...(tokenMatch?.[1] ? { Origin: `https://${previewHost}` } : {}),
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': wsKey,
          'Sec-WebSocket-Protocol': 'vite-hmr',
        },
      });
      req.on('upgrade', (res, socket) => {
        assert.equal(res.statusCode, 101);
        assert.equal(res.headers['sec-websocket-protocol'], 'vite-hmr');
        socket.destroy();
        resolve();
      });
      req.on('response', (res) => {
        reject(new Error(`Expected HTTP 101 upgrade, got ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await (app.locals as { vite?: { close: () => Promise<void> } }).vite?.close();
  }
});
