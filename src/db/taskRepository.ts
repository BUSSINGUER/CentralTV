import crypto from 'crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  CatalogItem,
  MediaFormatBadge,
  MediaKind,
  MediaSource,
  PlatformId,
  ProcessingTaskScope,
  ProcessingTaskStage,
  ProcessingTaskStatus,
  ProcessingTaskView,
  PublishStatus,
  SeriesEpisode,
  SourceValidationState,
} from '../types/streaming.ts';
import { sortAndRelabelSourcesList } from '../utils/identity.ts';
import { pgDb, withCatalogWrite } from './index.ts';
import {
  episodes,
  processingTasks,
  sourceAvailability,
  sources,
  workMetadata,
  works,
} from './schema.ts';

export interface ProcessingTaskSettingsSnapshot {
  tmdbApiKey?: string;
  youtubeApiKey?: string;
  batchSize?: number;
  probeTimeoutMs?: number;
}

export interface InternalProcessingTaskRecord {
  view: ProcessingTaskView;
  userUid: string;
  targetWorkIds: string[];
  settings: ProcessingTaskSettingsSnapshot;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toProcessingTaskView(
  row: typeof processingTasks.$inferSelect
): ProcessingTaskView {
  return {
    id: row.id,
    scope: row.scope as ProcessingTaskScope,
    listId: row.listId ?? undefined,
    listName: row.listName ?? undefined,
    status: row.status as ProcessingTaskStatus,
    dedupeKey: row.dedupeKey,
    cursorIndex: row.cursorIndex,
    totalItems: row.totalItems,
    processedItems: row.processedItems,
    approvedCount: row.approvedCount,
    pendingBlockedCount: row.pendingBlockedCount,
    offlineCount: row.offlineCount,
    failedCount: row.failedCount,
    currentWorkId: row.currentWorkId ?? undefined,
    currentTitle: row.currentTitle,
    currentStage: (row.currentStage || 'health') as ProcessingTaskStage,
    lastNote: row.lastNote ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt ?? undefined,
  };
}

function toInternalRecord(
  row: typeof processingTasks.$inferSelect
): InternalProcessingTaskRecord {
  return {
    view: toProcessingTaskView(row),
    userUid: row.userUid,
    targetWorkIds: safeJsonParse<string[]>(row.targetWorkIdsJson, []),
    settings: safeJsonParse<ProcessingTaskSettingsSnapshot>(row.settingsJson, {}),
  };
}

export async function createOrEnqueueProcessingTask(params: {
  userUid: string;
  scope: ProcessingTaskScope;
  listId?: string;
  listName?: string;
  settings?: ProcessingTaskSettingsSnapshot;
}): Promise<{
  task: ProcessingTaskView | null;
  deduplicated: boolean;
  queued: boolean;
  empty?: boolean;
}> {
  const now = Date.now();
  const normalizedListId =
    params.scope === 'list' && params.listId ? params.listId.trim() : undefined;
  const dedupeKey =
    params.scope === 'list' && normalizedListId
      ? `list:${normalizedListId}`
      : 'all_pending';

  try {
    return await withCatalogWrite(async (tx) => {
      const openRows = await tx
        .select()
        .from(processingTasks)
        .where(inArray(processingTasks.status, ['queued', 'running', 'paused']))
        .orderBy(asc(processingTasks.createdAt));

      const duplicateOpen = openRows.find((r) => r.dedupeKey === dedupeKey);
      if (duplicateOpen) {
        return {
          task: toProcessingTaskView(duplicateOpen),
          deduplicated: true,
          queued: duplicateOpen.status === 'queued',
        };
      }

      let candidateWorks: Array<{ id: string; title: string; status: string }> = [];

      if (params.scope === 'list' && normalizedListId) {
        const listSourceRows = await tx
          .select({ workId: sources.workId })
          .from(sources)
          .where(eq(sources.listId, normalizedListId));
        const workIdSet = Array.from(new Set(listSourceRows.map((s) => s.workId)));
        if (workIdSet.length > 0) {
          const allListWorks = await tx
            .select({
              id: works.id,
              title: works.title,
              status: works.status,
              archived: works.archived,
              createdAt: works.createdAt,
            })
            .from(works)
            .where(inArray(works.id, workIdSet))
            .orderBy(desc(works.createdAt));

          const activeListWorks = allListWorks.filter((w) => !w.archived);
          const pendingListWorks = activeListWorks.filter(
            (w) => w.status === 'pendente'
          );
          candidateWorks =
            pendingListWorks.length > 0
              ? pendingListWorks
              : activeListWorks.filter((w) => w.status !== 'publicado');
        }
      } else {
        candidateWorks = await tx
          .select({
            id: works.id,
            title: works.title,
            status: works.status,
          })
          .from(works)
          .where(and(eq(works.archived, false), eq(works.status, 'pendente')))
          .orderBy(desc(works.createdAt));
      }

      if (candidateWorks.length === 0) {
        return {
          task: null,
          deduplicated: false,
          queued: false,
          empty: true,
        };
      }

      const hasRunningTask = openRows.some((r) => r.status === 'running');
      const status: ProcessingTaskStatus = hasRunningTask ? 'queued' : 'running';
      const taskId = `task-${now}-${crypto.randomUUID().slice(0, 8)}`;

      const [inserted] = await tx
        .insert(processingTasks)
        .values({
          id: taskId,
          userUid: params.userUid,
          scope: params.scope,
          listId: normalizedListId ?? null,
          listName: params.listName ?? null,
          status,
          dedupeKey,
          targetWorkIdsJson: JSON.stringify(candidateWorks.map((w) => w.id)),
          cursorIndex: 0,
          totalItems: candidateWorks.length,
          processedItems: 0,
          approvedCount: 0,
          pendingBlockedCount: 0,
          offlineCount: 0,
          failedCount: 0,
          currentWorkId: candidateWorks[0].id,
          currentTitle: candidateWorks[0].title,
          currentStage: 'health',
          lastNote: hasRunningTask
            ? 'Enfileirada automaticamente após tarefa em andamento.'
            : null,
          settingsJson: JSON.stringify(params.settings || {}),
          errorMessage: null,
          createdAt: now,
          startedAt: hasRunningTask ? null : now,
          updatedAt: now,
          finishedAt: null,
        })
        .returning();

      return {
        task: toProcessingTaskView(inserted),
        deduplicated: false,
        queued: hasRunningTask,
      };
    });
  } catch (error) {
    console.error('Failed to create/enqueue processing task:', error);
    throw new Error('Falha ao criar tarefa de processamento em segundo plano.', {
      cause: error,
    });
  }
}

export async function listProcessingTasksFromPostgres(
  userUid?: string,
  limit = 25
): Promise<ProcessingTaskView[]> {
  try {
    const query = userUid
      ? pgDb
          .select()
          .from(processingTasks)
          .where(eq(processingTasks.userUid, userUid))
          .orderBy(desc(processingTasks.createdAt))
          .limit(limit)
      : pgDb
          .select()
          .from(processingTasks)
          .orderBy(desc(processingTasks.createdAt))
          .limit(limit);

    const rows = await query;
    const priority = (s: string) =>
      s === 'running' ? 0 : s === 'paused' ? 1 : s === 'queued' ? 2 : 3;

    return rows
      .sort((a, b) => {
        const diff = priority(a.status) - priority(b.status);
        if (diff !== 0) return diff;
        return b.updatedAt - a.updatedAt;
      })
      .map(toProcessingTaskView);
  } catch (error) {
    console.error('Failed to list processing tasks:', error);
    throw new Error('Falha ao listar tarefas em segundo plano.', { cause: error });
  }
}

export async function getInternalTaskById(
  taskId: string
): Promise<InternalProcessingTaskRecord | null> {
  try {
    const rows = await pgDb
      .select()
      .from(processingTasks)
      .where(eq(processingTasks.id, taskId))
      .limit(1);
    return rows[0] ? toInternalRecord(rows[0]) : null;
  } catch (error) {
    console.error('Failed to load internal task:', error);
    throw new Error('Falha ao carregar tarefa persistente.', { cause: error });
  }
}

/**
 * Reads only the mutable execution fields used by the runner's checkpoint loop.
 * Do not use getInternalTaskById for this check: it deserializes the complete
 * target ID snapshot, which can contain tens of thousands of IDs.
 */
export async function getProcessingTaskExecutionState(
  taskId: string
): Promise<Pick<ProcessingTaskView, 'status' | 'currentTitle'> | null> {
  try {
    const rows = await pgDb
      .select({
        status: processingTasks.status,
        currentTitle: processingTasks.currentTitle,
      })
      .from(processingTasks)
      .where(eq(processingTasks.id, taskId))
      .limit(1);
    if (!rows[0]) return null;
    return {
      status: rows[0].status as ProcessingTaskStatus,
      currentTitle: rows[0].currentTitle,
    };
  } catch (error) {
    console.error('Failed to load processing task execution state:', error);
    throw new Error('Falha ao consultar estado da tarefa.', { cause: error });
  }
}

export async function getInterruptedRunningTasks(): Promise<
  InternalProcessingTaskRecord[]
> {
  try {
    const rows = await pgDb
      .select()
      .from(processingTasks)
      .where(eq(processingTasks.status, 'running'))
      .orderBy(asc(processingTasks.createdAt));
    return rows.map(toInternalRecord);
  } catch (error) {
    console.error('Failed to query interrupted running tasks:', error);
    throw new Error('Falha ao consultar tarefas interrompidas.', { cause: error });
  }
}

export async function claimNextQueuedTaskInPostgres(): Promise<InternalProcessingTaskRecord | null> {
  const now = Date.now();
  try {
    return await pgDb.transaction(async (tx) => {
      const running = await tx
        .select()
        .from(processingTasks)
        .where(eq(processingTasks.status, 'running'))
        .limit(1);

      if (running.length > 0) {
        return toInternalRecord(running[0]);
      }

      const queued = await tx
        .select()
        .from(processingTasks)
        .where(eq(processingTasks.status, 'queued'))
        .orderBy(asc(processingTasks.createdAt))
        .limit(1);

      if (queued.length === 0) {
        return null;
      }

      const [updated] = await tx
        .update(processingTasks)
        .set({
          status: 'running',
          startedAt: queued[0].startedAt ?? now,
          updatedAt: now,
          lastNote: null,
        })
        .where(eq(processingTasks.id, queued[0].id))
        .returning();

      return toInternalRecord(updated);
    });
  } catch (error) {
    console.error('Failed to claim next queued task:', error);
    throw new Error('Falha ao promover próxima tarefa da fila.', { cause: error });
  }
}

export async function updateProcessingTaskProgressInPostgres(
  taskId: string,
  patch: Partial<{
    status: ProcessingTaskStatus;
    cursorIndex: number;
    processedItems: number;
    approvedCount: number;
    pendingBlockedCount: number;
    offlineCount: number;
    failedCount: number;
    currentWorkId: string | null;
    currentTitle: string;
    currentStage: ProcessingTaskStage;
    lastNote: string | null;
    errorMessage: string | null;
    finishedAt: number | null;
  }>
): Promise<ProcessingTaskView | null> {
  try {
    const [updated] = await pgDb
      .update(processingTasks)
      .set({
        ...patch,
        updatedAt: Date.now(),
      })
      .where(eq(processingTasks.id, taskId))
      .returning();
    return updated ? toProcessingTaskView(updated) : null;
  } catch (error) {
    console.error('Failed to update processing task progress:', error);
    throw new Error('Falha ao salvar progresso da tarefa.', { cause: error });
  }
}

export async function transitionProcessingTaskStatus(
  taskId: string,
  action: 'pause' | 'resume' | 'cancel',
  userUid?: string
): Promise<{ task: ProcessingTaskView | null; startedImmediate?: boolean }> {
  const now = Date.now();
  try {
    return await pgDb.transaction(async (tx) => {
      const found = await tx
        .select()
        .from(processingTasks)
        .where(eq(processingTasks.id, taskId))
        .limit(1);

      if (found.length === 0) {
        return { task: null };
      }

      const current = found[0];
      if (userUid && current.userUid !== userUid) {
        throw new Error('Permissão negada para controlar esta tarefa.');
      }

      if (action === 'pause') {
        if (current.status !== 'running' && current.status !== 'queued') {
          return { task: toProcessingTaskView(current) };
        }
        const [updated] = await tx
          .update(processingTasks)
          .set({
            status: 'paused',
            lastNote: `Pausada em ${current.processedItems}/${current.totalItems} itens.`,
            updatedAt: now,
          })
          .where(eq(processingTasks.id, taskId))
          .returning();
        return { task: toProcessingTaskView(updated), startedImmediate: false };
      }

      if (action === 'resume') {
        if (
          current.status === 'completed' ||
          current.status === 'cancelled' ||
          current.status === 'failed'
        ) {
          return { task: toProcessingTaskView(current) };
        }
        const otherRunning = await tx
          .select({ id: processingTasks.id })
          .from(processingTasks)
          .where(eq(processingTasks.status, 'running'));
        const hasOtherRunning = otherRunning.some((r) => r.id !== taskId);
        const nextStatus: ProcessingTaskStatus = hasOtherRunning
          ? 'queued'
          : 'running';
        const [updated] = await tx
          .update(processingTasks)
          .set({
            status: nextStatus,
            startedAt: current.startedAt ?? (hasOtherRunning ? null : now),
            lastNote: hasOtherRunning
              ? 'Retomada na fila aguardando tarefa ativa.'
              : 'Retomando do último item salvo.',
            updatedAt: now,
          })
          .where(eq(processingTasks.id, taskId))
          .returning();
        return {
          task: toProcessingTaskView(updated),
          startedImmediate: !hasOtherRunning,
        };
      }

      // cancel
      if (current.status === 'completed' || current.status === 'cancelled') {
        return { task: toProcessingTaskView(current) };
      }
      const [updated] = await tx
        .update(processingTasks)
        .set({
          status: 'cancelled',
          currentStage: 'done',
          lastNote: `Cancelada pelo usuário (${current.processedItems}/${current.totalItems} concluídos).`,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(processingTasks.id, taskId))
        .returning();
      return { task: toProcessingTaskView(updated) };
    });
  } catch (error) {
    console.error('Failed to transition processing task:', error);
    throw new Error(
      error instanceof Error ? error.message : 'Falha ao atualizar status da tarefa.',
      { cause: error }
    );
  }
}

export async function getHydratedWorkByIdFromPostgres(
  workId: string
): Promise<CatalogItem | null> {
  try {
    const workRows = await pgDb
      .select()
      .from(works)
      .where(eq(works.id, workId))
      .limit(1);
    const w = workRows[0];
    if (!w) return null;

    const [metaRows, epRows, srcRows] = await Promise.all([
      pgDb
        .select()
        .from(workMetadata)
        .where(eq(workMetadata.workId, workId))
        .limit(1),
      pgDb.select().from(episodes).where(eq(episodes.workId, workId)),
      pgDb.select().from(sources).where(eq(sources.workId, workId)),
    ]);

    const srcIds = srcRows.map((s) => s.id);
    const availRows =
      srcIds.length > 0
        ? await pgDb
            .select()
            .from(sourceAvailability)
            .where(inArray(sourceAvailability.sourceId, srcIds))
        : [];

    const meta = metaRows[0];
    const availBySrc = new Map(availRows.map((a) => [a.sourceId, a]));

    const toMediaSource = (s: typeof sources.$inferSelect): MediaSource => {
      const avail = availBySrc.get(s.id);
      return {
        id: s.id,
        label: s.label,
        qualityTag: s.qualityTag ?? undefined,
        resolutionTag: s.resolutionTag ?? undefined,
        languageTag: s.languageTag ?? undefined,
        originalName: s.originalName ?? undefined,
        url: s.url,
        resolvedUrl: s.resolvedUrl ?? undefined,
        detectedFormat: s.detectedFormat ?? undefined,
        listId: s.listId ?? undefined,
        groupTitle: s.groupTitle ?? undefined,
        tvgId: s.tvgId ?? undefined,
        status: (avail?.status as MediaSource['status']) || 'pending',
        validationState:
          (avail?.validationState as SourceValidationState) || 'unverified',
        httpStatus: avail?.httpStatus ?? undefined,
        latencyMs: avail?.latencyMs ?? undefined,
        reason: avail?.reason ?? undefined,
        lastCheckedAt: avail?.lastCheckedAt ?? undefined,
      };
    };

    const rootSources = sortAndRelabelSourcesList(
      srcRows.filter((s) => !s.episodeId).map(toMediaSource)
    );

    const epSourcesMap = new Map<string, MediaSource[]>();
    for (const s of srcRows) {
      if (s.episodeId) {
        const list = epSourcesMap.get(s.episodeId) || [];
        list.push(toMediaSource(s));
        epSourcesMap.set(s.episodeId, list);
      }
    }

    const hydratedEpisodes: SeriesEpisode[] | undefined =
      w.type === 'series'
        ? epRows
            .sort((a, b) =>
              a.seasonNumber !== b.seasonNumber
                ? a.seasonNumber - b.seasonNumber
                : a.episodeNumber - b.episodeNumber
            )
            .map((ep) => ({
              id: ep.externalEpisodeId,
              season: ep.seasonNumber,
              episode: ep.episodeNumber,
              title: ep.title,
              duration: ep.duration ?? undefined,
              synopsis: ep.synopsis ?? undefined,
              sources: sortAndRelabelSourcesList(epSourcesMap.get(ep.id) || []),
            }))
        : undefined;

    return {
      id: w.id,
      title: w.title,
      stylizedSubtitle: w.stylizedSubtitle ?? undefined,
      type: w.type as MediaKind,
      mediaKind: w.type as MediaKind,
      year: w.year ?? new Date().getFullYear(),
      genres: safeJsonParse<string[]>(meta?.genresJson, [w.type.toUpperCase()]),
      ageRating: (meta?.ageRating as CatalogItem['ageRating']) || '14',
      duration:
        meta?.duration || (w.type === 'series' ? '1 Temporada' : '2h 00min'),
      durationSeconds:
        meta?.durationSeconds ?? (w.type === 'series' ? 3000 : 7200),
      platform: (meta?.platform as PlatformId) || 'netflix',
      qualityBadge: (meta?.qualityBadge as MediaFormatBadge) || undefined,
      synopsis: meta?.synopsis || '',
      cast: safeJsonParse<string[]>(meta?.castJson, []),
      director: meta?.director || '',
      youtubeTrailerId: meta?.youtubeTrailerId || '',
      posterImage: meta?.posterImage || '',
      backdropImage: meta?.backdropImage || '',
      accentColor: meta?.accentColor ?? undefined,
      featuredInHero: w.featuredInHero,
      top10Rank: w.top10Rank ?? undefined,
      categories: safeJsonParse<string[]>(w.categoriesJson, ['populares']),
      normalizedKey: w.provisionalKey,
      originalTitle: w.originalTitle ?? undefined,
      tvgId: w.tvgId ?? undefined,
      tvgName: w.tvgName ?? undefined,
      groupTitle: w.groupTitle ?? undefined,
      tvgLogo: meta?.tvgLogo ?? undefined,
      voteAverage: meta?.voteAverage ?? undefined,
      tmdbId: w.tmdbId ?? undefined,
      sources: rootSources,
      episodes: hydratedEpisodes,
      status: w.status as PublishStatus,
      healthChecked: w.healthChecked,
      tmdbEnriched: meta?.tmdbEnriched ?? false,
      youtubeEnriched: meta?.youtubeEnriched ?? false,
      lastError: w.lastError ?? undefined,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      archived: w.archived,
    };
  } catch (error) {
    console.error('Failed to load hydrated work by id:', error);
    throw new Error('Falha ao carregar obra para processamento.', {
      cause: error,
    });
  }
}

export async function saveProcessedWorkResultInPostgres(
  item: CatalogItem,
  previousStatus: PublishStatus
): Promise<PublishStatus | null> {
  const now = Date.now();
  try {
    return await withCatalogWrite(async (tx) => {
      const [updated] = await tx
        .update(works)
        .set({
          status: sql`case when ${works.status} = ${previousStatus}
            then ${item.status || 'pendente'} else ${works.status} end`,
          healthChecked: Boolean(item.healthChecked),
          lastError: item.lastError ?? null,
          updatedAt: now,
        })
        .where(and(eq(works.id, item.id), eq(works.archived, false)))
        .returning({ status: works.status });
      if (!updated) return null;

      for (const src of item.sources || []) {
        const [source] = await tx
          .update(sources)
          .set({
            resolvedUrl: src.resolvedUrl ?? null,
            detectedFormat: src.detectedFormat ?? null,
            updatedAt: now,
          })
          .where(and(eq(sources.id, src.id), eq(sources.workId, item.id)))
          .returning({ id: sources.id });
        if (!source) continue;

        const existingAvail = await tx
          .select({ sourceId: sourceAvailability.sourceId })
          .from(sourceAvailability)
          .where(eq(sourceAvailability.sourceId, src.id))
          .limit(1);

        if (existingAvail.length === 0) {
          await tx.insert(sourceAvailability).values({
            sourceId: src.id,
            status: src.status || 'pending',
            validationState: src.validationState || 'unverified',
            httpStatus: src.httpStatus ?? null,
            latencyMs: src.latencyMs ?? null,
            reason: src.reason ?? null,
            lastCheckedAt: src.lastCheckedAt ?? now,
            updatedAt: now,
          });
        } else {
          await tx
            .update(sourceAvailability)
            .set({
              status: src.status || 'pending',
              validationState: src.validationState || 'unverified',
              httpStatus: src.httpStatus ?? null,
              latencyMs: src.latencyMs ?? null,
              reason: src.reason ?? null,
              lastCheckedAt: src.lastCheckedAt ?? now,
              updatedAt: now,
            })
            .where(eq(sourceAvailability.sourceId, src.id));
        }
      }
      return updated.status as PublishStatus;
    });
  } catch (error) {
    console.error('Failed to persist processed work result:', error);
    throw new Error('Falha ao salvar resultado do processamento da obra.', {
      cause: error,
    });
  }
}
