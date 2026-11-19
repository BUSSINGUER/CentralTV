import Hls from 'hls.js';
import { db } from '../db/database';
import { syncCatalogItemsToServer } from './persistenceSync';
import {
  AppSettings,
  CatalogItem,
  MediaSource,
  PlatformId,
  SourceValidationState,
} from '../types/streaming';

export type PipelineStage = 'health' | 'tmdb' | 'youtube' | 'done';

export interface PipelineProgress {
  running: boolean;
  paused: boolean;
  processed: number;
  total: number;
  approved: number;
  pendingCors?: number;
  offline: number;
  failed?: number;
  currentTitle: string;
  currentStage: PipelineStage;
  lastNote?: string;
}

function createAbortError(): Error {
  const err = new Error('Operação cancelada pelo usuário.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  options?: { maxAttempts?: number; signal?: AbortSignal }
): Promise<{ ok: boolean; status: number; data: T | null; rawError?: string }> {
  const maxAttempts = options?.maxAttempts ?? 2;
  const signal = options?.signal;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    const resp = await fetch(url, { ...init, signal });
    const text = await resp.text();
    let parsed: T | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        parsed = null;
      }
    }

    const shouldRetry =
      attempt < maxAttempts &&
      (resp.status === 429 ||
        resp.status === 502 ||
        resp.status === 503 ||
        resp.status === 504);

    if (shouldRetry) {
      const retryAfterHeader = Number(resp.headers.get('retry-after') || '0');
      const delayMs =
        retryAfterHeader > 0
          ? Math.min(retryAfterHeader * 1000, 3000)
          : 700 * attempt;
      await abortableSleep(delayMs, signal);
      continue;
    }

    return {
      ok: resp.ok,
      status: resp.status,
      data: parsed,
      rawError: !resp.ok && !parsed ? text.slice(0, 200) : undefined,
    };
  }

  return { ok: false, status: 0, data: null };
}

async function probeBrowserVideoMetadata(
  url: string,
  timeoutMs: number
): Promise<{
  ok: boolean;
  validationState: SourceValidationState;
  reason?: string;
}> {
  if (typeof window === 'undefined') {
    return {
      ok: false,
      validationState: 'unverified',
      reason: 'Ambiente sem navegador para reprodução direta.',
    };
  }
  if (window.location.protocol === 'https:' && url.startsWith('http://')) {
    return {
      ok: false,
      validationState: 'cors_blocked',
      reason: 'Stream HTTP em página HTTPS (requer Proxy / servidor).',
    };
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    let settled = false;
    let hls: Hls | null = null;

    const cleanup = (
      ok: boolean,
      validationState: SourceValidationState,
      reason?: string
    ) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
      video.load();
      resolve({ ok, validationState, reason });
    };

    const timer = window.setTimeout(
      () => cleanup(false, 'cors_blocked', 'Timeout / bloqueio CORS no navegador'),
      Math.min(timeoutMs, 4000)
    );

    if (url.toLowerCase().includes('.m3u8') && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, manifestLoadingTimeOut: 3500 });
      hls.on(Hls.Events.MANIFEST_PARSED, () =>
        cleanup(true, 'playback_confirmed', 'Manifesto HLS carregado')
      );
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          const httpCode = data.response?.code;
          if (!httpCode && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            cleanup(false, 'cors_blocked', 'Bloqueio CORS/rede no navegador');
          } else {
            cleanup(
              false,
              httpCode === 403 ? 'proxy_blocked' : 'offline',
              `HLS erro ${httpCode || data.details}`
            );
          }
        }
      });
      hls.loadSource(url);
    } else {
      video.onloadedmetadata = () =>
        cleanup(true, 'playback_confirmed', 'Metadados carregados no navegador');
      video.onerror = () =>
        cleanup(false, 'cors_blocked', 'Navegador não conseguiu abrir diretamente');
      video.src = url;
    }
  });
}

export async function probeSingleSource(
  source: MediaSource,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<MediaSource> {
  throwIfAborted(signal);
  const checkedAt = Date.now();
  const started = performance.now();

  try {
    const resp = await fetch(
      `/api/check-stream?url=${encodeURIComponent(source.url)}&timeoutMs=${timeoutMs}`,
      { signal }
    );

    if (resp.ok) {
      const data = (await resp.json()) as {
        ok: boolean;
        validationState?: SourceValidationState;
        status?: number;
        resolvedUrl?: string;
        mediaType?: string;
        latencyMs?: number;
        reason?: string;
      };

      const vState: SourceValidationState =
        data.validationState ||
        (data.ok ? 'media_available' : 'offline');

      const mappedStatus: MediaSource['status'] =
        vState === 'cors_blocked' || vState === 'proxy_blocked'
          ? 'pending'
          : vState === 'html_challenge'
            ? 'online'
            : data.ok
              ? 'online'
              : 'offline';

      return {
        ...source,
        status: mappedStatus,
        validationState: vState,
        resolvedUrl:
          data.resolvedUrl && data.resolvedUrl !== source.url
            ? data.resolvedUrl
            : source.resolvedUrl,
        detectedFormat:
          data.mediaType && data.mediaType !== 'unknown'
            ? data.mediaType
            : source.detectedFormat,
        httpStatus: data.status ?? source.httpStatus,
        latencyMs: data.latencyMs ?? Math.round(performance.now() - started),
        reason:
          data.reason ||
          (data.ok ? 'Stream ativo' : 'Stream indisponível / Timeout'),
        lastCheckedAt: checkedAt,
      };
    }

    if (resp.status === 403) {
      return {
        ...source,
        status: 'pending',
        validationState: 'proxy_blocked',
        httpStatus: 403,
        latencyMs: Math.round(performance.now() - started),
        reason: 'Validação bloqueada pelo proxy/origem (HTTP 403)',
        lastCheckedAt: checkedAt,
      };
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw err;
    }
    // Fall through to browser metadata check only if backend endpoint is unreachable
  }

  throwIfAborted(signal);
  const browserRes = await probeBrowserVideoMetadata(source.url, timeoutMs);
  return {
    ...source,
    status: browserRes.ok
      ? 'online'
      : browserRes.validationState === 'cors_blocked' ||
          browserRes.validationState === 'proxy_blocked'
        ? 'pending'
        : 'offline',
    validationState: browserRes.validationState,
    latencyMs: Math.round(performance.now() - started),
    reason:
      browserRes.reason ||
      (browserRes.ok
        ? 'Metadados carregados'
        : 'Stream indisponível / Timeout'),
    lastCheckedAt: checkedAt,
  };
}

export async function runHealthCheckForItem(
  item: CatalogItem,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CatalogItem> {
  throwIfAborted(signal);
  const sources = item.sources ?? [];

  // Series store stream links inside episodes[]; enrich TMDB/YouTube directly without probing all episodes.
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

  const checkedSources = await mapWithConcurrency(sources, 3, (src) =>
    probeSingleSource(src, timeoutMs, signal)
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

export async function runTmdbEnrichmentForItem(
  item: CatalogItem,
  tmdbApiKey: string,
  signal?: AbortSignal
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
    const res = await fetchJsonWithRetry<{
      found?: boolean;
      missingKey?: boolean;
      error?: string;
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
    }>(
      '/api/tmdb/enrich',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.title,
          year: item.year,
          type: item.type,
          tmdbApiKey,
        }),
      },
      { maxAttempts: 2, signal }
    );

    const data = res.data || {};

    if (data.missingKey) {
      return {
        item: { ...item, updatedAt: Date.now() },
        note: 'TMDB API Key ausente — mantendo dados do M3U.',
      };
    }

    if (!res.ok || !data.found) {
      return {
        item: { ...item, tmdbEnriched: false, updatedAt: Date.now() },
        note:
          data.error ||
          res.rawError ||
          (res.status === 429
            ? 'Limite de requisições TMDB atingido (HTTP 429).'
            : 'Título não encontrado no TMDB.'),
      };
    }

    return {
      item: {
        ...item,
        tmdbId: data.tmdbId,
        title: data.title || item.title,
        year: data.year || item.year,
        synopsis: data.synopsis || item.synopsis,
        voteAverage: data.voteAverage,
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
    if ((err as Error)?.name === 'AbortError') throw err;
    return {
      item,
      note: err instanceof Error ? err.message : 'Erro ao consultar TMDB.',
    };
  }
}

export async function runYoutubeSearchForItem(
  item: CatalogItem,
  youtubeApiKey: string,
  signal?: AbortSignal
): Promise<CatalogItem> {
  if (item.type === 'live' || item.type === 'radio') {
    return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
  }

  if (item.youtubeTrailerId) {
    return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
  }

  const query = `${item.title} ${item.year || ''} trailer oficial dublado`.trim();
  try {
    const res = await fetchJsonWithRetry<{ videoId?: string | null }>(
      `/api/youtube/search?q=${encodeURIComponent(query)}`,
      {
        headers: youtubeApiKey ? { 'x-youtube-key': youtubeApiKey } : {},
      },
      { maxAttempts: 2, signal }
    );
    if (res.ok && res.data?.videoId) {
      return {
        ...item,
        youtubeTrailerId: res.data.videoId,
        youtubeEnriched: true,
        updatedAt: Date.now(),
      };
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    // Keep empty trailer ID cleanly
  }

  return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
}

/**
 * Fetches missing YouTube trailer on-demand when opening DetailsModal or Hero
 * and caches it in IndexedDB.
 */
export async function fetchAndCacheTrailerOnDemand(
  item: CatalogItem,
  youtubeApiKey: string
): Promise<string | null> {
  if (item.youtubeTrailerId) return item.youtubeTrailerId;
  if (item.type === 'live' || item.type === 'radio') return null;

  const enriched = await runYoutubeSearchForItem(item, youtubeApiKey);
  if (enriched.youtubeTrailerId) {
    const existing = await db.mediaItems.get(item.id);
    if (existing) {
      const updatedItem = {
        ...existing,
        youtubeTrailerId: enriched.youtubeTrailerId,
        youtubeEnriched: true,
        updatedAt: Date.now(),
      };
      await db.mediaItems.put(updatedItem);
      void syncCatalogItemsToServer([updatedItem]);
    }
    return enriched.youtubeTrailerId;
  }
  return null;
}

export async function processItemFullPipeline(
  item: CatalogItem,
  settings: AppSettings,
  onStage?: (stage: PipelineStage, note?: string) => void,
  options?: {
    signal?: AbortSignal;
    skipServerSync?: boolean;
  }
): Promise<CatalogItem> {
  const signal = options?.signal;
  throwIfAborted(signal);

  onStage?.('health');
  let updated = await runHealthCheckForItem(
    item,
    settings.probeTimeoutMs,
    signal
  );

  // Enrich both approved items (including series) and pendente items (e.g. CORS/Proxy/HTML blocked)
  if (updated.status !== 'offline') {
    throwIfAborted(signal);
    onStage?.('tmdb');
    const tmdbRes = await runTmdbEnrichmentForItem(
      updated,
      settings.tmdbApiKey,
      signal
    );
    updated = tmdbRes.item;

    throwIfAborted(signal);
    onStage?.('youtube', tmdbRes.note);
    updated = await runYoutubeSearchForItem(
      updated,
      settings.youtubeApiKey,
      signal
    );
  }

  await db.mediaItems.put(updated);
  if (!options?.skipServerSync) {
    await syncCatalogItemsToServer([updated]);
  }
  onStage?.('done', updated.lastError);
  return updated;
}
