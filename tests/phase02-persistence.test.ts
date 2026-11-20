import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { createServer } from '../server';
import {
  deleteListDecoupledFromPostgres,
  getUserFavoritesFromPostgres,
  getUserWatchHistoryFromPostgres,
  listListsFromPostgres,
  listMigrationBackups,
  listWorksFromPostgres,
  migrateIndexedDbWithBackup,
  rollbackMigrationBackup,
  setUserFavoritesInPostgres,
  syncCatalogBatchToPostgres,
  upsertUserWatchHistoryInPostgres,
} from '../src/db/catalogRepository';
import { pgDb } from '../src/db/index';
import {
  lists,
  migrationBackups,
  servers,
  userFavorites,
  users,
  watchHistory,
  works,
} from '../src/db/schema';
import { getOrCreateUser } from '../src/db/users';
import type { CatalogItem, M3uListRecord } from '../src/types/streaming';
import { buildProvisionalKey } from '../src/utils/identity';

const TEST_RUN_TAG = `p2test-${Date.now().toString(36)}`;
const TEST_UID = `${TEST_RUN_TAG}-user-1`;
const TEST_UID_2 = `${TEST_RUN_TAG}-user-2`;

const createdWorkIdsToCleanup = new Set<string>();
const createdListIdsToCleanup = new Set<string>();

let server: http.Server;
let baseUrl = '';

function makeMovie(overrides: Partial<CatalogItem> & { id: string; title: string }): CatalogItem {
  const now = Date.now();
  return {
    type: 'movie',
    mediaKind: 'movie',
    year: 2021,
    genres: ['Ficção Científica'],
    ageRating: '14',
    duration: '2h 15min',
    durationSeconds: 8100,
    platform: 'max' in ({} as Record<string, unknown>) ? 'hbo' : 'netflix',
    synopsis: 'Sinopse padrão de teste.',
    cast: ['Ator Um'],
    director: 'Diretor Teste',
    youtubeTrailerId: '',
    posterImage: 'https://image.tmdb.org/t/p/w780/test-poster.jpg',
    backdropImage: 'https://image.tmdb.org/t/p/w1280/test-backdrop.jpg',
    categories: ['populares'],
    sources: [],
    status: 'pendente',
    archived: false,
    healthChecked: false,
    tmdbEnriched: false,
    youtubeEnriched: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

before(async () => {
  await getOrCreateUser(
    TEST_UID,
    `${TEST_RUN_TAG}-u1@example.com`,
    'Phase 02 Test User 1'
  );
  await getOrCreateUser(
    TEST_UID_2,
    `${TEST_RUN_TAG}-u2@example.com`,
    'Phase 02 Test User 2'
  );

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

  try {
    await pgDb
      .delete(watchHistory)
      .where(inArray(watchHistory.userUid, [TEST_UID, TEST_UID_2]));
    await pgDb
      .delete(userFavorites)
      .where(inArray(userFavorites.userUid, [TEST_UID, TEST_UID_2]));
    await pgDb
      .delete(migrationBackups)
      .where(inArray(migrationBackups.userUid, [TEST_UID, TEST_UID_2]));
    if (createdWorkIdsToCleanup.size > 0) {
      await pgDb
        .delete(works)
        .where(inArray(works.id, Array.from(createdWorkIdsToCleanup)));
    }
    if (createdListIdsToCleanup.size > 0) {
      await pgDb
        .delete(lists)
        .where(inArray(lists.id, Array.from(createdListIdsToCleanup)));
    }
    await pgDb
      .delete(users)
      .where(inArray(users.uid, [TEST_UID, TEST_UID_2]));
    const { like } = await import('drizzle-orm');
    await pgDb.delete(servers).where(like(servers.baseUrl, `%${TEST_RUN_TAG}%`));
  } catch (err) {
    console.error('Cleanup error:', err);
  }
});

test('Provisional matching prevents incorrect merges across years, undated works, and types', () => {
  const k1984 = buildProvisionalKey({
    type: 'movie',
    title: 'Duna (1984) 1080p Dublado',
    year: 1984,
  });
  const k2021 = buildProvisionalKey({
    type: 'movie',
    title: 'Duna (2021) 4K Legendado',
    year: 2021,
  });
  const kUnyeared = buildProvisionalKey({
    type: 'movie',
    title: 'Duna',
    year: undefined,
  });
  const kSeries = buildProvisionalKey({
    type: 'series',
    title: 'Duna',
    year: 2021,
  });

  assert.equal(k1984, 'movie::duna::1984');
  assert.equal(k2021, 'movie::duna::2021');
  assert.equal(kUnyeared, 'movie::duna::unyeared');
  assert.equal(kSeries, 'series::duna::2021');
  assert.equal(new Set([k1984, k2021, kUnyeared, kSeries]).size, 4);
});

test('PostgreSQL keeps distinct works without TMDB ID separated by exact year and merges same TMDB ID + preserves multi-sources', async () => {
  const listId = `${TEST_RUN_TAG}-list-collision`;
  createdListIdsToCleanup.add(listId);

  const listRec: M3uListRecord = {
    id: listId,
    name: 'Lista Anti-Colisão Teste',
    sourceType: 'url',
    sourceLocation: `https://${TEST_RUN_TAG}-cdn.example.com/playlist.m3u`,
    importedAt: Date.now(),
    totalEntries: 3,
    newItemsCreated: 3,
    mergedSourcesCount: 0,
    ignoredDuplicatesCount: 0,
  };

  const w1Id = `${TEST_RUN_TAG}-duna-1984`;
  const w2Id = `${TEST_RUN_TAG}-duna-2021`;
  const w3Id = `${TEST_RUN_TAG}-duna-unyeared`;
  createdWorkIdsToCleanup.add(w1Id);
  createdWorkIdsToCleanup.add(w2Id);
  createdWorkIdsToCleanup.add(w3Id);

  const item1984 = makeMovie({
    id: w1Id,
    title: 'Duna',
    originalTitle: 'Duna (1984) FHD',
    year: 1984,
    normalizedKey: 'movie::duna::1984',
    sources: [
      {
        id: `${TEST_RUN_TAG}-s1`,
        label: 'Fonte 1 · FHD',
        qualityTag: 'FHD',
        resolutionTag: 'FHD',
        url: `https://${TEST_RUN_TAG}-cdn.example.com/duna1984.mp4`,
        listId,
        status: 'online',
      },
    ],
  });

  const item2021 = makeMovie({
    id: w2Id,
    title: 'Duna',
    originalTitle: 'Duna (2021) 4K',
    year: 2021,
    tmdbId: 438631,
    tmdbEnriched: true,
    normalizedKey: 'movie::duna::2021',
    sources: [
      {
        id: `${TEST_RUN_TAG}-s2`,
        label: 'Fonte 1 · 4K',
        qualityTag: '4K',
        resolutionTag: '4K',
        url: `https://${TEST_RUN_TAG}-cdn.example.com/duna2021-4k.mp4`,
        listId,
        status: 'online',
      },
    ],
  });

  const itemUnyeared = makeMovie({
    id: w3Id,
    title: 'Duna',
    originalTitle: 'Duna 1080p',
    year: 2026,
    normalizedKey: 'movie::duna::unyeared',
    sources: [
      {
        id: `${TEST_RUN_TAG}-s3`,
        label: 'Fonte 1 · FHD',
        qualityTag: 'FHD',
        resolutionTag: 'FHD',
        url: `https://${TEST_RUN_TAG}-cdn.example.com/duna-unknown.mp4`,
        listId,
        status: 'pending',
      },
    ],
  });

  const res1 = await syncCatalogBatchToPostgres({
    items: [item1984, item2021, itemUnyeared],
    list: listRec,
  });

  assert.equal(res1.createdCount, 3);

  // Now merge a 2nd source onto Duna (2021) using TMDB ID + localized title
  const duplicateAlias = makeMovie({
    id: `${TEST_RUN_TAG}-duna-2021-alt`,
    title: 'Dune Part One',
    originalTitle: 'Dune: Part One (2021) 720p',
    year: 2021,
    tmdbId: 438631,
    tmdbEnriched: false,
    normalizedKey: 'movie::dune part one::2021',
    sources: [
      {
        id: `${TEST_RUN_TAG}-s4`,
        label: 'Fonte 1 · HD',
        qualityTag: 'HD',
        resolutionTag: 'HD',
        url: `https://${TEST_RUN_TAG}-cdn2.example.com/dune2021-720p.mp4`,
        headers: { referer: 'https://provider.example/', userAgent: 'Test Player' },
        clearKey: { keyId: '12'.repeat(16), key: '34'.repeat(16) },
        listId,
        status: 'pending',
      },
    ],
  });

  const res2 = await syncCatalogBatchToPostgres({
    items: [duplicateAlias],
  });

  assert.equal(res2.mergedCount, 1);
  assert.equal(res2.idMap[duplicateAlias.id], w2Id);

  const allWorks = await listWorksFromPostgres({ includeArchived: true });
  const duna2021 = allWorks.find((w) => w.id === w2Id);
  assert.ok(duna2021);
  assert.ok(duna2021.sources);
  assert.equal(duna2021.sources.length, 2);
  assert.equal(duna2021.title, 'Duna'); // TMDB title NOT overwritten by un-enriched import!
  assert.equal(duna2021.sources[0].resolutionTag, '4K'); // Priority preserved
  const addedSource = duna2021.sources.find((source) => source.resolutionTag === 'HD');
  assert.deepEqual(addedSource?.headers, duplicateAlias.sources?.[0].headers);
  assert.deepEqual(addedSource?.clearKey, duplicateAlias.sources?.[0].clearKey);
});

test('Deleting and re-importing a list preserves work IDs, TMDB/YouTube sheets, series episodes, per-user favorites, and watch progress', async () => {
  const listA = `${TEST_RUN_TAG}-list-A`;
  const listB = `${TEST_RUN_TAG}-list-B`;
  const listAReimport = `${TEST_RUN_TAG}-list-A-reimport`;
  createdListIdsToCleanup.add(listA);
  createdListIdsToCleanup.add(listB);
  createdListIdsToCleanup.add(listAReimport);

  const movieXId = `${TEST_RUN_TAG}-movie-x`;
  const seriesYId = `${TEST_RUN_TAG}-series-y`;
  const multiZId = `${TEST_RUN_TAG}-movie-z`;
  createdWorkIdsToCleanup.add(movieXId);
  createdWorkIdsToCleanup.add(seriesYId);
  createdWorkIdsToCleanup.add(multiZId);

  const movieX = makeMovie({
    id: movieXId,
    title: 'Horizonte Estelar',
    originalTitle: 'Horizonte Estelar (2023) 4K Dublado',
    year: 2023,
    tmdbId: 991023,
    tmdbEnriched: true,
    youtubeEnriched: true,
    youtubeTrailerId: 'dQw4w9WgXcQ',
    synopsis: 'Sinopse TMDB oficial preservada.',
    status: 'publicado',
    normalizedKey: 'movie::horizonte estelar::2023',
    sources: [
      {
        id: `${TEST_RUN_TAG}-mx-s1`,
        label: 'Fonte 1 · 4K',
        qualityTag: '4K · Dublado',
        resolutionTag: '4K',
        url: `https://${TEST_RUN_TAG}-srvA.example.com/horizonte-4k.mp4`,
        listId: listA,
        status: 'online',
      },
    ],
  });

  const seriesY: CatalogItem = {
    ...makeMovie({
      id: seriesYId,
      title: 'Sinais do Norte',
      originalTitle: 'Sinais do Norte (2022)',
      year: 2022,
      tmdbId: 882022,
      tmdbEnriched: true,
      synopsis: 'Série investigativa no extremo norte.',
      status: 'publicado',
      normalizedKey: 'series::sinais do norte::2022',
    }),
    type: 'series',
    mediaKind: 'series',
    duration: '1 Temporada · 2 eps',
    episodes: [
      {
        id: 's1e1',
        season: 1,
        episode: 1,
        title: 'Episódio 1',
        sources: [
          {
            id: `${TEST_RUN_TAG}-sy-e1`,
            label: 'Fonte 1 · FHD',
            qualityTag: 'FHD',
            resolutionTag: 'FHD',
            url: `https://${TEST_RUN_TAG}-srvA.example.com/sinais-s01e01.mp4`,
            listId: listA,
            status: 'online',
          },
        ],
      },
      {
        id: 's1e2',
        season: 1,
        episode: 2,
        title: 'A Tempestade',
        sources: [
          {
            id: `${TEST_RUN_TAG}-sy-e2`,
            label: 'Fonte 1 · FHD',
            qualityTag: 'FHD',
            resolutionTag: 'FHD',
            url: `https://${TEST_RUN_TAG}-srvA.example.com/sinais-s01e02.mp4`,
            listId: listA,
            status: 'online',
          },
        ],
      },
    ],
  };

  const movieZ = makeMovie({
    id: multiZId,
    title: 'Obra Compartilhada',
    originalTitle: 'Obra Compartilhada (2020)',
    year: 2020,
    status: 'publicado',
    normalizedKey: 'movie::obra compartilhada::2020',
    sources: [
      {
        id: `${TEST_RUN_TAG}-mz-s1`,
        label: 'Fonte 1 · 4K',
        qualityTag: '4K',
        resolutionTag: '4K',
        url: `https://${TEST_RUN_TAG}-srvA.example.com/shared-a.mp4`,
        listId: listA,
        status: 'online',
      },
      {
        id: `${TEST_RUN_TAG}-mz-s2`,
        label: 'Fonte 2 · HD',
        qualityTag: 'HD',
        resolutionTag: 'HD',
        url: `https://${TEST_RUN_TAG}-srvB.example.com/shared-b.mp4`,
        listId: listB,
        status: 'online',
      },
    ],
  });

  await syncCatalogBatchToPostgres({
    items: [movieX, seriesY, movieZ],
    list: {
      id: listA,
      name: 'Lista A Principal',
      sourceType: 'url',
      sourceLocation: `https://${TEST_RUN_TAG}-srvA.example.com/a.m3u`,
      importedAt: Date.now(),
      totalEntries: 4,
      newItemsCreated: 3,
      mergedSourcesCount: 0,
      ignoredDuplicatesCount: 0,
    },
  });

  // Register listB and link multiZ's second source cleanly
  await syncCatalogBatchToPostgres({
    items: [movieZ],
    list: {
      id: listB,
      name: 'Lista B Redundância',
      sourceType: 'url',
      sourceLocation: `https://${TEST_RUN_TAG}-srvB.example.com/b.m3u`,
      importedAt: Date.now(),
      totalEntries: 1,
      newItemsCreated: 0,
      mergedSourcesCount: 1,
      ignoredDuplicatesCount: 0,
    },
  });

  // Per-user favorites and watch history (isolated per user!)
  await setUserFavoritesInPostgres(TEST_UID, [movieXId, seriesYId]);
  await setUserFavoritesInPostgres(TEST_UID_2, [multiZId]);

  await upsertUserWatchHistoryInPostgres(TEST_UID, {
    id: `movie:${movieXId}`,
    itemId: movieXId,
    type: 'movie',
    episodeLabel: 'Filme Completo',
    currentTime: 1840,
    duration: 4000,
    progressPercent: 46,
    completed: false,
    selectedSourceId: `${TEST_RUN_TAG}-mx-s1`,
    updatedAt: Date.now(),
  });

  await upsertUserWatchHistoryInPostgres(TEST_UID, {
    id: `series:${seriesYId}:S1:E2`,
    itemId: seriesYId,
    type: 'series',
    season: 1,
    episodeNumber: 2,
    episodeId: 's1e2',
    episodeTitle: 'A Tempestade',
    episodeLabel: 'T1:E2 · A Tempestade',
    currentTime: 725,
    duration: 2400,
    progressPercent: 30,
    completed: false,
    updatedAt: Date.now(),
  });

  // 1) Delete List A (decoupled deletion!)
  const delResult = await deleteListDecoupledFromPostgres(listA);
  assert.equal(delResult.archivedWorks, 2);
  assert.equal(delResult.updatedWorks, 1);

  const remainingLists = await listListsFromPostgres();
  assert.equal(remainingLists.some((l) => l.id === listA), false);
  assert.equal(remainingLists.some((l) => l.id === listB), true);

  // Active list hides archived works, includeArchived preserves their full sheets!
  const activeWorks = await listWorksFromPostgres({ includeArchived: false });
  assert.equal(activeWorks.some((w) => w.id === movieXId), false);
  assert.equal(activeWorks.some((w) => w.id === seriesYId), false);
  const activeZ = activeWorks.find((w) => w.id === multiZId);
  assert.ok(activeZ);
  assert.ok(activeZ.sources);
  assert.equal(activeZ.sources.length, 1);
  assert.equal(activeZ.sources[0].listId, listB);

  const withArchived = await listWorksFromPostgres({ includeArchived: true });
  const archivedX = withArchived.find((w) => w.id === movieXId);
  const archivedY = withArchived.find((w) => w.id === seriesYId);
  assert.ok(archivedX);
  assert.ok(archivedY);
  assert.equal(archivedX.archived, true);
  assert.equal(archivedX.sources?.length ?? 0, 0);
  assert.equal(archivedX.synopsis, 'Sinopse TMDB oficial preservada.');
  assert.equal(archivedX.youtubeTrailerId, 'dQw4w9WgXcQ');
  assert.equal(archivedY.archived, true);
  assert.equal(archivedY.episodes?.length, 2);

  // Favorites & History per user remained completely intact!
  const u1FavsAfterDelete = await getUserFavoritesFromPostgres(TEST_UID);
  const u2FavsAfterDelete = await getUserFavoritesFromPostgres(TEST_UID_2);
  assert.deepEqual(u1FavsAfterDelete.sort(), [movieXId, seriesYId].sort());
  assert.deepEqual(u2FavsAfterDelete, [multiZId]);

  const u1HistAfterDelete = await getUserWatchHistoryFromPostgres(TEST_UID);
  assert.equal(u1HistAfterDelete.length, 2);
  assert.equal(
    u1HistAfterDelete.find((h) => h.itemId === movieXId)?.currentTime,
    1840
  );
  assert.equal(
    u1HistAfterDelete.find((h) => h.itemId === seriesYId)?.currentTime,
    725
  );

  // 2) Re-import List A with new ID and raw (un-enriched) M3U records!
  const rawReimportX = makeMovie({
    id: `${TEST_RUN_TAG}-new-temp-id-x`,
    title: 'Horizonte Estelar',
    originalTitle: 'Horizonte Estelar (2023) 1080p',
    year: 2023,
    synopsis: 'Texto genérico M3U que NÃO deve sobrescrever o TMDB.',
    posterImage: '',
    tmdbEnriched: false,
    status: 'pendente',
    normalizedKey: 'movie::horizonte estelar::2023',
    sources: [
      {
        id: `${TEST_RUN_TAG}-mx-s1-re`,
        label: 'Fonte 1 · FHD',
        qualityTag: 'FHD',
        resolutionTag: 'FHD',
        url: `https://${TEST_RUN_TAG}-srvA.example.com/horizonte-fhd.mp4`,
        listId: listAReimport,
        status: 'pending',
      },
    ],
  });

  const rawReimportY: CatalogItem = {
    ...makeMovie({
      id: `${TEST_RUN_TAG}-new-temp-id-y`,
      title: 'Sinais do Norte',
      originalTitle: 'Sinais do Norte (2022)',
      year: 2022,
      synopsis: 'Genérico M3U',
      tmdbEnriched: false,
      status: 'pendente',
      normalizedKey: 'series::sinais do norte::2022',
    }),
    type: 'series',
    mediaKind: 'series',
    episodes: [
      {
        id: 's1e2',
        season: 1,
        episode: 2,
        title: 'Episódio 2',
        sources: [
          {
            id: `${TEST_RUN_TAG}-sy-e2-re`,
            label: 'Fonte 1 · FHD',
            qualityTag: 'FHD',
            resolutionTag: 'FHD',
            url: `https://${TEST_RUN_TAG}-srvA.example.com/sinais-s01e02-new.mp4`,
            listId: listAReimport,
            status: 'pending',
          },
        ],
      },
    ],
  };

  const reimportRes = await syncCatalogBatchToPostgres({
    items: [rawReimportX, rawReimportY],
    list: {
      id: listAReimport,
      name: 'Lista A Reimportada',
      sourceType: 'url',
      sourceLocation: `https://${TEST_RUN_TAG}-srvA.example.com/a-v2.m3u`,
      importedAt: Date.now(),
      totalEntries: 2,
      newItemsCreated: 0,
      mergedSourcesCount: 2,
      ignoredDuplicatesCount: 0,
    },
  });

  assert.equal(reimportRes.reactivatedCount, 2);
  assert.equal(reimportRes.idMap[rawReimportX.id], movieXId);
  assert.equal(reimportRes.idMap[rawReimportY.id], seriesYId);

  const reactivatedCatalog = await listWorksFromPostgres({
    includeArchived: false,
  });
  const reactivatedX = reactivatedCatalog.find((w) => w.id === movieXId);
  const reactivatedY = reactivatedCatalog.find((w) => w.id === seriesYId);

  assert.ok(reactivatedX);
  assert.ok(reactivatedY);
  assert.equal(reactivatedX.archived, false);
  assert.equal(reactivatedX.status, 'publicado');
  assert.equal(reactivatedX.tmdbId, 991023);
  assert.equal(reactivatedX.synopsis, 'Sinopse TMDB oficial preservada.');
  assert.equal(reactivatedX.youtubeTrailerId, 'dQw4w9WgXcQ');
  assert.equal(reactivatedX.sources?.length, 1);

  assert.equal(reactivatedY.archived, false);
  assert.equal(reactivatedY.status, 'publicado');
  const ep2 = reactivatedY.episodes?.find(
    (e) => e.season === 1 && e.episode === 2
  );
  assert.ok(ep2);
  assert.equal(ep2.sources.length, 1);
});

test('IndexedDB migration creates backup, merges conservatively, and supports exact rollback', async () => {
  const baselineId = `${TEST_RUN_TAG}-mig-baseline`;
  const migNewId = `${TEST_RUN_TAG}-mig-new`;
  const migOverlapLocalId = `${TEST_RUN_TAG}-mig-overlap-local`;
  const migListId = `${TEST_RUN_TAG}-mig-list`;
  createdWorkIdsToCleanup.add(baselineId);
  createdWorkIdsToCleanup.add(migNewId);
  createdWorkIdsToCleanup.add(migOverlapLocalId);
  createdListIdsToCleanup.add(migListId);

  await syncCatalogBatchToPostgres({
    items: [
      makeMovie({
        id: baselineId,
        title: 'Base Existente Oficial',
        originalTitle: 'Base Existente Oficial (2024)',
        year: 2024,
        tmdbId: 777424,
        tmdbEnriched: true,
        synopsis: 'Ficha existente no PostgreSQL não pode ser sobrescrita.',
        status: 'publicado',
        normalizedKey: 'movie::base existente oficial::2024',
      }),
    ],
  });

  const migSummary = await migrateIndexedDbWithBackup(TEST_UID_2, {
    source: 'manual_admin',
    lists: [
      {
        id: migListId,
        name: 'Lista Migrada Teste',
        sourceType: 'file',
        sourceLocation: 'backup.m3u',
        importedAt: Date.now(),
        totalEntries: 2,
        newItemsCreated: 1,
        mergedSourcesCount: 1,
        ignoredDuplicatesCount: 0,
      },
    ],
    items: [
      makeMovie({
        id: migOverlapLocalId,
        title: 'Base Existente Local',
        originalTitle: 'Base Existente Oficial (2024)',
        year: 2024,
        tmdbId: 777424,
        tmdbEnriched: false,
        synopsis: 'Sinopse local desatualizada',
        status: 'pendente',
        normalizedKey: 'movie::base existente oficial::2024',
        sources: [
          {
            id: `${TEST_RUN_TAG}-mig-src-overlap`,
            label: 'Fonte 1 · FHD',
            url: `https://${TEST_RUN_TAG}-mig.example.com/overlap.mp4`,
            listId: migListId,
            status: 'pending',
          },
        ],
      }),
      makeMovie({
        id: migNewId,
        title: 'Obra Migrada Nova',
        originalTitle: 'Obra Migrada Nova (2025)',
        year: 2025,
        status: 'publicado',
        normalizedKey: 'movie::obra migrada nova::2025',
        sources: [
          {
            id: `${TEST_RUN_TAG}-mig-src-new`,
            label: 'Fonte 1 · 4K',
            qualityTag: '4K',
            resolutionTag: '4K',
            url: `https://${TEST_RUN_TAG}-mig.example.com/nova.mp4`,
            listId: migListId,
            status: 'online',
          },
        ],
      }),
    ],
    myListIds: [migNewId],
    watchHistory: [
      {
        id: `movie:${migNewId}`,
        itemId: migNewId,
        type: 'movie',
        episodeLabel: 'Filme Completo',
        currentTime: 510,
        duration: 3600,
        progressPercent: 14,
        completed: false,
        updatedAt: Date.now(),
      },
    ],
  });

  assert.equal(migSummary.createdWorks, 1);
  assert.equal(migSummary.mergedWorks, 1);
  assert.equal(migSummary.idMap[migOverlapLocalId], baselineId);
  assert.equal(migSummary.createdFavorites, 1);
  assert.equal(migSummary.migratedHistory, 1);

  const backups = await listMigrationBackups(TEST_UID_2);
  assert.equal(backups[0]?.id, migSummary.backupId);
  assert.equal(backups[0]?.status, 'completed');

  const afterMigWorks = await listWorksFromPostgres({ includeArchived: true });
  const baselineAfterMig = afterMigWorks.find((w) => w.id === baselineId);
  assert.ok(baselineAfterMig);
  assert.equal(
    baselineAfterMig.synopsis,
    'Ficha existente no PostgreSQL não pode ser sobrescrita.'
  );
  assert.equal(afterMigWorks.some((w) => w.id === migNewId), true);

  // Execute Rollback
  const rollbackRes = await rollbackMigrationBackup(migSummary.backupId, TEST_UID_2);
  assert.equal(rollbackRes.revertedWorks, 1);
  assert.equal(rollbackRes.revertedLists, 1);
  assert.equal(rollbackRes.revertedFavorites, 1);
  assert.equal(rollbackRes.revertedHistory, 1);

  const afterRollbackWorks = await listWorksFromPostgres({
    includeArchived: true,
  });
  assert.equal(afterRollbackWorks.some((w) => w.id === migNewId), false);
  assert.equal(afterRollbackWorks.some((w) => w.id === baselineId), true);

  const favsAfterRollback = await getUserFavoritesFromPostgres(TEST_UID_2);
  assert.equal(favsAfterRollback.includes(migNewId), false);

  const histAfterRollback = await getUserWatchHistoryFromPostgres(TEST_UID_2);
  assert.equal(histAfterRollback.some((h) => h.itemId === migNewId), false);

  const backupsAfterRollback = await listMigrationBackups(TEST_UID_2);
  assert.equal(backupsAfterRollback[0]?.status, 'rolled_back');

  const remainingBaseline = await pgDb
    .select()
    .from(works)
    .where(and(eq(works.id, baselineId), eq(works.tmdbId, 777424)));
  assert.equal(remainingBaseline.length, 1);
});

test('Phase 02 Express persistence endpoints fail closed (401) without Firebase Bearer token', async () => {
  const endpoints: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/catalog' },
    { method: 'POST', path: '/api/catalog/sync' },
    { method: 'DELETE', path: '/api/lists/non-existent' },
    { method: 'GET', path: '/api/user/library' },
    { method: 'GET', path: '/api/user/history' },
    { method: 'POST', path: '/api/migration/import' },
    { method: 'GET', path: '/api/migration/backups' },
    { method: 'POST', path: '/api/migration/rollback' },
  ];

  for (const ep of endpoints) {
    const resp = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers: { 'Content-Type': 'application/json' },
      body: ep.method === 'POST' ? '{}' : undefined,
    });
    assert.equal(
      resp.status,
      401,
      `Expected 401 for unauthenticated ${ep.method} ${ep.path}, got ${resp.status}`
    );
  }
});
