import Dexie, { type EntityTable } from 'dexie';
import { INITIAL_CONTINUE_WATCHING } from '../data/catalog';
import {
  AppSettings,
  CatalogItem,
  EpgProgram,
  M3uListRecord,
  UserLibraryState,
  WatchHistoryRecord,
} from '../types/streaming';

export interface PendingCatalogImport {
  id: string;
  itemIds: string[];
  cursor: number;
  sourceOffset?: number;
  confirmedSources?: number;
  needsCatalogRefresh?: boolean;
}

class AuraStreamDatabase extends Dexie {
  mediaItems!: EntityTable<CatalogItem, 'id'>;
  appSettings!: EntityTable<AppSettings, 'key'>;
  userLibrary!: EntityTable<UserLibraryState, 'key'>;
  epgPrograms!: EntityTable<EpgProgram, 'id'>;
  m3u_lists!: EntityTable<M3uListRecord, 'id'>;
  watchHistory!: EntityTable<WatchHistoryRecord, 'id'>;
  pendingCatalogImports!: EntityTable<PendingCatalogImport, 'id'>;

  constructor() {
    super('AuraStreamDB');
    this.version(1).stores({
      mediaItems:
        'id, normalizedKey, mediaKind, type, status, platform, year, createdAt, tmdbId',
      appSettings: 'key',
      userLibrary: 'key',
    });
    this.version(2).stores({
      mediaItems:
        'id, normalizedKey, mediaKind, type, status, platform, year, createdAt, tmdbId, tvgId',
      appSettings: 'key',
      userLibrary: 'key',
      epgPrograms: 'id, channelId, startMs, stopMs',
    });
    this.version(3).stores({
      mediaItems:
        'id, normalizedKey, mediaKind, type, status, platform, year, createdAt, tmdbId, tvgId',
      appSettings: 'key',
      userLibrary: 'key',
      epgPrograms: 'id, channelId, startMs, stopMs',
      m3u_lists: 'id, name, sourceType, importedAt',
    });
    this.version(4).stores({
      mediaItems:
        'id, normalizedKey, mediaKind, type, status, platform, year, createdAt, tmdbId, tvgId',
      appSettings: 'key',
      userLibrary: 'key',
      epgPrograms: 'id, channelId, startMs, stopMs',
      m3u_lists: 'id, name, sourceType, importedAt',
      watchHistory: 'id, itemId, updatedAt',
    });
    this.version(5).stores({ pendingCatalogImports: 'id' });
  }
}

export const db = new AuraStreamDatabase();

export const DEFAULT_SETTINGS: AppSettings = {
  key: 'config',
  tmdbApiKey: '',
  youtubeApiKey: '',
  streamProxyPrefix: '',
  autoProxyHttpStreams: true,
  epgUrl: '',
  batchSize: 4,
  probeTimeoutMs: 6500,
  userName: 'Kaio Bussinguer',
  userEmail: 'kaiobussinguer@gmail.com',
  isLoggedIn: true,
};

export const DEFAULT_LIBRARY: UserLibraryState = {
  key: 'state',
  myListIds: ['duna-horizonte', 'neblina-do-norte'],
  continueWatching: INITIAL_CONTINUE_WATCHING,
};

export const LS_TMDB_KEY = 'aura_tmdb_api_key';
export const LS_YOUTUBE_KEY = 'aura_youtube_api_key';

function readLocalKey(storageKey: string): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return (window.localStorage.getItem(storageKey) || '').trim();
    }
  } catch {
    // Ignore storage access errors
  }
  return '';
}

function writeLocalKey(storageKey: string, value: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (value.trim()) {
        window.localStorage.setItem(storageKey, value.trim());
      } else {
        window.localStorage.removeItem(storageKey);
      }
    }
  } catch {
    // Ignore storage access errors
  }
}

export async function getSettings(): Promise<AppSettings> {
  const existing = await db.appSettings.get('config');
  const lsTmdb = readLocalKey(LS_TMDB_KEY);
  const lsYoutube = readLocalKey(LS_YOUTUBE_KEY);

  if (existing) {
    const tmdbApiKey = lsTmdb || existing.tmdbApiKey || '';
    const youtubeApiKey = lsYoutube || existing.youtubeApiKey || '';
    if (tmdbApiKey && !lsTmdb) writeLocalKey(LS_TMDB_KEY, tmdbApiKey);
    if (youtubeApiKey && !lsYoutube) writeLocalKey(LS_YOUTUBE_KEY, youtubeApiKey);
    return {
      ...DEFAULT_SETTINGS,
      ...existing,
      tmdbApiKey,
      youtubeApiKey,
    };
  }

  const initial: AppSettings = {
    ...DEFAULT_SETTINGS,
    tmdbApiKey: lsTmdb || DEFAULT_SETTINGS.tmdbApiKey,
    youtubeApiKey: lsYoutube || DEFAULT_SETTINGS.youtubeApiKey,
  };
  await db.appSettings.put(initial);
  return initial;
}

export async function saveSettings(
  partial: Partial<Omit<AppSettings, 'key'>>
): Promise<AppSettings> {
  const current = await getSettings();
  const updated: AppSettings = { ...current, ...partial, key: 'config' };
  if (typeof partial.tmdbApiKey === 'string') {
    writeLocalKey(LS_TMDB_KEY, partial.tmdbApiKey);
  }
  if (typeof partial.youtubeApiKey === 'string') {
    writeLocalKey(LS_YOUTUBE_KEY, partial.youtubeApiKey);
  }
  await db.appSettings.put(updated);
  return updated;
}

export async function getUserLibrary(): Promise<UserLibraryState> {
  const existing = await db.userLibrary.get('state');
  if (existing) return existing;
  await db.userLibrary.put(DEFAULT_LIBRARY);
  return DEFAULT_LIBRARY;
}

export async function saveUserLibrary(
  partial: Partial<Omit<UserLibraryState, 'key'>>
): Promise<UserLibraryState> {
  const current = await getUserLibrary();
  const updated: UserLibraryState = { ...current, ...partial, key: 'state' };
  await db.userLibrary.put(updated);
  return updated;
}

export async function replaceEpgPrograms(programs: EpgProgram[]): Promise<void> {
  await db.epgPrograms.clear();
  if (programs.length > 0) {
    const chunkSize = 2000;
    for (let i = 0; i < programs.length; i += chunkSize) {
      await db.epgPrograms.bulkPut(programs.slice(i, i + chunkSize));
    }
  }
}

export async function getAllEpgPrograms(): Promise<EpgProgram[]> {
  return db.epgPrograms.toArray();
}

export async function getAllM3uLists(): Promise<M3uListRecord[]> {
  return db.m3u_lists.orderBy('importedAt').reverse().toArray();
}

export async function saveM3uListRecord(record: M3uListRecord): Promise<void> {
  await db.m3u_lists.put(record);
}
