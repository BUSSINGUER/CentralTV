import { db, getUserLibrary, saveUserLibrary } from '../db/database';
import {
  dismissHistoryOnServer,
  syncWatchHistoryRecordToServer,
} from './persistenceSync';
import {
  CatalogItem,
  ContinueWatchingEntry,
  MediaSource,
  SeriesEpisode,
  WatchHistoryRecord,
} from '../types/streaming';

export const MIN_RESUME_SECONDS = 10;
export const COMPLETED_PROGRESS_THRESHOLD = 92;
const LS_HISTORY_KEY = 'aura_watch_history_v1';

export interface SaveWatchProgressPayload {
  itemId: string;
  type: 'movie' | 'series';
  season?: number;
  episodeNumber?: number;
  episodeId?: string;
  episodeTitle?: string;
  episodeLabel?: string;
  currentTime: number;
  duration: number;
  selectedSourceId?: string;
  selectedSourceLabel?: string;
  selectedSourceUrl?: string;
  updatedAt?: number;
}

export interface ResumePoint {
  currentTime: number;
  duration: number;
  progressPercent: number;
  selectedSourceId?: string;
  selectedSourceLabel?: string;
  selectedSourceUrl?: string;
}

export function buildWatchHistoryKey(
  itemId: string,
  type: 'movie' | 'series',
  season?: number,
  episodeNumber?: number,
  episodeId?: string
): string {
  if (type === 'movie') {
    return `movie:${itemId}`;
  }
  if (typeof season === 'number' && typeof episodeNumber === 'number') {
    return `series:${itemId}:S${season}:E${episodeNumber}`;
  }
  if (episodeId) {
    return `series:${itemId}:EP:${episodeId}`;
  }
  return `series:${itemId}:S1:E1`;
}

export function parseEpisodeTagFromLabel(
  label?: string
): { season?: number; episodeNumber?: number; title?: string } {
  if (!label) return {};
  const match = label.match(/T(\d+)\s*:\s*E(\d+)(?:\s*·\s*(.+))?/i);
  if (!match) return {};
  return {
    season: Number(match[1]),
    episodeNumber: Number(match[2]),
    title: match[3]?.trim() || undefined,
  };
}

export function formatRemainingTime(
  currentTime: number,
  duration: number
): string {
  if (!duration || duration <= 0) return '';
  const remainingSec = Math.max(0, duration - currentTime);
  const remainingMins = Math.max(1, Math.round(remainingSec / 60));
  if (remainingMins >= 60) {
    const hrs = Math.floor(remainingMins / 60);
    const mins = remainingMins % 60;
    return mins > 0 ? `${hrs}h ${mins}min restantes` : `${hrs}h restantes`;
  }
  return `${remainingMins} min restantes`;
}

function readLocalMirror(): WatchHistoryRecord[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(LS_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WatchHistoryRecord[]) : [];
  } catch {
    return [];
  }
}

function writeLocalMirror(records: WatchHistoryRecord[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(records));
  } catch {
    // Ignore storage quota errors
  }
}

export async function getAllWatchHistory(): Promise<WatchHistoryRecord[]> {
  try {
    const rows = await db.watchHistory.orderBy('updatedAt').reverse().toArray();
    if (rows.length > 0) {
      writeLocalMirror(rows);
      return rows;
    }
    const localRows = readLocalMirror();
    if (localRows.length > 0) {
      await db.watchHistory.bulkPut(localRows);
      return [...localRows].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return [];
  } catch {
    return readLocalMirror().sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export async function saveWatchProgress(
  payload: SaveWatchProgressPayload
): Promise<WatchHistoryRecord> {
  const safeDuration = Math.max(0, Math.round(payload.duration));
  const safeCurrent = Math.max(0, Math.min(safeDuration || payload.currentTime, Math.round(payload.currentTime)));
  const rawPct = safeDuration > 0 ? (safeCurrent / safeDuration) * 100 : 0;
  const completed = rawPct > COMPLETED_PROGRESS_THRESHOLD;
  const progressPercent = completed
    ? 100
    : Math.max(0, Math.min(99, Math.round(rawPct)));

  const parsedTag = parseEpisodeTagFromLabel(payload.episodeLabel);
  const season = payload.season ?? parsedTag.season;
  const episodeNumber = payload.episodeNumber ?? parsedTag.episodeNumber;
  const episodeTitle = payload.episodeTitle ?? parsedTag.title;

  const computedLabel =
    payload.episodeLabel ||
    (payload.type === 'series'
      ? `T${season || 1}:E${episodeNumber || 1}${episodeTitle ? ` · ${episodeTitle}` : ''}`
      : 'Filme');

  const id = buildWatchHistoryKey(
    payload.itemId,
    payload.type,
    season,
    episodeNumber,
    payload.episodeId
  );

  const record: WatchHistoryRecord = {
    id,
    itemId: payload.itemId,
    type: payload.type,
    season,
    episodeNumber,
    episodeId: payload.episodeId,
    episodeTitle,
    episodeLabel: computedLabel,
    currentTime: safeCurrent,
    duration: safeDuration,
    progressPercent,
    completed,
    selectedSourceId: payload.selectedSourceId,
    selectedSourceLabel: payload.selectedSourceLabel,
    selectedSourceUrl: payload.selectedSourceUrl,
    updatedAt: payload.updatedAt ?? Date.now(),
    dismissedFromContinue: false,
  };

  try {
    await db.watchHistory.put(record);
    const all = await db.watchHistory.orderBy('updatedAt').reverse().toArray();
    writeLocalMirror(all);
  } catch {
    const mirror = readLocalMirror().filter((r) => r.id !== record.id);
    writeLocalMirror([record, ...mirror]);
  }

  void syncWatchHistoryRecordToServer(record);
  return record;
}

export async function dismissFromContinueWatching(itemId: string): Promise<void> {
  try {
    const records = await db.watchHistory.where('itemId').equals(itemId).toArray();
    if (records.length > 0) {
      await db.watchHistory.bulkPut(
        records.map((r) => ({ ...r, dismissedFromContinue: true }))
      );
      const all = await db.watchHistory.orderBy('updatedAt').reverse().toArray();
      writeLocalMirror(all);
    } else {
      const mirror = readLocalMirror().map((r) =>
        r.itemId === itemId ? { ...r, dismissedFromContinue: true } : r
      );
      writeLocalMirror(mirror);
    }

    const lib = await getUserLibrary();
    const dismissedIds = Array.from(
      new Set([...(lib.dismissedContinueIds || []), itemId])
    );
    const nextContinue = (lib.continueWatching || []).filter(
      (c) => c.itemId !== itemId
    );
    await saveUserLibrary({
      continueWatching: nextContinue,
      dismissedContinueIds: dismissedIds,
    });
    void dismissHistoryOnServer(itemId);
  } catch {
    // Ignore errors on dismissal
  }
}

export function findEpisodeHistoryRecord(
  history: WatchHistoryRecord[],
  itemId: string,
  episode: Pick<SeriesEpisode, 'id' | 'season' | 'episode'>
): WatchHistoryRecord | undefined {
  const s = episode.season || 1;
  const e = episode.episode;
  return history.find(
    (rec) =>
      rec.itemId === itemId &&
      rec.type === 'series' &&
      ((episode.id && rec.episodeId === episode.id) ||
        (rec.season === s && rec.episodeNumber === e))
  );
}

export function getLatestItemHistory(
  history: WatchHistoryRecord[],
  itemId: string
): WatchHistoryRecord | undefined {
  return history
    .filter((rec) => rec.itemId === itemId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function getResumePointFromHistory(
  history: WatchHistoryRecord[],
  item: CatalogItem,
  opts?: {
    season?: number;
    episodeNumber?: number;
    episodeId?: string;
    episodeLabel?: string;
  }
): ResumePoint | null {
  let rec: WatchHistoryRecord | undefined;

  if (item.type === 'movie') {
    rec = history.find((r) => r.itemId === item.id && r.type === 'movie');
  } else if (item.type === 'series') {
    const parsed = parseEpisodeTagFromLabel(opts?.episodeLabel);
    const targetSeason = opts?.season ?? parsed.season;
    const targetEpisode = opts?.episodeNumber ?? parsed.episodeNumber;

    if (opts?.episodeId || (targetSeason && targetEpisode)) {
      rec = history.find(
        (r) =>
          r.itemId === item.id &&
          r.type === 'series' &&
          ((opts?.episodeId && r.episodeId === opts.episodeId) ||
            (targetSeason &&
              targetEpisode &&
              r.season === targetSeason &&
              r.episodeNumber === targetEpisode))
      );
    } else {
      rec = getLatestItemHistory(history, item.id);
    }
  }

  if (!rec || rec.completed || rec.duration <= 0) return null;
  const ratioPct = (rec.currentTime / rec.duration) * 100;
  if (rec.currentTime <= MIN_RESUME_SECONDS || ratioPct >= COMPLETED_PROGRESS_THRESHOLD) {
    return null;
  }

  return {
    currentTime: rec.currentTime,
    duration: rec.duration,
    progressPercent: rec.progressPercent,
    selectedSourceId: rec.selectedSourceId,
    selectedSourceLabel: rec.selectedSourceLabel,
    selectedSourceUrl: rec.selectedSourceUrl,
  };
}

export function deriveContinueWatchingEntries(
  history: WatchHistoryRecord[],
  legacyEntries: ContinueWatchingEntry[],
  dismissedContinueIds: string[] = []
): ContinueWatchingEntry[] {
  // Take the most recent record per itemId
  const latestByItem = new Map<string, WatchHistoryRecord>();
  const sorted = [...history].sort((a, b) => b.updatedAt - a.updatedAt);

  for (const rec of sorted) {
    if (!latestByItem.has(rec.itemId)) {
      latestByItem.set(rec.itemId, rec);
    }
  }

  const fromHistory: ContinueWatchingEntry[] = [];
  for (const rec of latestByItem.values()) {
    if (rec.dismissedFromContinue) continue;
    if (rec.completed) continue;
    const ratioPct = rec.duration > 0 ? (rec.currentTime / rec.duration) * 100 : rec.progressPercent;
    if (rec.currentTime <= MIN_RESUME_SECONDS || ratioPct > COMPLETED_PROGRESS_THRESHOLD) {
      continue;
    }

    fromHistory.push({
      itemId: rec.itemId,
      type: rec.type,
      season: rec.season,
      episodeNumber: rec.episodeNumber,
      episodeId: rec.episodeId,
      episodeLabel: rec.episodeLabel,
      currentTime: rec.currentTime,
      duration: rec.duration,
      progressPercent: Math.max(1, Math.min(92, rec.progressPercent)),
      remainingText: formatRemainingTime(rec.currentTime, rec.duration),
      selectedSourceId: rec.selectedSourceId,
      selectedSourceLabel: rec.selectedSourceLabel,
      selectedSourceUrl: rec.selectedSourceUrl,
      updatedAt: rec.updatedAt,
    });
  }

  const dismissedSet = new Set(dismissedContinueIds);
  const fromLegacy: ContinueWatchingEntry[] = [];
  for (const entry of legacyEntries) {
    if (latestByItem.has(entry.itemId)) continue;
    if (dismissedSet.has(entry.itemId)) continue;
    if (entry.progressPercent <= 0 || entry.progressPercent > COMPLETED_PROGRESS_THRESHOLD) {
      continue;
    }
    const parsed = parseEpisodeTagFromLabel(entry.episodeLabel);
    fromLegacy.push({
      ...entry,
      season: entry.season ?? parsed.season,
      episodeNumber: entry.episodeNumber ?? parsed.episodeNumber,
      updatedAt: entry.updatedAt ?? 0,
    });
  }

  return [...fromHistory, ...fromLegacy].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  );
}

export function getSortedSeriesEpisodes(item: CatalogItem): SeriesEpisode[] {
  if (!item.episodes || item.episodes.length === 0) return [];
  return [...item.episodes].sort((a, b) => {
    const sDiff = (a.season || 1) - (b.season || 1);
    if (sDiff !== 0) return sDiff;
    return a.episode - b.episode;
  });
}

export function getNextSeriesEpisode(
  item: CatalogItem,
  currentSeason?: number,
  currentEpisodeNumber?: number,
  currentEpisodeId?: string,
  currentEpisodeLabel?: string
): SeriesEpisode | null {
  if (item.type !== 'series') return null;
  const sorted = getSortedSeriesEpisodes(item);
  if (sorted.length === 0) return null;

  const parsed = parseEpisodeTagFromLabel(currentEpisodeLabel);
  const s = currentSeason ?? parsed.season;
  const e = currentEpisodeNumber ?? parsed.episodeNumber;

  const currentIdx = sorted.findIndex(
    (ep) =>
      (currentEpisodeId && ep.id === currentEpisodeId) ||
      (typeof s === 'number' &&
        typeof e === 'number' &&
        (ep.season || 1) === s &&
        ep.episode === e)
  );

  if (currentIdx >= 0 && currentIdx + 1 < sorted.length) {
    return sorted[currentIdx + 1];
  }
  return null;
}

export function findPreferredSourceIndex(
  availableSources: MediaSource[],
  preferred?: {
    id?: string;
    label?: string;
    url?: string;
  }
): number {
  if (availableSources.length === 0) return 0;

  if (preferred) {
    if (preferred.url) {
      const exactUrlIdx = availableSources.findIndex(
        (s) => s.url === preferred.url && s.status !== 'offline'
      );
      if (exactUrlIdx >= 0) return exactUrlIdx;
    }

    if (preferred.id) {
      const exactIdIdx = availableSources.findIndex(
        (s) => s.id === preferred.id && s.status !== 'offline'
      );
      if (exactIdIdx >= 0) return exactIdIdx;
    }

    if (preferred.label) {
      const targetLabel = preferred.label.trim().toLowerCase();
      const labelIdx = availableSources.findIndex(
        (s) =>
          s.label.trim().toLowerCase() === targetLabel &&
          s.status !== 'offline'
      );
      if (labelIdx >= 0) return labelIdx;
    }

    if (preferred.url) {
      try {
        const prefHost = new URL(preferred.url).host;
        const hostIdx = availableSources.findIndex((s) => {
          if (s.status === 'offline') return false;
          try {
            return new URL(s.url).host === prefHost;
          } catch {
            return false;
          }
        });
        if (hostIdx >= 0) return hostIdx;
      } catch {
        // Ignore invalid URL
      }
    }
  }

  if (availableSources[0] && availableSources[0].status !== 'offline') {
    return 0;
  }
  const nonOfflineIdx = availableSources.findIndex(
    (s) => s.status !== 'offline'
  );
  return nonOfflineIdx >= 0 ? nonOfflineIdx : 0;
}
