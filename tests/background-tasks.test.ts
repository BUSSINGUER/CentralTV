import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { eq, inArray, like } from 'drizzle-orm';
import { createServer } from '../server';
import { syncCatalogBatchToPostgres } from '../src/db/catalogRepository';
import { pgDb } from '../src/db/index';
import {
  lists,
  processingTasks,
  servers,
  users,
  works,
} from '../src/db/schema';
import {
  createOrEnqueueProcessingTask,
  getHydratedWorkByIdFromPostgres,
  getInternalTaskById,
  listProcessingTasksFromPostgres,
} from '../src/db/taskRepository';
import { getOrCreateUser } from '../src/db/users';
import { BackgroundTaskRunner } from '../src/services/backgroundTaskRunner';
import type { CatalogItem, M3uListRecord } from '../src/types/streaming';

const TEST_RUN_TAG = `bgtask-${Date.now().toString(36)}`;
const TEST_UID = `${TEST_RUN_TAG}-admin`;

const createdWorkIds = new Set<string>();
const createdListIds = new Set<string>();
const createdTaskIds = new Set<string>();

let server: http.Server;
let baseUrl = '';

function makeMovie(
  overrides: Partial<CatalogItem> & { id: string; title: string }
): CatalogItem {
  const now = Date.now();
  return {
    type: 'movie',
    mediaKind: 'movie',
    year: 2022,
    genres: ['Ação'],
    ageRating: '14',
    duration: '1h 50min',
    durationSeconds: 6600,
    platform: 'netflix',
    synopsis: 'Filme de teste para processamento em segundo plano.',
    cast: [],
    director: 'Teste',
    youtubeTrailerId: '',
    posterImage: '',
    backdropImage: '',
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

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 6000,
  stepMs = 40
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timeout waiting for background task condition (${timeoutMs}ms).`);
}

before(async () => {
  await getOrCreateUser(TEST_UID, `${TEST_RUN_TAG}@example.com`, 'Background Runner Admin');

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
    if (createdTaskIds.size > 0) {
      await pgDb
        .delete(processingTasks)
        .where(inArray(processingTasks.id, Array.from(createdTaskIds)));
    }
    await pgDb.delete(processingTasks).where(eq(processingTasks.userUid, TEST_UID));

    if (createdWorkIds.size > 0) {
      await pgDb
        .delete(works)
        .where(inArray(works.id, Array.from(createdWorkIds)));
    }
    if (createdListIds.size > 0) {
      await pgDb
        .delete(lists)
        .where(inArray(lists.id, Array.from(createdListIds)));
    }
    await pgDb.delete(users).where(eq(users.uid, TEST_UID));
    await pgDb.delete(servers).where(like(servers.baseUrl, `%${TEST_RUN_TAG}%`));
  } catch (err) {
    console.error('Background task test cleanup failed:', err);
  }
});

test('Background task HTTP endpoints require Firebase authentication (fail-closed 401)', async () => {
  const endpoints = [
    { method: 'GET', path: '/api/tasks/processing' },
    { method: 'POST', path: '/api/tasks/processing' },
    { method: 'POST', path: '/api/tasks/processing/fake-id/pause' },
    { method: 'POST', path: '/api/tasks/processing/fake-id/resume' },
    { method: 'POST', path: '/api/tasks/processing/fake-id/cancel' },
  ];

  for (const ep of endpoints) {
    const resp = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers: { 'Content-Type': 'application/json' },
      body: ep.method === 'POST' ? JSON.stringify({}) : undefined,
    });
    assert.equal(resp.status, 401, `${ep.method} ${ep.path} must reject unauthenticated callers`);
  }
});

test('Background runner verifies sources independently of UI and leaves enrichment for details', async () => {
  const listId = `${TEST_RUN_TAG}-list-1`;
  createdListIds.add(listId);

  const listRec: M3uListRecord = {
    id: listId,
    name: 'Lista Segundo Plano 1',
    sourceType: 'url',
    sourceLocation: `https://${TEST_RUN_TAG}-1.example.com/list.m3u`,
    importedAt: Date.now(),
    totalEntries: 3,
    newItemsCreated: 3,
    mergedSourcesCount: 0,
    ignoredDuplicatesCount: 0,
  };

  const wOnline = `${TEST_RUN_TAG}-movie-ok`;
  const wCors = `${TEST_RUN_TAG}-movie-cors`;
  const wSeries = `${TEST_RUN_TAG}-series-ep`;
  [wOnline, wCors, wSeries].forEach((id) => createdWorkIds.add(id));

  await syncCatalogBatchToPostgres({
    list: listRec,
    items: [
      makeMovie({
        id: wOnline,
        title: 'Matrix Teste',
        sources: [
          {
            id: `${TEST_RUN_TAG}-src-ok`,
            label: 'Fonte 1 · FHD',
            url: `https://${TEST_RUN_TAG}-cdn.example.com/ok.mp4`,
            listId,
            status: 'pending',
          },
        ],
      }),
      makeMovie({
        id: wCors,
        title: 'Cors Teste',
        sources: [
          {
            id: `${TEST_RUN_TAG}-src-cors`,
            label: 'Fonte 1 · FHD',
            url: `https://${TEST_RUN_TAG}-cdn.example.com/cors.m3u8`,
            listId,
            status: 'pending',
          },
        ],
      }),
      makeMovie({
        id: wSeries,
        title: 'Série Teste',
        type: 'series',
        mediaKind: 'series',
        sources: [],
        episodes: [
          {
            id: 's1e1',
            season: 1,
            episode: 1,
            title: 'Piloto',
            sources: [
              {
                id: `${TEST_RUN_TAG}-src-ep1`,
                label: 'Fonte 1 · HD',
                url: `https://${TEST_RUN_TAG}-cdn.example.com/ep1.mp4`,
                listId,
                status: 'pending',
              },
            ],
          },
        ],
      }),
    ],
  });

  const probedUrls: string[] = [];
  const runner = new BackgroundTaskRunner({
    probeStream: async (url) => {
      probedUrls.push(url);
      if (url.includes('cors.m3u8')) {
        return {
          ok: false,
          validationState: 'cors_blocked',
          status: 0,
          reason: 'CORS blocked test',
        };
      }
      return {
        ok: true,
        validationState: 'media_available',
        status: 200,
        mediaType: 'mp4',
        latencyMs: 25,
        reason: 'Stream ativo',
      };
    },
  });

  const created = await createOrEnqueueProcessingTask({
    userUid: TEST_UID,
    scope: 'list',
    listId,
    listName: listRec.name,
    settings: { batchSize: 2, probeTimeoutMs: 2000 },
  });

  assert.ok(created.task);
  createdTaskIds.add(created.task.id);
  assert.equal(created.task.status, 'running');
  assert.equal(created.task.totalItems, 3);

  await runner.kick(created.task.id);

  await waitUntil(async () => {
    const rec = await getInternalTaskById(created.task!.id);
    return rec?.view.status === 'completed';
  });

  const finalTask = await getInternalTaskById(created.task.id);
  assert.equal(finalTask?.view.processedItems, 3);
  assert.equal(finalTask?.view.approvedCount, 2); // movie-ok + series-ep
  assert.equal(finalTask?.view.pendingBlockedCount, 1); // movie-cors
  assert.equal(finalTask?.view.offlineCount, 0);

  // Verify settingsJson is never leaked via public ProcessingTaskView
  const listView = await listProcessingTasksFromPostgres(TEST_UID, 10);
  const publicTask = listView.find((t) => t.id === created.task!.id);
  assert.ok(publicTask);
  assert.equal('settingsJson' in (publicTask as unknown as Record<string, unknown>), false);

  // Verify series episode URL was NOT probed directly
  assert.equal(
    probedUrls.some((u) => u.includes('ep1.mp4')),
    false
  );

  // Verify persisted statuses without eager metadata.
  const hydratedOk = await getHydratedWorkByIdFromPostgres(wOnline);
  const hydratedCors = await getHydratedWorkByIdFromPostgres(wCors);
  const hydratedSeries = await getHydratedWorkByIdFromPostgres(wSeries);

  assert.equal(hydratedOk?.status, 'aprovado');
  assert.equal(hydratedOk?.tmdbEnriched, false);
  assert.equal(hydratedOk?.youtubeTrailerId, '');

  assert.equal(hydratedCors?.status, 'pendente');
  assert.equal(hydratedCors?.tmdbEnriched, false);
  assert.equal(hydratedCors?.youtubeTrailerId, '');

  assert.equal(hydratedSeries?.status, 'aprovado');
  assert.equal(hydratedSeries?.tmdbEnriched, false);
  assert.equal(hydratedSeries?.youtubeTrailerId, '');

  await runner.shutdown();
});

test('Prevents duplicate open tasks and automatically queues a second distinct task until the first completes', async () => {
  const listA = `${TEST_RUN_TAG}-list-a`;
  const listB = `${TEST_RUN_TAG}-list-b`;
  createdListIds.add(listA);
  createdListIds.add(listB);

  const wA = `${TEST_RUN_TAG}-work-a`;
  const wB = `${TEST_RUN_TAG}-work-b`;
  createdWorkIds.add(wA);
  createdWorkIds.add(wB);

  await syncCatalogBatchToPostgres({
    list: {
      id: listA,
      name: 'Lista A',
      sourceType: 'url',
      importedAt: Date.now(),
      totalEntries: 1,
      newItemsCreated: 1,
      mergedSourcesCount: 0,
      ignoredDuplicatesCount: 0,
    },
    items: [
      makeMovie({
        id: wA,
        title: 'Filme A',
        sources: [
          {
            id: `${TEST_RUN_TAG}-src-a`,
            label: 'Fonte 1',
            url: `https://${TEST_RUN_TAG}-a.example.com/a.mp4`,
            listId: listA,
            status: 'pending',
          },
        ],
      }),
    ],
  });

  await syncCatalogBatchToPostgres({
    list: {
      id: listB,
      name: 'Lista B',
      sourceType: 'url',
      importedAt: Date.now(),
      totalEntries: 1,
      newItemsCreated: 1,
      mergedSourcesCount: 0,
      ignoredDuplicatesCount: 0,
    },
    items: [
      makeMovie({
        id: wB,
        title: 'Filme B',
        sources: [
          {
            id: `${TEST_RUN_TAG}-src-b`,
            label: 'Fonte 1',
            url: `https://${TEST_RUN_TAG}-b.example.com/b.mp4`,
            listId: listB,
            status: 'pending',
          },
        ],
      }),
    ],
  });

  let releaseProbeA!: () => void;
  const gateA = new Promise<void>((r) => {
    releaseProbeA = r;
  });

  const runner = new BackgroundTaskRunner({
    probeStream: async (url) => {
      if (url.includes('/a.mp4')) {
        await gateA;
      }
      return {
        ok: true,
        validationState: 'media_available',
        status: 200,
      };
    },
  });

  const first = await createOrEnqueueProcessingTask({
    userUid: TEST_UID,
    scope: 'list',
    listId: listA,
    listName: 'Lista A',
    settings: { batchSize: 1 },
  });
  assert.ok(first.task);
  createdTaskIds.add(first.task.id);
  assert.equal(first.task.status, 'running');
  assert.equal(first.queued, false);
  await runner.kick(first.task.id);

  // Requesting the same list again must deduplicate without creating a second task
  const dup = await createOrEnqueueProcessingTask({
    userUid: TEST_UID,
    scope: 'list',
    listId: listA,
    listName: 'Lista A',
  });
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.task?.id, first.task.id);

  // Requesting a different list while A is running must enqueue B automatically
  const second = await createOrEnqueueProcessingTask({
    userUid: TEST_UID,
    scope: 'list',
    listId: listB,
    listName: 'Lista B',
    settings: { batchSize: 1 },
  });
  assert.ok(second.task);
  createdTaskIds.add(second.task.id);
  assert.equal(second.deduplicated, false);
  assert.equal(second.queued, true);
  assert.equal(second.task.status, 'queued');

  releaseProbeA();

  await waitUntil(async () => {
    const tA = await getInternalTaskById(first.task!.id);
    const tB = await getInternalTaskById(second.task!.id);
    return tA?.view.status === 'completed' && tB?.view.status === 'completed';
  });

  await runner.shutdown();
});

test('Pause, resume, cancel, and simulated server restart resume from saved cursorIndex without reprocessing finished items', async () => {
  const listId = `${TEST_RUN_TAG}-list-restart`;
  createdListIds.add(listId);

  const w1 = `${TEST_RUN_TAG}-r1`;
  const w2 = `${TEST_RUN_TAG}-r2`;
  const w3 = `${TEST_RUN_TAG}-r3`;
  const wCancel = `${TEST_RUN_TAG}-c1`;
  [w1, w2, w3, wCancel].forEach((id) => createdWorkIds.add(id));

  await syncCatalogBatchToPostgres({
    list: {
      id: listId,
      name: 'Lista Restart',
      sourceType: 'url',
      importedAt: Date.now(),
      totalEntries: 3,
      newItemsCreated: 3,
      mergedSourcesCount: 0,
      ignoredDuplicatesCount: 0,
    },
    items: [
      makeMovie({
        id: w1,
        title: 'Item 1',
        createdAt: Date.now() + 30,
        sources: [
          {
            id: `${TEST_RUN_TAG}-sr1`,
            label: 'F1',
            url: `https://${TEST_RUN_TAG}-r.example.com/1.mp4`,
            listId,
            status: 'pending',
          },
        ],
      }),
      makeMovie({
        id: w2,
        title: 'Item 2',
        createdAt: Date.now() + 20,
        sources: [
          {
            id: `${TEST_RUN_TAG}-sr2`,
            label: 'F1',
            url: `https://${TEST_RUN_TAG}-r.example.com/2.mp4`,
            listId,
            status: 'pending',
          },
        ],
      }),
      makeMovie({
        id: w3,
        title: 'Item 3',
        createdAt: Date.now() + 10,
        sources: [
          {
            id: `${TEST_RUN_TAG}-sr3`,
            label: 'F1',
            url: `https://${TEST_RUN_TAG}-r.example.com/3.mp4`,
            listId,
            status: 'pending',
          },
        ],
      }),
    ],
  });

  const probeCallsByInstance: { r1: string[]; r2: string[] } = { r1: [], r2: [] };
  let item2Gate!: () => void;
  const waitItem2 = new Promise<void>((r) => {
    item2Gate = r;
  });

  const runner1 = new BackgroundTaskRunner({
    probeStream: async (url, _timeout, signal) => {
      probeCallsByInstance.r1.push(url);
      if (url.includes('/2.mp4')) {
        item2Gate();
        await new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      }
      return { ok: true, validationState: 'media_available', status: 200 };
    },
  });

  const taskCreated = await createOrEnqueueProcessingTask({
    userUid: TEST_UID,
    scope: 'list',
    listId,
    listName: 'Lista Restart',
    settings: { batchSize: 1, probeTimeoutMs: 5000 },
  });
  assert.ok(taskCreated.task);
  createdTaskIds.add(taskCreated.task.id);

  await runner1.kick(taskCreated.task.id);
  await waitItem2;

  // 1) Pause while item 2 is in-flight -> item 1 already saved (cursorIndex === 1)
  const paused = await runner1.pauseTask(taskCreated.task.id, TEST_UID);
  assert.equal(paused?.status, 'paused');

  const midPaused = await getInternalTaskById(taskCreated.task.id);
  assert.equal(midPaused?.view.cursorIndex, 1);
  assert.equal(midPaused?.view.processedItems, 1);

  // 2) Resume on runner1, then simulate abrupt server shutdown before item 2 completes
  const resumed = await runner1.resumeTask(taskCreated.task.id, TEST_UID);
  assert.equal(resumed?.status, 'running');
  await waitUntil(async () => probeCallsByInstance.r1.filter((u) => u.includes('/2.mp4')).length >= 2);
  await runner1.shutdown();

  // Task must remain in status = 'running' at cursorIndex = 1 in PostgreSQL across restart
  const persistedAfterShutdown = await getInternalTaskById(taskCreated.task.id);
  assert.equal(persistedAfterShutdown?.view.status, 'running');
  assert.equal(persistedAfterShutdown?.view.cursorIndex, 1);

  // 3) Boot a brand-new BackgroundTaskRunner instance (server restart) and recover
  const runner2 = new BackgroundTaskRunner({
    probeStream: async (url) => {
      probeCallsByInstance.r2.push(url);
      return { ok: true, validationState: 'media_available', status: 200 };
    },
  });

  const recoveredCount = await runner2.recoverInterruptedTasks();
  assert.ok(recoveredCount >= 1);

  await waitUntil(async () => {
    const rec = await getInternalTaskById(taskCreated.task!.id);
    return rec?.view.status === 'completed';
  });

  const completedAfterRestart = await getInternalTaskById(taskCreated.task.id);
  assert.equal(completedAfterRestart?.view.processedItems, 3);
  assert.equal(completedAfterRestart?.view.cursorIndex, 3);

  // Item 1 was already completed before restart; runner2 must ONLY probe items 2 & 3!
  assert.equal(
    probeCallsByInstance.r2.some((u) => u.includes('/1.mp4')),
    false
  );
  assert.equal(probeCallsByInstance.r2.length, 2);

  // 4) Cancel test on a fresh task
  const cancelListId = `${TEST_RUN_TAG}-list-cancel`;
  createdListIds.add(cancelListId);
  await syncCatalogBatchToPostgres({
    list: {
      id: cancelListId,
      name: 'Lista Cancelar',
      sourceType: 'url',
      importedAt: Date.now(),
      totalEntries: 1,
      newItemsCreated: 1,
      mergedSourcesCount: 0,
      ignoredDuplicatesCount: 0,
    },
    items: [
      makeMovie({
        id: wCancel,
        title: 'Item Cancelar',
        sources: [
          {
            id: `${TEST_RUN_TAG}-sc1`,
            label: 'F1',
            url: `https://${TEST_RUN_TAG}-c.example.com/slow.mp4`,
            listId: cancelListId,
            status: 'pending',
          },
        ],
      }),
    ],
  });

  let cancelProbeStarted!: () => void;
  const waitCancelStart = new Promise<void>((r) => {
    cancelProbeStarted = r;
  });
  const runnerCancel = new BackgroundTaskRunner({
    probeStream: async (_url, _timeout, signal) => {
      cancelProbeStarted();
      return new Promise((_, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      });
    },
  });

  const cancelTaskRes = await createOrEnqueueProcessingTask({
    userUid: TEST_UID,
    scope: 'list',
    listId: cancelListId,
    listName: 'Lista Cancelar',
    settings: { batchSize: 1 },
  });
  assert.ok(cancelTaskRes.task);
  createdTaskIds.add(cancelTaskRes.task.id);
  await runnerCancel.kick(cancelTaskRes.task.id);
  await waitCancelStart;

  const cancelled = await runnerCancel.cancelTask(cancelTaskRes.task.id, TEST_UID);
  assert.equal(cancelled?.status, 'cancelled');
  assert.ok(cancelled?.finishedAt);

  await runner2.shutdown();
  await runnerCancel.shutdown();
});
