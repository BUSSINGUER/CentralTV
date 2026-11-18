import Hls from 'hls.js';
import { db } from '../db/database';
import {
  AppSettings,
  CatalogItem,
  MediaSource,
  PlatformId,
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
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol === 'https:' && url.startsWith('http://')) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    let settled = false;
    let hls: Hls | null = null;

    const cleanup = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
      video.load();
      resolve(ok);
    };

    const timer = window.setTimeout(
      () => cleanup(false),
      Math.min(timeoutMs, 4000)
    );

    if (url.toLowerCase().includes('.m3u8') && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, manifestLoadingTimeOut: 3500 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => cleanup(true));
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) cleanup(false);
      });
      hls.loadSource(url);
    } else {
      video.onloadedmetadata = () => cleanup(true);
      video.onerror = () => cleanup(false);
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
        latencyMs?: number;
        reason?: string;
      };
      return {
        ...source,
        status: data.ok ? 'online' : 'offline',
        latencyMs: data.latencyMs ?? Math.round(performance.now() - started),
        reason:
          data.reason ||
          (data.ok ? 'Stream ativo' : 'Stream indisponível / Timeout'),
        lastCheckedAt: checkedAt,
      };
    }
  } catch {
    // Fall through to browser metadata check only if backend endpoint is unreachable
  }

  const browserOk = await probeBrowserVideoMetadata(source.url, timeoutMs);
  return {
    ...source,
    status: browserOk ? 'online' : 'offline',
    latencyMs: Math.round(performance.now() - started),
    reason: browserOk ? 'Metadados carregados' : 'Stream indisponível / Timeout',
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

  return {
    ...item,
    sources: checkedSources,
    healthChecked: true,
    status: hasOnline ? 'aprovado' : 'offline',
    lastError: hasOnline ? undefined : 'Todas as fontes responderam offline.',
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
      await db.mediaItems.put({
        ...existing,
        youtubeTrailerId: enriched.youtubeTrailerId,
        youtubeEnriched: true,
        updatedAt: Date.now(),
      });
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
  onStage?.('done');
  return updated;
}
