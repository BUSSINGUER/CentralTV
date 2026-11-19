import {
  db,
  getUserLibrary,
  saveUserLibrary,
} from '../db/database';
import { auth } from '../lib/firebase';
import {
  CatalogItem,
  M3uListRecord,
  WatchHistoryRecord,
} from '../types/streaming';

const LOCAL_BACKUP_STORAGE_KEY = 'aura_idb_backup_snapshot_v1';

export interface LocalBackupSnapshot {
  createdAt: number;
  items: CatalogItem[];
  lists: M3uListRecord[];
  myListIds: string[];
  watchHistory: WatchHistoryRecord[];
}

export interface ServerMigrationBackupItem {
  id: string;
  source: string;
  status: string;
  summary: {
    createdWorks?: number;
    mergedWorks?: number;
    createdLists?: number;
    createdFavorites?: number;
    migratedHistory?: number;
  };
  createdAt: number;
  rolledBackAt?: number | null;
}

export interface MigrationExecutionResult {
  backupId: string;
  createdWorks: number;
  mergedWorks: number;
  createdLists: number;
  createdFavorites: number;
  migratedHistory: number;
}

async function getBearerHeaders(): Promise<Record<string, string> | null> {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    const token = await user.getIdToken();
    if (!token) return null;
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  } catch {
    return null;
  }
}

export async function createLocalBackupSnapshot(): Promise<LocalBackupSnapshot> {
  const [items, lists, library, watchHistory] = await Promise.all([
    db.mediaItems.toArray(),
    db.m3u_lists.toArray(),
    getUserLibrary(),
    db.watchHistory.toArray(),
  ]);

  const snapshot: LocalBackupSnapshot = {
    createdAt: Date.now(),
    items,
    lists,
    myListIds: library.myListIds || [],
    watchHistory,
  };

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(
        LOCAL_BACKUP_STORAGE_KEY,
        JSON.stringify(snapshot)
      );
    }
  } catch {
    // Ignore storage quota issues for very large playlists
  }

  return snapshot;
}

export function readLocalBackupSnapshot(): LocalBackupSnapshot | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(LOCAL_BACKUP_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LocalBackupSnapshot;
  } catch {
    return null;
  }
}

export async function restoreLocalBackupSnapshot(
  snapshot?: LocalBackupSnapshot | null
): Promise<boolean> {
  const target = snapshot || readLocalBackupSnapshot();
  if (!target) return false;

  await db.transaction(
    'rw',
    db.mediaItems,
    db.m3u_lists,
    db.userLibrary,
    db.watchHistory,
    async () => {
      await db.mediaItems.clear();
      if (target.items.length > 0) {
        await db.mediaItems.bulkPut(target.items);
      }
      await db.m3u_lists.clear();
      if (target.lists.length > 0) {
        await db.m3u_lists.bulkPut(target.lists);
      }
      await saveUserLibrary({ myListIds: target.myListIds || [] });
      await db.watchHistory.clear();
      if (target.watchHistory.length > 0) {
        await db.watchHistory.bulkPut(target.watchHistory);
      }
    }
  );
  return true;
}

async function remapLocalIdsIfNeeded(
  idMap: Record<string, string>
): Promise<void> {
  const changedPairs = Object.entries(idMap).filter(
    ([oldId, newId]) => oldId && newId && oldId !== newId
  );
  if (changedPairs.length === 0) return;

  const pairMap = new Map(changedPairs);
  const lib = await getUserLibrary();
  const remappedMyList = Array.from(
    new Set((lib.myListIds || []).map((id) => pairMap.get(id) || id))
  );
  await saveUserLibrary({ myListIds: remappedMyList });

  const historyRows = await db.watchHistory.toArray();
  const deleteIds: string[] = [];
  const updatedHistory: WatchHistoryRecord[] = [];
  for (const h of historyRows) {
    const newId = pairMap.get(h.itemId);
    if (newId) {
      const remappedHistoryKey =
        h.type === 'movie'
          ? `movie:${newId}`
          : h.season && h.episodeNumber
            ? `series:${newId}:S${h.season}:E${h.episodeNumber}`
            : h.id.replace(h.itemId, newId);
      if (remappedHistoryKey !== h.id) {
        deleteIds.push(h.id);
      }
      updatedHistory.push({
        ...h,
        id: remappedHistoryKey,
        itemId: newId,
      });
    }
  }
  if (deleteIds.length > 0) {
    await db.watchHistory.bulkDelete(deleteIds);
  }
  if (updatedHistory.length > 0) {
    await db.watchHistory.bulkPut(updatedHistory);
  }
}

export async function pullAuthoritativeStateFromServer(options?: {
  replaceEmpty?: boolean;
}): Promise<{
  synced: boolean;
  works: CatalogItem[];
  lists: M3uListRecord[];
  myListIds: string[];
  watchHistory: WatchHistoryRecord[];
}> {
  const headers = await getBearerHeaders();
  if (!headers) {
    return {
      synced: false,
      works: [],
      lists: [],
      myListIds: [],
      watchHistory: [],
    };
  }

  const [catResp, libResp, histResp] = await Promise.all([
    fetch('/api/catalog?includeArchived=1', { headers }),
    fetch('/api/user/library', { headers }),
    fetch('/api/user/history', { headers }),
  ]);

  if (!catResp.ok || !libResp.ok || !histResp.ok) {
    return {
      synced: false,
      works: [],
      lists: [],
      myListIds: [],
      watchHistory: [],
    };
  }

  const catData = (await catResp.json()) as {
    works?: CatalogItem[];
    lists?: M3uListRecord[];
  };
  const libData = (await libResp.json()) as { myListIds?: string[] };
  const histData = (await histResp.json()) as { history?: WatchHistoryRecord[] };

  const serverWorks = catData.works || [];
  const serverLists = catData.lists || [];
  const serverMyList = libData.myListIds || [];
  const serverHistory = histData.history || [];
  const replaceEmpty = Boolean(options?.replaceEmpty);

  await db.transaction(
    'rw',
    db.mediaItems,
    db.m3u_lists,
    db.userLibrary,
    db.watchHistory,
    async () => {
      if (serverWorks.length > 0 || replaceEmpty) {
        await db.mediaItems.clear();
        if (serverWorks.length > 0) {
          await db.mediaItems.bulkPut(serverWorks);
        }
      }
      if (serverLists.length > 0 || serverWorks.length > 0 || replaceEmpty) {
        await db.m3u_lists.clear();
        if (serverLists.length > 0) {
          await db.m3u_lists.bulkPut(serverLists);
        }
      }

      if (serverMyList.length > 0 || serverWorks.length > 0 || replaceEmpty) {
        await saveUserLibrary({ myListIds: serverMyList });
      }
      if (serverHistory.length > 0 || serverWorks.length > 0 || replaceEmpty) {
        await db.watchHistory.clear();
        if (serverHistory.length > 0) {
          await db.watchHistory.bulkPut(serverHistory);
        }
      }
    }
  );

  return {
    synced: true,
    works: serverWorks,
    lists: serverLists,
    myListIds: serverMyList,
    watchHistory: serverHistory,
  };
}

export async function runIndexedDbMigrationToServer(
  source: 'indexeddb_auto' | 'manual_admin' = 'indexeddb_auto'
): Promise<MigrationExecutionResult | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;

  const snapshot = await createLocalBackupSnapshot();

  const hasLocalPayload =
    snapshot.items.length > 0 ||
    snapshot.lists.length > 0 ||
    snapshot.watchHistory.length > 0 ||
    snapshot.myListIds.length > 0;

  if (!hasLocalPayload && source === 'indexeddb_auto') {
    await pullAuthoritativeStateFromServer();
    return null;
  }

  const resp = await fetch('/api/migration/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source,
      items: snapshot.items,
      lists: snapshot.lists,
      myListIds: snapshot.myListIds,
      watchHistory: snapshot.watchHistory,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(
      err.error || 'Falha ao migrar dados locais para o banco persistente.'
    );
  }

  const summary = (await resp.json()) as MigrationExecutionResult & {
    idMap?: Record<string, string>;
  };

  if (summary.idMap) {
    await remapLocalIdsIfNeeded(summary.idMap);
  }

  await pullAuthoritativeStateFromServer();
  return summary;
}

export async function syncCatalogItemsToServer(
  items: CatalogItem[],
  list?: M3uListRecord,
  mergeWithoutOverwrite = false
): Promise<{ synced: boolean; error?: string }> {
  if (items.length === 0 && !list) return { synced: true };
  const headers = await getBearerHeaders();
  if (!headers) return { synced: false };

  try {
    const chunkSize = 250;
    for (let i = 0; i < Math.max(1, items.length); i += chunkSize) {
      const slice = items.slice(i, i + chunkSize);
      const resp = await fetch('/api/catalog/sync', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: slice,
          list: i === 0 ? list : undefined,
          mergeWithoutOverwrite,
        }),
      });
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({})) as { error?: string };
        return {
          synced: false,
          error: errBody.error || `Falha na sincronização (HTTP ${resp.status}).`,
        };
      }
      const data = (await resp.json()) as { idMap?: Record<string, string> };
      if (data.idMap) {
        await remapLocalIdsIfNeeded(data.idMap);
      }
    }
    return { synced: true };
  } catch (err) {
    // Keep IndexedDB operational when offline
    return {
      synced: false,
      error: err instanceof Error ? err.message : 'Erro de rede na sincronização.',
    };
  }
}

export async function syncWorkPatchToServer(
  workId: string,
  patch: Partial<CatalogItem>
): Promise<void> {
  const headers = await getBearerHeaders();
  if (!headers) return;
  try {
    await fetch(`/api/catalog/works/${encodeURIComponent(workId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });
  } catch {
    // Keep IndexedDB operational
  }
}

export async function deleteWorkOnServer(workId: string): Promise<void> {
  const headers = await getBearerHeaders();
  if (!headers) return;
  try {
    await fetch(`/api/catalog/works/${encodeURIComponent(workId)}`, {
      method: 'DELETE',
      headers,
    });
  } catch {
    // Keep IndexedDB operational
  }
}

export async function deleteListOnServer(listId: string): Promise<{
  removedSources: number;
  updatedWorks: number;
  archivedWorks: number;
} | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;
  try {
    const resp = await fetch(`/api/lists/${encodeURIComponent(listId)}`, {
      method: 'DELETE',
      headers,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as {
      removedSources: number;
      updatedWorks: number;
      archivedWorks: number;
    };
  } catch {
    return null;
  }
}

export async function syncFavoritesToServer(myListIds: string[]): Promise<void> {
  const headers = await getBearerHeaders();
  if (!headers) return;
  try {
    await fetch('/api/user/library', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ myListIds }),
    });
  } catch {
    // Keep IndexedDB operational
  }
}

export async function syncWatchHistoryRecordToServer(
  record: WatchHistoryRecord
): Promise<void> {
  const headers = await getBearerHeaders();
  if (!headers) return;
  try {
    await fetch('/api/user/history', {
      method: 'POST',
      headers,
      body: JSON.stringify(record),
    });
  } catch {
    // Keep IndexedDB operational
  }
}

export async function dismissHistoryOnServer(workId: string): Promise<void> {
  const headers = await getBearerHeaders();
  if (!headers) return;
  try {
    await fetch(`/api/user/history/${encodeURIComponent(workId)}/dismiss`, {
      method: 'POST',
      headers,
    });
  } catch {
    // Keep IndexedDB operational
  }
}

export async function fetchMigrationBackups(): Promise<
  ServerMigrationBackupItem[]
> {
  const headers = await getBearerHeaders();
  if (!headers) return [];
  try {
    const resp = await fetch('/api/migration/backups', { headers });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      backups?: ServerMigrationBackupItem[];
    };
    return data.backups || [];
  } catch {
    return [];
  }
}

export async function rollbackServerMigration(backupId: string): Promise<{
  backupId: string;
  revertedWorks: number;
  revertedLists: number;
  revertedSources: number;
  revertedFavorites: number;
  revertedHistory: number;
}> {
  const headers = await getBearerHeaders();
  if (!headers) {
    throw new Error('Autenticação necessária para executar rollback.');
  }
  const resp = await fetch('/api/migration/rollback', {
    method: 'POST',
    headers,
    body: JSON.stringify({ backupId }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || 'Falha ao reverter migração.');
  }
  await pullAuthoritativeStateFromServer({ replaceEmpty: true });
  return data;
}
