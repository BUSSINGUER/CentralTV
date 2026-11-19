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
  offline: number;
  currentTitle: string;
  currentStage: PipelineStage;
  lastNote?: string;
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
  timeoutMs: number
): Promise<MediaSource> {
  const checkedAt = Date.now();
  const started = performance.now();

  try {
    const resp = await fetch(
      `/api/check-stream?url=${encodeURIComponent(source.url)}&timeoutMs=${timeoutMs}`
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
  } catch {
    // Fall through to browser metadata check only if backend endpoint is unreachable
  }

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
  timeoutMs: number
): Promise<CatalogItem> {
  const sources = item.sources ?? [];
  if (sources.length === 0) {
    return {
      ...item,
      healthChecked: true,
      status: 'offline',
      lastError: 'Nenhuma fonte de URL cadastrada.',
      updatedAt: Date.now(),
    };
  }

  const checkedSources = await Promise.all(
    sources.map((src) => probeSingleSource(src, timeoutMs))
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
    status: hasOnline ? 'aprovado' : hasBlockedNotOffline ? 'pendente' : 'offline',
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
  tmdbApiKey: string
): Promise<{ item: CatalogItem; note?: string }> {
  if (item.type === 'live' || item.type === 'radio') {
    return {
      item: { ...item, tmdbEnriched: true, updatedAt: Date.now() },
    };
  }

  try {
    const resp = await fetch('/api/tmdb/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: item.title,
        year: item.year,
        type: item.type,
        tmdbApiKey,
      }),
    });

    const data = (await resp.json()) as {
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
    };

    if (data.missingKey) {
      return {
        item: { ...item, updatedAt: Date.now() },
        note: 'TMDB API Key ausente — mantendo dados do M3U.',
      };
    }

    if (!resp.ok || !data.found) {
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
    return {
      item,
      note: err instanceof Error ? err.message : 'Erro ao consultar TMDB.',
    };
  }
}

export async function runYoutubeSearchForItem(
  item: CatalogItem,
  youtubeApiKey: string
): Promise<CatalogItem> {
  if (item.type === 'live' || item.type === 'radio') {
    return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
  }

  if (item.youtubeTrailerId) {
    return { ...item, youtubeEnriched: true, updatedAt: Date.now() };
  }

  const query = `${item.title} ${item.year || ''} trailer oficial dublado`.trim();
  try {
    const resp = await fetch(
      `/api/youtube/search?q=${encodeURIComponent(query)}`,
      {
        headers: youtubeApiKey ? { 'x-youtube-key': youtubeApiKey } : {},
      }
    );
    if (resp.ok) {
      const data = (await resp.json()) as { videoId?: string | null };
      if (data.videoId) {
        return {
          ...item,
          youtubeTrailerId: data.videoId,
          youtubeEnriched: true,
          updatedAt: Date.now(),
        };
      }
    }
  } catch {
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
  onStage?: (stage: PipelineStage, note?: string) => void
): Promise<CatalogItem> {
  onStage?.('health');
  let updated = await runHealthCheckForItem(item, settings.probeTimeoutMs);

  if (updated.status === 'aprovado') {
    onStage?.('tmdb');
    const tmdbRes = await runTmdbEnrichmentForItem(
      updated,
      settings.tmdbApiKey
    );
    updated = tmdbRes.item;

    onStage?.('youtube', tmdbRes.note);
    updated = await runYoutubeSearchForItem(updated, settings.youtubeApiKey);
  }

  await db.mediaItems.put(updated);
  void syncCatalogItemsToServer([updated]);
  onStage?.('done');
  return updated;
}
