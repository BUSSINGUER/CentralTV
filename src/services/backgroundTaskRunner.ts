import {
  claimNextQueuedTaskInPostgres,
  getHydratedWorkByIdFromPostgres,
  getInternalTaskById,
  getInterruptedRunningTasks,
  getProcessingTaskExecutionState,
  saveProcessedWorkResultInPostgres,
  transitionProcessingTaskStatus,
  updateProcessingTaskProgressInPostgres,
  type InternalProcessingTaskRecord,
} from '../db/taskRepository.ts';
import type {
  CatalogItem,
  MediaSource,
  PlatformId,
  ProcessingTaskStage,
  ProcessingTaskView,
  SourceValidationState,
} from '../types/streaming.ts';

export interface ServerProbeResult {
  ok: boolean;
  validationState: SourceValidationState;
  status?: number;
  resolvedUrl?: string;
  mediaType?: string;
  latencyMs?: number;
  reason?: string;
}

export interface ServerTmdbEnrichResult {
  found?: boolean;
  missingKey?: boolean;
  error?: string;
  statusCode?: number;
  tmdbId?: number;
  title?: string;
  year?: number;
  synopsis?: string;
  voteAverage?: number;
  genres?: string[];
  cast?: string[];
  director?: string;
  duration?: string;
  durationSeconds?: number;
  posterImage?: string;
  backdropImage?: string;
  platform?: PlatformId | null;
  youtubeTrailerId?: string;
}

export interface ServerYoutubeSearchResult {
  videoId: string | null;
  title?: string;
  source?: string;
}

export interface BackgroundRunnerDeps {
  probeStream: (
    url: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<ServerProbeResult>;
  enrichTmdb: (params: {
    title: string;
    year?: number;
    type: string;
    tmdbApiKey?: string;
    signal?: AbortSignal;
  }) => Promise<ServerTmdbEnrichResult>;
  searchYoutube: (params: {
    query: string;
    youtubeApiKey?: string;
    signal?: AbortSignal;
  }) => Promise<ServerYoutubeSearchResult>;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string };
  return e.name === 'AbortError';
}

export class BackgroundTaskRunner {
  private readonly deps: BackgroundRunnerDeps;
  private activeControllers = new Map<string, AbortController>();
  private activeLoops = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(deps: BackgroundRunnerDeps) {
    this.deps = deps;
  }

  public isTaskActive(taskId: string): boolean {
    return this.activeLoops.has(taskId);
  }

  public async kick(taskId?: string): Promise<void> {
    if (this.shuttingDown) return;

    if (taskId) {
      const record = await getInternalTaskById(taskId);
      if (record && record.view.status === 'running') {
        this.ensureLoop(record);
        return;
      }
    }

    await this.drainQueue();
  }

  public async drainQueue(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.activeLoops.size > 0) return;

    const next = await claimNextQueuedTaskInPostgres();
    if (next && next.view.status === 'running') {
      this.ensureLoop(next);
    }
  }

  public async recoverInterruptedTasks(): Promise<number> {
    if (this.shuttingDown) return 0;
    try {
      const interrupted = await getInterruptedRunningTasks();
      for (const task of interrupted) {
        if (!this.shuttingDown) {
          this.ensureLoop(task);
        }
      }
      if (interrupted.length === 0) {
        await this.drainQueue();
      }
      return interrupted.length;
    } catch (err) {
      console.error('[BackgroundTaskRunner] Failed to recover interrupted tasks:', err);
      return 0;
    }
  }

  public async pauseTask(
    taskId: string,
    userUid?: string
  ): Promise<ProcessingTaskView | null> {
    const res = await transitionProcessingTaskStatus(taskId, 'pause', userUid);
    const ctrl = this.activeControllers.get(taskId);
    if (ctrl && !ctrl.signal.aborted) {
      ctrl.abort(new DOMException('Task paused', 'AbortError'));
    }
    const loop = this.activeLoops.get(taskId);
    if (loop) {
      await loop.catch(() => {});
    }
    await this.drainQueue();
    return res.task;
  }

  public async resumeTask(
    taskId: string,
    userUid?: string
  ): Promise<ProcessingTaskView | null> {
    const res = await transitionProcessingTaskStatus(taskId, 'resume', userUid);
    if (res.task?.status === 'running') {
      await this.kick(taskId);
    } else if (res.task?.status === 'queued') {
      await this.drainQueue();
    }
    return res.task;
  }

  public async cancelTask(
    taskId: string,
    userUid?: string
  ): Promise<ProcessingTaskView | null> {
    const res = await transitionProcessingTaskStatus(taskId, 'cancel', userUid);
    const ctrl = this.activeControllers.get(taskId);
    if (ctrl && !ctrl.signal.aborted) {
      ctrl.abort(new DOMException('Task cancelled', 'AbortError'));
    }
    const loop = this.activeLoops.get(taskId);
    if (loop) {
      await loop.catch(() => {});
    }
    await this.drainQueue();
    return res.task;
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const ctrl of this.activeControllers.values()) {
      if (!ctrl.signal.aborted) {
        ctrl.abort(new DOMException('Server shutting down', 'AbortError'));
      }
    }
    const loops = Array.from(this.activeLoops.values());
    if (loops.length > 0) {
      await Promise.allSettled(loops);
    }
  }

  private ensureLoop(record: InternalProcessingTaskRecord): void {
    const taskId = record.view.id;
    if (this.activeLoops.has(taskId) || this.shuttingDown) {
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(taskId, controller);

    const loopPromise = this.runTaskLoop(taskId, controller)
      .catch((err) => {
        console.error(`[BackgroundTaskRunner] Unhandled error in task ${taskId}:`, err);
      })
      .finally(() => {
        this.activeControllers.delete(taskId);
        this.activeLoops.delete(taskId);
        if (!this.shuttingDown) {
          void this.drainQueue();
        }
      });

    this.activeLoops.set(taskId, loopPromise);
  }

  private async runTaskLoop(
    taskId: string,
    controller: AbortController
  ): Promise<void> {
    let record = await getInternalTaskById(taskId);
    if (!record || record.view.status !== 'running') {
      return;
    }

    const targetIds = record.targetWorkIds;
    const settings = record.settings;
    const probeTimeoutMs = Math.min(
      Math.max(Number(settings.probeTimeoutMs || 6500), 1000),
      15000
    );
    const batchSize = Math.min(Math.max(Number(settings.batchSize || 2), 1), 8);

    let cursor = Math.max(0, record.view.cursorIndex || 0);
    let processedItems = record.view.processedItems || 0;
    let approvedCount = record.view.approvedCount || 0;
    let pendingBlockedCount = record.view.pendingBlockedCount || 0;
    let offlineCount = record.view.offlineCount || 0;
    let failedCount = record.view.failedCount || 0;
    let lastNote = record.view.lastNote;

    console.info(
      `[BackgroundTaskRunner] Starting ${taskId}: ${targetIds.length} items, cursor ${cursor}, concurrency ${batchSize}.`
    );

    if (cursor >= targetIds.length) {
      await updateProcessingTaskProgressInPostgres(taskId, {
        status: 'completed',
        currentStage: 'done',
        finishedAt: Date.now(),
      });
      return;
    }

    try {
      while (cursor < targetIds.length) {
        if (this.shuttingDown || controller.signal.aborted) {
          break;
        }

        // Verify persistent status before each slice in case another caller paused/cancelled
        const fresh = await getProcessingTaskExecutionState(taskId);
        if (!fresh || fresh.status !== 'running') {
          break;
        }

        const sliceIds = targetIds.slice(cursor, cursor + batchSize);
        type SliceOutcome = {
          outcome: 'approved' | 'pending_blocked' | 'offline' | 'failed' | 'skipped' | 'aborted';
          title?: string;
          note?: string;
        };

        const sliceOutcomes: Array<SliceOutcome | null> = new Array(
          sliceIds.length
        ).fill(null);

        await Promise.allSettled(
          sliceIds.map(async (workId, offset) => {
            if (this.shuttingDown || controller.signal.aborted) {
              sliceOutcomes[offset] = { outcome: 'aborted' };
              return;
            }

            const work = await getHydratedWorkByIdFromPostgres(workId);
            if (!work) {
              sliceOutcomes[offset] = { outcome: 'skipped' };
              return;
            }

            if (offset === 0) {
              await updateProcessingTaskProgressInPostgres(taskId, {
                currentWorkId: work.id,
                currentTitle: work.title,
                currentStage: 'health',
              }).catch(() => {});
            }

            try {
              const processed = await this.processSingleWork(
                work,
                {
                  probeTimeoutMs,
                  tmdbApiKey: settings.tmdbApiKey,
                  youtubeApiKey: settings.youtubeApiKey,
                },
                controller.signal,
                (stage, note) => {
                  if (offset === 0 && !controller.signal.aborted && !this.shuttingDown) {
                    void updateProcessingTaskProgressInPostgres(taskId, {
                      currentWorkId: work.id,
                      currentTitle: work.title,
                      currentStage: stage,
                      lastNote: note ?? lastNote ?? null,
                    }).catch(() => {});
                  }
                }
              );

              await saveProcessedWorkResultInPostgres(processed.item);

              const st = processed.item.status || 'pendente';
              const outcome: SliceOutcome['outcome'] =
                st === 'aprovado' || st === 'publicado'
                  ? 'approved'
                  : st === 'offline'
                    ? 'offline'
                    : 'pending_blocked';

              sliceOutcomes[offset] = {
                outcome,
                title: processed.item.title,
                note: processed.note || processed.item.lastError,
              };
            } catch (err) {
              if (isAbortLikeError(err) || controller.signal.aborted || this.shuttingDown) {
                sliceOutcomes[offset] = { outcome: 'aborted' };
                return;
              }
              const errMsg =
                err instanceof Error
                  ? err.message
                  : 'Erro inesperado ao processar item.';
              const errored: CatalogItem = {
                ...work,
                lastError: errMsg,
                updatedAt: Date.now(),
              };
              await saveProcessedWorkResultInPostgres(errored).catch(() => {});
              sliceOutcomes[offset] = {
                outcome: 'failed',
                title: work.title,
                note: `Falha em "${work.title}": ${errMsg}`,
              };
            }
          })
        );

        // Advance cursor strictly across contiguous non-aborted prefix so paused/restarted tasks never double-count or skip items
        let advanced = 0;
        let lastTitleInSlice = '';
        for (let k = 0; k < sliceOutcomes.length; k++) {
          const res = sliceOutcomes[k];
          if (!res || res.outcome === 'aborted') {
            break;
          }
          advanced += 1;
          processedItems += 1;
          if (res.title) lastTitleInSlice = res.title;
          if (res.note) lastNote = res.note;
          if (res.outcome === 'approved') approvedCount += 1;
          else if (res.outcome === 'pending_blocked') pendingBlockedCount += 1;
          else if (res.outcome === 'offline') offlineCount += 1;
          else if (res.outcome === 'failed') failedCount += 1;
        }

        cursor += advanced;

        if (advanced > 0) {
          await updateProcessingTaskProgressInPostgres(taskId, {
            cursorIndex: cursor,
            processedItems,
            approvedCount,
            pendingBlockedCount,
            offlineCount,
            failedCount,
            currentTitle: lastTitleInSlice || fresh.currentTitle,
            lastNote: lastNote ?? null,
          });
        }

        if (this.shuttingDown || controller.signal.aborted) {
          break;
        }
      }

      if (!this.shuttingDown && !controller.signal.aborted) {
        const finalCheck = await getInternalTaskById(taskId);
        if (finalCheck && finalCheck.view.status === 'running' && cursor >= targetIds.length) {
          await updateProcessingTaskProgressInPostgres(taskId, {
            status: 'completed',
            cursorIndex: targetIds.length,
            processedItems,
            approvedCount,
            pendingBlockedCount,
            offlineCount,
            failedCount,
            currentStage: 'done',
            lastNote: lastNote ?? null,
            finishedAt: Date.now(),
          });
          console.info(
            `[BackgroundTaskRunner] Completed ${taskId}: ${processedItems}/${targetIds.length} items.`
          );
        }
      }
    } catch (fatalErr) {
      if (!this.shuttingDown && !isAbortLikeError(fatalErr)) {
        const msg =
          fatalErr instanceof Error
            ? fatalErr.message
            : 'Erro fatal na execução em segundo plano.';
        await updateProcessingTaskProgressInPostgres(taskId, {
          status: 'failed',
          errorMessage: msg,
          currentStage: 'done',
          lastNote: msg,
          finishedAt: Date.now(),
        }).catch(() => {});
      }
    }
  }

  private async processSingleWork(
    item: CatalogItem,
    config: {
      probeTimeoutMs: number;
      tmdbApiKey?: string;
      youtubeApiKey?: string;
    },
    signal: AbortSignal,
    onStage: (stage: ProcessingTaskStage, note?: string) => void
  ): Promise<{ item: CatalogItem; note?: string }> {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    onStage('health');
    let updated = await this.runHealthCheck(item, config.probeTimeoutMs, signal);
    let note: string | undefined = updated.lastError;

    // Metadata and trailers are loaded lazily when a user opens the details page.

    return { item: updated, note };
  }

  private async runHealthCheck(
    item: CatalogItem,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<CatalogItem> {
    const sources = item.sources ?? [];

    // Series store stream links inside episodes[]; enrich TMDB/YouTube directly without probing all episodes
    if (item.type === 'series' && sources.length === 0) {
      const hasEpisodeSources = (item.episodes ?? []).some(
        (ep) => (ep.sources?.length ?? 0) > 0
      );
      if (hasEpisodeSources) {
        return {
          ...item,
          healthChecked: true,
          status: item.status === 'publicado' ? 'publicado' : 'aprovado',
          lastError: undefined,
          updatedAt: Date.now(),
        };
      }
    }

    if (sources.length === 0) {
      return {
        ...item,
        healthChecked: true,
        status: 'offline',
        lastError: 'Nenhuma fonte de URL cadastrada.',
        updatedAt: Date.now(),
      };
    }

    const checkedSources = await mapWithConcurrency(
      sources,
      3,
      async (src): Promise<MediaSource> => {
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const checkedAt = Date.now();
        const probe = await this.deps.probeStream(src.url, timeoutMs, signal);
        const vState: SourceValidationState =
          probe.validationState || (probe.ok ? 'media_available' : 'offline');

        const mappedStatus: MediaSource['status'] =
          vState === 'cors_blocked' || vState === 'proxy_blocked'
            ? 'pending'
            : vState === 'html_challenge'
              ? 'online'
              : probe.ok
                ? 'online'
                : 'offline';

        return {
          ...src,
          status: mappedStatus,
          validationState: vState,
          resolvedUrl:
            probe.resolvedUrl && probe.resolvedUrl !== src.url
              ? probe.resolvedUrl
              : src.resolvedUrl,
          detectedFormat:
            probe.mediaType && probe.mediaType !== 'unknown'
              ? probe.mediaType
              : src.detectedFormat,
          httpStatus: probe.status ?? src.httpStatus,
          latencyMs: probe.latencyMs ?? src.latencyMs,
          reason:
            probe.reason ||
            (probe.ok ? 'Stream ativo' : 'Stream indisponível / Timeout'),
          lastCheckedAt: checkedAt,
        };
      }
    );

    const hasOnline = checkedSources.some((s) => s.status === 'online');
    const hasBlockedNotOffline = checkedSources.some(
      (s) =>
        s.validationState === 'cors_blocked' ||
        s.validationState === 'proxy_blocked' ||
        s.validationState === 'html_challenge'
    );

    return {
      ...item,
      sources: checkedSources,
      healthChecked: true,
      status:
        item.status === 'publicado'
          ? 'publicado'
          : hasOnline
            ? 'aprovado'
            : hasBlockedNotOffline
              ? 'pendente'
              : 'offline',
      lastError: hasOnline
        ? undefined
        : hasBlockedNotOffline
          ? 'Fontes bloqueadas por CORS/Proxy/HTML — aguardando verificação na reprodução.'
          : 'Todas as fontes responderam offline.',
      updatedAt: Date.now(),
    };
  }

  private async runTmdbEnrich(
    item: CatalogItem,
    tmdbApiKey: string | undefined,
    signal: AbortSignal
  ): Promise<{ item: CatalogItem; note?: string }> {
    if (item.type === 'live' || item.type === 'radio') {
      return {
        item: { ...item, tmdbEnriched: true, updatedAt: Date.now() },
      };
    }
    if (item.tmdbEnriched && item.tmdbId) {
      return { item };
    }

    try {
      const data = await this.deps.enrichTmdb({
        title: item.title,
        year: item.year,
        type: item.type,
        tmdbApiKey,
        signal,
      });

      if (data.missingKey) {
        return {
          item: { ...item, updatedAt: Date.now() },
          note: 'TMDB API Key ausente — mantendo dados do M3U.',
        };
      }

      if (!data.found) {
        return {
          item: { ...item, tmdbEnriched: false, updatedAt: Date.now() },
          note: data.error || 'Título não encontrado no TMDB.',
        };
      }

      return {
        item: {
          ...item,
          tmdbId: data.tmdbId,
          title: data.title || item.title,
          year: data.year || item.year,
          synopsis: data.synopsis || item.synopsis,
          voteAverage: data.voteAverage ?? item.voteAverage,
          genres:
            data.genres && data.genres.length > 0 ? data.genres : item.genres,
          cast: data.cast && data.cast.length > 0 ? data.cast : item.cast,
          director: data.director || item.director,
          duration: data.duration || item.duration,
          durationSeconds: data.durationSeconds || item.durationSeconds,
          posterImage: data.posterImage || item.posterImage,
          backdropImage: data.backdropImage || item.backdropImage,
          platform: data.platform || item.platform,
          youtubeTrailerId: data.youtubeTrailerId || item.youtubeTrailerId,
          tmdbEnriched: true,
          updatedAt: Date.now(),
        },
      };
    } catch (err) {
      if (isAbortLikeError(err)) throw err;
      return {
        item,
        note: err instanceof Error ? err.message : 'Erro ao consultar TMDB.',
      };
    }
  }

  private async runYoutubeEnrich(
    item: CatalogItem,
    youtubeApiKey: string | undefined,
    signal: AbortSignal
  ): Promise<CatalogItem> {
    if (item.type === 'live' || item.type === 'radio') {
      return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
    }
    if (item.youtubeTrailerId) {
      return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
    }

    const query = `${item.title} ${item.year || ''} trailer oficial dublado`.trim();
    try {
      const data = await this.deps.searchYoutube({
        query,
        youtubeApiKey,
        signal,
      });
      if (data.videoId) {
        return {
          ...item,
          youtubeTrailerId: data.videoId,
          youtubeEnriched: true,
          updatedAt: Date.now(),
        };
      }
    } catch (err) {
      if (isAbortLikeError(err)) throw err;
    }

    return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
  }
}
