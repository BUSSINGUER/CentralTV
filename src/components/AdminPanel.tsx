import { useEffect, useMemo, useRef, useState, useCallback, DragEvent, FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  FileJson,
  FileUp,
  Globe,
  KeyRound,
  Link2,
  List,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unlock,
  Upload,
  Wand2,
  WifiOff,
} from 'lucide-react';
import {
  db,
  getAllEpgPrograms,
  getAllM3uLists,
  replaceEpgPrograms,
  saveSettings,
} from '../db/database';
import { PLATFORM_LABELS } from '../data/catalog';
import {
  buildXtreamM3uUrl,
  deleteM3uList,
  importFromXtreamCredentials,
  importM3UFromFile,
  importM3UFromText,
  importM3UFromUrl,
  M3UImportStats,
  resyncM3uList,
  SAMPLE_M3U_SNIPPET,
  unifyAndReclassifyCatalog,
} from '../services/m3uParser';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../lib/firebase';
import { ServerRecord } from '../db/catalogRepository';
import {
  cancelProcessingTask,
  deleteWorkOnServer,
  fetchMigrationBackups,
  fetchProcessingTasks,
  pauseProcessingTask,
  publishApprovedOnServer,
  pullAuthoritativeStateFromServer,
  resetActiveCatalogOnServer,
  restoreLocalBackupSnapshot,
  resumeProcessingTask,
  resumeCatalogListUpload,
  type CatalogUploadProgress,
  rollbackServerMigration,
  runIndexedDbMigrationToServer,
  ServerMigrationBackupItem,
  startProcessingTask,
  syncWorkPatchToServer,
} from '../services/persistenceSync';
import {
  PipelineProgress,
  processItemFullPipeline,
} from '../services/pipeline';
import {
  AppSettings,
  CatalogItem,
  EpgProgram,
  M3uListRecord,
  MediaKind,
  PlatformId,
  ProcessingTaskView,
  PublishStatus,
} from '../types/streaming';
import { MediaImage } from './MediaImage';

interface AdminPanelProps {
  settings: AppSettings;
  initialTab?: AdminTab;
  onSettingsUpdated: (settings: AppSettings) => void;
  onSelectItem: (item: CatalogItem) => void;
  onBackHome: () => void;
  onCatalogChanged: () => void;
  onEpgChanged?: () => void;
}

export type AdminTab = 'queue' | 'import' | 'lists' | 'servers' | 'settings';

const STATUS_LABELS: Record<PublishStatus, string> = {
  pendente: 'Pendente',
  aprovado: 'Aprovado',
  offline: 'Offline',
  publicado: 'Publicado',
};

const KIND_LABELS: Record<MediaKind, string> = {
  movie: 'Filme',
  series: 'Série',
  live: 'TV ao Vivo',
  radio: 'Rádio',
};

const PAGE_SIZE = 30;

export function AdminPanel({
  settings,
  initialTab = 'queue',
  onSettingsUpdated,
  onSelectItem,
  onBackHome,
  onCatalogChanged,
  onEpgChanged,
}: AdminPanelProps) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [m3uLists, setM3uLists] = useState<M3uListRecord[]>([]);
  const [loadingDb, setLoadingDb] = useState(true);
  const [epgCount, setEpgCount] = useState(0);
  const [migrationBackups, setMigrationBackups] = useState<
    ServerMigrationBackupItem[]
  >([]);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationMsg, setMigrationMsg] = useState<string | null>(null);

  // Filter & Pagination state
  const [statusFilter, setStatusFilter] = useState<PublishStatus | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<MediaKind | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);

  // Content Servers state
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerRecord | null>(null);
  const [serverForm, setServerForm] = useState({
    name: '',
    baseUrl: '',
    serverType: 'm3u' as ServerRecord['serverType'],
    username: '',
    password: '',
  });
  const [serverActionMsg, setServerActionMsg] = useState<string | null>(null);
  const [testingServerId, setTestingServerId] = useState<string | null>(null);
  const [syncingServerId, setSyncingServerId] = useState<string | null>(null);

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const u = auth.currentUser;
    if (!u) return {};
    const token = await u.getIdToken();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  };

  const loadServers = useCallback(async () => {
    setLoadingServers(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch('/api/servers', { headers });
      if (resp.ok) {
        const data = await resp.json();
        setServers(data.servers || []);
      }
    } catch {
      // ignore
    } finally {
      setLoadingServers(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'servers') {
      void loadServers();
    }
  }, [activeTab, loadServers]);

  const handleSaveServer = async (e: FormEvent) => {
    e.preventDefault();
    if (!serverForm.name.trim() || !serverForm.baseUrl.trim()) {
      setServerActionMsg('Nome e URL base são obrigatórios.');
      return;
    }
    setServerActionMsg('Salvando servidor...');
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch('/api/servers', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: editingServer?.id,
          name: serverForm.name.trim(),
          baseUrl: serverForm.baseUrl.trim(),
          serverType: serverForm.serverType,
          username: serverForm.username.trim() || undefined,
          password: serverForm.password.trim() || undefined,
        }),
      });
      if (resp.ok) {
        setServerModalOpen(false);
        setEditingServer(null);
        setServerForm({ name: '', baseUrl: '', serverType: 'm3u', username: '', password: '' });
        setServerActionMsg('Servidor salvo com sucesso.');
        void loadServers();
      } else {
        const err = await resp.json().catch(() => ({}));
        setServerActionMsg(err.error || 'Falha ao salvar servidor.');
      }
    } catch (err) {
      setServerActionMsg(err instanceof Error ? err.message : 'Erro ao salvar servidor.');
    }
  };

  const handleTestServer = async (serverId: string) => {
    setTestingServerId(serverId);
    setServerActionMsg('Testando conexão com o servidor...');
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`/api/servers/${encodeURIComponent(serverId)}/test`, {
        method: 'POST',
        headers,
      });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        setServerActionMsg(`Teste concluído: ${data.reason} (${data.latencyMs}ms).`);
      } else {
        setServerActionMsg(`Falha no teste: ${data.reason || 'Servidor inacessível'}.`);
      }
      void loadServers();
    } catch (err) {
      setServerActionMsg(err instanceof Error ? err.message : 'Erro ao testar servidor.');
    } finally {
      setTestingServerId(null);
    }
  };

  const handleSyncServer = async (serverId: string) => {
    setSyncingServerId(serverId);
    setServerActionMsg('Sincronizando conteúdo do servidor...');
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`/api/servers/${encodeURIComponent(serverId)}/sync`, {
        method: 'POST',
        headers,
      });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        setServerActionMsg(`Sincronização concluída com sucesso (${data.itemCount} itens processados).`);
        void loadServers();
        onCatalogChanged();
      } else {
        setServerActionMsg(`Falha na sincronização: ${data.error || 'Erro desconhecido'}.`);
      }
    } catch (err) {
      setServerActionMsg(err instanceof Error ? err.message : 'Erro na sincronização.');
    } finally {
      setSyncingServerId(null);
    }
  };

  const handleDeleteServer = async (serverId: string) => {
    if (!window.confirm('Tem certeza que deseja remover este servidor?')) return;
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`/api/servers/${encodeURIComponent(serverId)}`, {
        method: 'DELETE',
        headers,
      });
      if (resp.ok) {
        setServerActionMsg('Servidor removido.');
        void loadServers();
      } else {
        setServerActionMsg('Falha ao remover servidor.');
      }
    } catch {
      setServerActionMsg('Erro ao remover servidor.');
    }
  };

  // Import state
  const [importSourceMode, setImportSourceMode] = useState<
    'file' | 'url' | 'xtream'
  >('file');
  const [m3uUrl, setM3uUrl] = useState('');
  const [xtreamServerUrl, setXtreamServerUrl] = useState('');
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [showXtreamPassword, setShowXtreamPassword] = useState(false);
  const [listCustomName, setListCustomName] = useState('');
  const [importing, setImporting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<CatalogUploadProgress | null>(null);
  const refreshAfterUploadRef = useRef(false);
  const [importStats, setImportStats] = useState<M3UImportStats | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResultMsg, setImportResultMsg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const importAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // List Manager state
  const [showAddSourceInLists, setShowAddSourceInLists] = useState(true);
  const [confirmDeleteListId, setConfirmDeleteListId] = useState<string | null>(
    null
  );
  const [deletingListId, setDeletingListId] = useState<string | null>(null);
  const [resyncingListId, setResyncingListId] = useState<string | null>(null);
  const [listActionMsg, setListActionMsg] = useState<string | null>(null);
  const [pendingListProgress, setPendingListProgress] = useState<
    Record<string, { confirmed: number; total: number }>
  >({});
  const pendingListIds = Object.keys(pendingListProgress);
  const [catalogActionBusy, setCatalogActionBusy] = useState(false);

  // EPG state
  const [epgUrlInput, setEpgUrlInput] = useState(settings.epgUrl || '');
  const [epgLoading, setEpgLoading] = useState(false);
  const [epgStatusMsg, setEpgStatusMsg] = useState<string | null>(null);
  const [epgError, setEpgError] = useState<string | null>(null);

  // Reclassify status
  const [reclassifyMsg, setReclassifyMsg] = useState<string | null>(null);

  // Pipeline state (synced with backend persistent processing_tasks)
  const [pipeline, setPipeline] = useState<PipelineProgress>({
    running: false,
    paused: false,
    processed: 0,
    total: 0,
    approved: 0,
    pendingCors: 0,
    offline: 0,
    failed: 0,
    currentTitle: '',
    currentStage: 'health',
  });
  const [activeTask, setActiveTask] = useState<ProcessingTaskView | null>(null);
  const [queuedTasks, setQueuedTasks] = useState<ProcessingTaskView[]>([]);
  const [verifyingListId, setVerifyingListId] = useState<string | null>(null);
  const activeTaskRef = useRef<ProcessingTaskView | null>(null);
  const lastObservedTaskSigRef = useRef<string>('');
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  // Settings form state
  const [tmdbKey, setTmdbKey] = useState(settings.tmdbApiKey);
  const [youtubeKey, setYoutubeKey] = useState(settings.youtubeApiKey);
  const [streamProxyPrefix, setStreamProxyPrefix] = useState(
    settings.streamProxyPrefix || ''
  );
  const [autoProxyHttpStreams, setAutoProxyHttpStreams] = useState(
    settings.autoProxyHttpStreams ?? true
  );
  const [batchSize, setBatchSize] = useState(settings.batchSize);
  const [probeTimeoutMs, setProbeTimeoutMs] = useState(settings.probeTimeoutMs);
  const [tmdbLocked, setTmdbLocked] = useState(true);
  const [youtubeLocked, setYoutubeLocked] = useState(true);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState(false);

  const refreshItems = useCallback(async (notifyCatalog = true) => {
    try {
      const [all, epg, lists, pendingIds] = await Promise.all([
        db.mediaItems.orderBy('createdAt').reverse().toArray(),
        getAllEpgPrograms(),
        getAllM3uLists(),
        db.pendingCatalogImports.toArray(),
      ]);
      setItems(all.filter((it) => !it.archived));
      setArchivedCount(all.filter((it) => Boolean(it.archived)).length);
      setEpgCount(epg.length);
      setM3uLists(lists);
      setPendingListProgress(Object.fromEntries(pendingIds.map((job) => [
        job.id, { confirmed: job.cursor, total: job.itemIds.length },
      ])));
      if (notifyCatalog) onCatalogChanged();
    } catch (err) {
      console.error('Failed to refresh admin items:', err);
    } finally {
      setLoadingDb(false);
    }
  }, [onCatalogChanged]);

  const applyServerTasksSnapshot = useCallback(
    async (tasks: ProcessingTaskView[]) => {
      const primary =
        tasks.find((t) => t.status === 'running') ||
        tasks.find((t) => t.status === 'paused') ||
        tasks.find((t) => t.status === 'queued') ||
        tasks.find(
          (t) =>
            activeTaskRef.current?.id === t.id ||
            Date.now() - t.updatedAt < 5 * 60 * 1000
        ) ||
        null;

      const remainingQueued = tasks.filter(
        (t) => t.status === 'queued' && t.id !== primary?.id
      );

      setQueuedTasks(remainingQueued);
      setActiveTask(primary);
      activeTaskRef.current = primary;

      if (!primary) return;

      const isActive =
        primary.status === 'running' ||
        primary.status === 'paused' ||
        primary.status === 'queued';

      setPipeline({
        running: isActive,
        paused: primary.status === 'paused',
        processed: primary.processedItems,
        total: primary.totalItems,
        approved: primary.approvedCount,
        pendingCors: primary.pendingBlockedCount,
        offline: primary.offlineCount,
        failed: primary.failedCount,
        currentTitle:
          primary.currentTitle ||
          (primary.listName ? `Lista: ${primary.listName}` : 'Catálogo'),
        currentStage: primary.currentStage || 'health',
        lastNote: primary.lastNote,
      });

      const sig = `${primary.id}:${primary.status}:${primary.processedItems}`;
      if (sig !== lastObservedTaskSigRef.current) {
        const hadPrior = Boolean(lastObservedTaskSigRef.current);
        lastObservedTaskSigRef.current = sig;
        // Progress is already carried by the task snapshot. Pulling the entire
        // 45k+ catalog on every 1.8s progress tick creates a repeated network,
        // JSON and IndexedDB memory spike. Refresh the catalog once at the end.
        if (hadPrior && user && !isActive) {
          await pullAuthoritativeStateFromServer().catch(() => {});
          await refreshItems();
        }
      }
    },
    [user, refreshItems]
  );

  const syncTasksFromServer = useCallback(async () => {
    if (!user) return;
    const tasks = await fetchProcessingTasks();
    await applyServerTasksSnapshot(tasks);
  }, [user, applyServerTasksSnapshot]);

  useEffect(() => {
    let active = true;
    const bootstrap = async () => {
      await refreshItems();
      if (!active) return;
      if (user) {
        void pullAuthoritativeStateFromServer().then((result) => {
          if (active && result.synced) return refreshItems();
        }).catch(() => {});
        void fetchMigrationBackups().then((backups) => {
          if (active) setMigrationBackups(backups);
        }).catch(() => {});
        await syncTasksFromServer();
      }
    };
    void bootstrap();
    return () => {
      active = false;
    };
  }, [user, refreshItems, syncTasksFromServer]);

  useEffect(() => {
    if (!user) return;
    const shouldPoll =
      activeTask?.status === 'running' || activeTask?.status === 'queued';
    if (!shouldPoll) return;

    const timer = window.setInterval(() => {
      void syncTasksFromServer();
    }, 1800);

    return () => window.clearInterval(timer);
  }, [user, activeTask?.status, syncTasksFromServer]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setTmdbKey(settings.tmdbApiKey);
    setYoutubeKey(settings.youtubeApiKey);
    setStreamProxyPrefix(settings.streamProxyPrefix || '');
    setAutoProxyHttpStreams(settings.autoProxyHttpStreams ?? true);
    setEpgUrlInput(settings.epgUrl || '');
    setBatchSize(settings.batchSize);
    setProbeTimeoutMs(settings.probeTimeoutMs);
  }, [settings]);

  const counts = useMemo(() => {
    const c = {
      total: items.length,
      pendente: 0,
      aprovado: 0,
      offline: 0,
      publicado: 0,
    };
    for (const item of items) {
      const st = item.status || 'pendente';
      c[st] += 1;
    }
    return c;
  }, [items]);

  const listLiveStats = useMemo(() => {
    const map = new Map<
      string,
      { titleIds: Set<string>; sourceCount: number }
    >();

    const touch = (listId: string | undefined, itemId: string) => {
      if (!listId) return;
      let entry = map.get(listId);
      if (!entry) {
        entry = { titleIds: new Set<string>(), sourceCount: 0 };
        map.set(listId, entry);
      }
      entry.titleIds.add(itemId);
      entry.sourceCount += 1;
    };

    for (const item of items) {
      for (const src of item.sources || []) {
        touch(src.listId, item.id);
      }
      for (const ep of item.episodes || []) {
        for (const src of ep.sources || []) {
          touch(src.listId, item.id);
        }
      }
    }

    const result = new Map<
      string,
      { titleCount: number; sourceCount: number }
    >();
    for (const [id, val] of map.entries()) {
      result.set(id, {
        titleCount: val.titleIds.size,
        sourceCount: val.sourceCount,
      });
    }
    return result;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return items.filter((item) => {
      const st = item.status || 'pendente';
      const kind = item.type;
      if (statusFilter !== 'all' && st !== statusFilter) return false;
      if (kindFilter !== 'all' && kind !== kindFilter) return false;
      if (q && !item.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, statusFilter, kindFilter, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const pagedItems = useMemo(() => {
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredItems.slice(start, start + PAGE_SIZE);
  }, [filteredItems, page, totalPages]);

  useEffect(() => {
    setPage(1);
  }, [statusFilter, kindFilter, searchTerm]);

  // M3U / JSON / Xtream Handlers
  const trackImportUpload = () => {
    let started = false;
    refreshAfterUploadRef.current = false;
    return (progress: CatalogUploadProgress) => {
      setUploadProgress(progress);
      refreshAfterUploadRef.current = Boolean(progress.needsCatalogRefresh);
      if (!started) {
        started = true;
        void refreshItems(false);
      }
    };
  };

  const refreshImportedCatalog = async (syncError?: string) => {
    await refreshItems();
    if (!syncError && refreshAfterUploadRef.current) {
      void pullAuthoritativeStateFromServer().then((result) => {
        if (result.synced) return refreshItems();
      }).catch(() => {});
    }
  };

  const formatMergeSummary = (result: M3UImportStats) => {
    if (result.syncError) {
      return `Arquivo lido, envio incompleto: ${result.syncError} Use “Retomar envio” em Listas.`;
    }
    const formatLabel =
      result.detectedFormat === 'json' ? 'Catálogo JSON' : 'Lista M3U';
    return `${formatLabel} importado(a) · ${result.touchedItemIds?.length || 0} títulos confirmados no servidor. ${result.newItems} novos títulos, ${result.mergedSources} fontes agregadas e ${result.ignoredDuplicates} duplicados ignorados.`;
  };

  const handleFileImport = async (file: File, stayOnLists = false) => {
    setImporting(true);
    setUploadProgress(null);
    setImportStats(null);
    setImportError(null);
    setImportResultMsg(null);
    setListActionMsg(null);
    const controller = new AbortController();
    importAbortRef.current = controller;

    try {
      const result = await importM3UFromFile(file, {
        customName: listCustomName.trim() || undefined,
        signal: controller.signal,
        onProgress: (stats) => setImportStats(stats),
        onUploadProgress: trackImportUpload(),
      });
      setImportStats(result);
      const summary = formatMergeSummary(result);
      setImportResultMsg(summary);
      if (stayOnLists) setListActionMsg(summary);
      setListCustomName('');
      await refreshImportedCatalog(result.syncError);
      if (!stayOnLists) setActiveTab('queue');
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setImportError(
          err instanceof Error ? err.message : 'Erro ao processar arquivo M3U.'
        );
      }
    } finally {
      setImporting(false);
      importAbortRef.current = null;
    }
  };

  const handleUrlImport = async (e: FormEvent, stayOnLists = false) => {
    e.preventDefault();
    if (!m3uUrl.trim()) return;
    setImporting(true);
    setUploadProgress(null);
    setImportStats(null);
    setImportError(null);
    setImportResultMsg(null);
    setListActionMsg(null);
    const controller = new AbortController();
    importAbortRef.current = controller;

    try {
      const result = await importM3UFromUrl(m3uUrl.trim(), {
        customName: listCustomName.trim() || undefined,
        signal: controller.signal,
        onProgress: (stats) => setImportStats(stats),
        onUploadProgress: trackImportUpload(),
      });
      setImportStats(result);
      const summary = formatMergeSummary(result);
      setImportResultMsg(summary);
      if (stayOnLists) setListActionMsg(summary);
      setM3uUrl('');
      setListCustomName('');
      await refreshImportedCatalog(result.syncError);
      if (!stayOnLists) setActiveTab('queue');
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setImportError(
          err instanceof Error ? err.message : 'Erro ao importar URL remota.'
        );
      }
    } finally {
      setImporting(false);
      importAbortRef.current = null;
    }
  };

  const handleXtreamImport = async (e: FormEvent, stayOnLists = false) => {
    e.preventDefault();
    if (
      !xtreamServerUrl.trim() ||
      !xtreamUsername.trim() ||
      !xtreamPassword.trim()
    ) {
      return;
    }
    setImporting(true);
    setUploadProgress(null);
    setImportStats(null);
    setImportError(null);
    setImportResultMsg(null);
    setListActionMsg(null);
    const controller = new AbortController();
    importAbortRef.current = controller;

    try {
      const result = await importFromXtreamCredentials(
        {
          serverUrl: xtreamServerUrl.trim(),
          username: xtreamUsername.trim(),
          password: xtreamPassword.trim(),
        },
        {
          customName: listCustomName.trim() || undefined,
          signal: controller.signal,
          onProgress: (stats) => setImportStats(stats),
          onUploadProgress: trackImportUpload(),
        }
      );
      setImportStats(result);
      const summary = formatMergeSummary(result);
      setImportResultMsg(summary);
      if (stayOnLists) setListActionMsg(summary);
      setXtreamServerUrl('');
      setXtreamUsername('');
      setXtreamPassword('');
      setListCustomName('');
      await refreshImportedCatalog(result.syncError);
      if (!stayOnLists) setActiveTab('queue');
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setImportError(
          err instanceof Error
            ? err.message
            : 'Erro ao conectar no servidor Xtream Codes.'
        );
      }
    } finally {
      setImporting(false);
      importAbortRef.current = null;
    }
  };

  const handleSampleImport = async (stayOnLists = false) => {
    setImporting(true);
    setUploadProgress(null);
    setImportStats(null);
    setImportError(null);
    setImportResultMsg(null);
    setListActionMsg(null);
    const controller = new AbortController();
    importAbortRef.current = controller;
    try {
      const result = await importM3UFromText(SAMPLE_M3U_SNIPPET, {
        customName: listCustomName.trim() || undefined,
        signal: controller.signal,
        onProgress: (stats) => setImportStats(stats),
        onUploadProgress: trackImportUpload(),
      });
      setImportStats(result);
      const summary = formatMergeSummary(result);
      setImportResultMsg(summary);
      if (stayOnLists) setListActionMsg(summary);
      setListCustomName('');
      await refreshImportedCatalog(result.syncError);
      if (!stayOnLists) setActiveTab('queue');
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Erro ao carregar snippet M3U.'
      );
    } finally {
      setImporting(false);
      importAbortRef.current = null;
    }
  };

  const handleResyncM3uList = async (list: M3uListRecord) => {
    setResyncingListId(list.id);
    setUploadProgress(null);
    setImportStats(null);
    setImportError(null);
    setListActionMsg(null);
    const controller = new AbortController();
    importAbortRef.current = controller;
    try {
      if (pendingListIds.includes(list.id)) {
        const total = await resumeCatalogListUpload(list, controller.signal, trackImportUpload());
        await refreshImportedCatalog();
        setListActionMsg(`Envio de "${list.name}" concluído. ${total} títulos confirmados pelo servidor.`);
        return;
      }
      const result = await resyncM3uList(list, {
        signal: controller.signal,
        onProgress: (stats) => setImportStats(stats),
        onUploadProgress: trackImportUpload(),
      });
      await refreshImportedCatalog(result.syncError);
      setListActionMsg(formatMergeSummary(result));
    } catch (err) {
      await refreshItems();
      const message = controller.signal.aborted
        ? 'Envio interrompido. Use “Retomar envio” para continuar.'
        : err instanceof Error ? err.message : 'Falha ao re-sincronizar lista.';
      setListActionMsg(message);
    } finally {
      setResyncingListId(null);
      importAbortRef.current = null;
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, stayOnLists = false) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFileImport(file, stayOnLists);
  };

  // EPG Import Handler
  const handleImportEpg = async (e: FormEvent) => {
    e.preventDefault();
    if (!epgUrlInput.trim()) return;
    setEpgLoading(true);
    setEpgError(null);
    setEpgStatusMsg(null);

    try {
      const resp = await fetch(
        `/api/epg/fetch?url=${encodeURIComponent(epgUrlInput.trim())}`
      );
      const data = (await resp.json()) as {
        error?: string;
        totalPrograms?: number;
        programs?: EpgProgram[];
      };

      if (!resp.ok || !data.programs) {
        throw new Error(data.error || 'Falha ao processar EPG XMLTV.');
      }

      await replaceEpgPrograms(data.programs);
      const updatedSettings = await saveSettings({
        epgUrl: epgUrlInput.trim(),
        epgLastUpdated: Date.now(),
      });
      onSettingsUpdated(updatedSettings);
      setEpgCount(data.programs.length);
      setEpgStatusMsg(
        `EPG importado com sucesso: ${data.programs.length} programas ativos salvos no IndexedDB.`
      );
      onEpgChanged?.();
    } catch (err) {
      setEpgError(
        err instanceof Error ? err.message : 'Erro ao importar EPG XMLTV.'
      );
    } finally {
      setEpgLoading(false);
    }
  };

  // Unify Duplicates & Reclassify Handler
  const handleReclassify = async () => {
    setReclassifyMsg(null);
    const res = await unifyAndReclassifyCatalog();
    await refreshItems();
    setReclassifyMsg(
      `Unificação concluída: ${res.beforeCount} → ${res.afterCount} títulos únicos com prioridade 4K (${res.byKind.movie} filmes, ${res.byKind.series} séries, ${res.byKind.live} TV ao vivo, ${res.byKind.radio} rádios).`
    );
  };

  // Pipeline Background Task Processing (decoupled from React lifecycle)
  const handleRunBatchPipeline = async () => {
    if (!user) {
      setPipeline((prev) => ({
        ...prev,
        lastNote:
          'Faça login na sua conta para executar o processamento persistente em segundo plano.',
      }));
      return;
    }

    if (counts.pendente === 0) return;

    try {
      // PostgreSQL is authoritative. Starting from it avoids serializing and
      // uploading the entire IndexedDB queue again on every click (45k+ items
      // can otherwise cause a large browser/server memory spike).
      const res = await startProcessingTask({
        scope: 'all_pending',
        batchSize: settings.batchSize,
        probeTimeoutMs: settings.probeTimeoutMs,
      });

      if (res.empty || !res.task) {
        setPipeline((prev) => ({
          ...prev,
          lastNote: 'Nenhum título pendente encontrado no acervo persistente.',
        }));
        return;
      }

      await syncTasksFromServer();
      if (res.deduplicated) {
        setPipeline((prev) => ({
          ...prev,
          lastNote:
            res.task?.status === 'paused'
              ? 'Já existe uma tarefa global pausada no servidor. Use Retomar ou Cancelar.'
              : 'Já existe uma verificação global em andamento no servidor.',
        }));
      } else if (res.queued) {
        setPipeline((prev) => ({
          ...prev,
          lastNote:
            'Nova tarefa enfileirada automaticamente após a verificação atual.',
        }));
      }
    } catch (err) {
      setPipeline((prev) => ({
        ...prev,
        lastNote:
          err instanceof Error
            ? err.message
            : 'Falha ao iniciar processamento em segundo plano.',
      }));
    }
  };

  const handleVerifyListInBackground = async (list: M3uListRecord) => {
    if (!user) {
      setImportError(
        'Faça login para iniciar a verificação persistente desta lista em segundo plano.'
      );
      return;
    }

    setVerifyingListId(list.id);
    setImportError(null);
    setListActionMsg(null);
    try {
      const res = await startProcessingTask({
        scope: 'list',
        listId: list.id,
        listName: list.name,
        batchSize: settings.batchSize,
        probeTimeoutMs: settings.probeTimeoutMs,
      });

      await syncTasksFromServer();

      if (res.empty || !res.task) {
        setListActionMsg(
          `A lista "${list.name}" não possui itens pendentes ou não publicados para verificar.`
        );
      } else if (res.deduplicated) {
        setListActionMsg(
          `A lista "${list.name}" já possui uma tarefa ${
            res.task.status === 'queued'
              ? 'na fila'
              : res.task.status === 'paused'
                ? 'pausada'
                : 'em andamento'
          } no servidor.`
        );
      } else if (res.queued) {
        setListActionMsg(
          `Verificação da lista "${list.name}" enfileirada automaticamente no servidor (${res.task.totalItems} itens).`
        );
      } else {
        setListActionMsg(
          `Verificação em segundo plano iniciada para "${list.name}" (${res.task.totalItems} itens). O processamento continuará no servidor mesmo se você sair desta página.`
        );
      }
    } catch (err) {
      setImportError(
        err instanceof Error
          ? err.message
          : 'Erro ao iniciar verificação em segundo plano da lista.'
      );
    } finally {
      setVerifyingListId(null);
    }
  };

  const handleTogglePause = async () => {
    if (!activeTask) return;
    try {
      if (activeTask.status === 'paused') {
        await resumeProcessingTask(activeTask.id);
      } else {
        await pauseProcessingTask(activeTask.id);
      }
      await syncTasksFromServer();
    } catch (err) {
      setPipeline((prev) => ({
        ...prev,
        lastNote:
          err instanceof Error ? err.message : 'Falha ao alternar pausa da tarefa.',
      }));
    }
  };

  const handleCancelPipeline = async () => {
    if (!activeTask) return;
    try {
      await cancelProcessingTask(activeTask.id);
      await syncTasksFromServer();
      await refreshItems();
    } catch (err) {
      setPipeline((prev) => ({
        ...prev,
        lastNote:
          err instanceof Error ? err.message : 'Falha ao cancelar tarefa.',
      }));
    }
  };

  const handleProcessSingle = async (item: CatalogItem) => {
    setBusyItemId(item.id);
    try {
      const updated = await processItemFullPipeline(item, settings);
      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      await refreshItems();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Erro ao validar item.';
      setPipeline((prev) => ({
        ...prev,
        lastNote: `Falha ao validar "${item.title}": ${msg}`,
      }));
    } finally {
      setBusyItemId(null);
    }
  };

  const handlePublishBatch = async () => {
    setCatalogActionBusy(true);
    try {
      const { publishedCount } = await publishApprovedOnServer();
      setReclassifyMsg(`${publishedCount} títulos publicados no servidor.`);
      await pullAuthoritativeStateFromServer();
      await refreshItems();
    } catch (err) {
      setReclassifyMsg(err instanceof Error ? err.message : 'Falha ao publicar títulos.');
    } finally {
      setCatalogActionBusy(false);
    }
  };

  const handleTogglePublishSingle = async (item: CatalogItem) => {
    const nextStatus: PublishStatus =
      item.status === 'publicado' ? 'aprovado' : 'publicado';
    setBusyItemId(item.id);
    try {
      await syncWorkPatchToServer(item.id, { status: nextStatus });
      await db.mediaItems.update(item.id, { status: nextStatus, updatedAt: Date.now() });
      await refreshItems();
    } catch (err) {
      setReclassifyMsg(err instanceof Error ? err.message : 'Falha ao alterar a publicação.');
    } finally {
      setBusyItemId(null);
    }
  };

  const handleChangePlatform = async (
    item: CatalogItem,
    platform: PlatformId
  ) => {
    await db.mediaItems.put({
      ...item,
      platform,
      updatedAt: Date.now(),
    });
    void syncWorkPatchToServer(item.id, { platform }).catch((err: Error) => setReclassifyMsg(err.message));
    await refreshItems();
  };

  const handleDeleteItem = async (id: string) => {
    await db.mediaItems.delete(id);
    void deleteWorkOnServer(id);
    await refreshItems();
  };

  const handleClearOffline = async () => {
    const offlineIds = items
      .filter((i) => i.status === 'offline')
      .map((i) => i.id);
    if (offlineIds.length === 0) return;
    await db.mediaItems.bulkDelete(offlineIds);
    for (const id of offlineIds) {
      void deleteWorkOnServer(id);
    }
    await refreshItems();
  };

  const handleClearAllDb = async () => {
    const confirmation = window.prompt(
      'Todas as listas serão removidas do servidor e os títulos serão arquivados. Fichas, favoritos e histórico serão preservados. Digite ZERAR CATÁLOGO para confirmar.'
    );
    if (confirmation !== 'ZERAR CATÁLOGO') return;
    setCatalogActionBusy(true);
    try {
      const result = await resetActiveCatalogOnServer(confirmation);
      setImportStats(null);
      setImportResultMsg(null);
      setReclassifyMsg(`Catálogo zerado no servidor. ${result.removedLists} listas removidas, ${result.archivedWorks} fichas arquivadas.`);
      await refreshItems();
    } catch (err) {
      setReclassifyMsg(err instanceof Error ? err.message : 'Falha ao zerar o catálogo.');
    } finally {
      setCatalogActionBusy(false);
    }
  };

  const handleDeleteM3uList = async (list: M3uListRecord) => {
    setDeletingListId(list.id);
    setListActionMsg(null);
    try {
      const res = await deleteM3uList(list.id);
      setConfirmDeleteListId(null);
      await refreshItems();
      setListActionMsg(
        `Lista "${list.name}" excluída: ${res.removedSources} fontes removidas, ${res.updatedItems} títulos mantidos com outras listas e ${res.archivedItems} fichas arquivadas (metadados, favoritos e histórico preservados até reimportação).`
      );
    } catch (err) {
      setListActionMsg(err instanceof Error ? err.message : 'Falha ao excluir lista.');
    } finally {
      setDeletingListId(null);
    }
  };

  const handleRunManualMigration = async () => {
    setMigrationBusy(true);
    setMigrationMsg(null);
    try {
      const summary = await runIndexedDbMigrationToServer('manual_admin');
      await refreshItems();
      if (summary) {
        setMigrationMsg(
          `Backup ${summary.backupId} criado e acervo sincronizado: ${summary.createdWorks} novos títulos, ${summary.mergedWorks} mesclados sem sobrescrita, ${summary.createdFavorites} favoritos e ${summary.migratedHistory} registros de progresso.`
        );
      } else {
        setMigrationMsg('Faça login com Google para sincronizar o backup na nuvem.');
      }
    } catch (err) {
      setMigrationMsg(
        err instanceof Error ? err.message : 'Falha na sincronização do acervo.'
      );
    } finally {
      setMigrationBusy(false);
    }
  };

  const handleRestoreLocalSnapshot = async () => {
    setMigrationBusy(true);
    setMigrationMsg(null);
    try {
      const ok = await restoreLocalBackupSnapshot();
      await refreshItems();
      setMigrationMsg(
        ok
          ? 'Snapshot local restaurado no cache do dispositivo.'
          : 'Nenhum snapshot local encontrado ainda.'
      );
    } finally {
      setMigrationBusy(false);
    }
  };

  const handleRollbackServerBackup = async (backupId: string) => {
    setMigrationBusy(true);
    setMigrationMsg(null);
    try {
      const res = await rollbackServerMigration(backupId);
      await refreshItems();
      setMigrationMsg(
        `Rollback concluído (${res.backupId}): ${res.revertedWorks} títulos, ${res.revertedLists} listas, ${res.revertedSources} fontes, ${res.revertedFavorites} favoritos e ${res.revertedHistory} históricos revertidos.`
      );
    } catch (err) {
      setMigrationMsg(
        err instanceof Error ? err.message : 'Falha ao executar rollback.'
      );
    } finally {
      setMigrationBusy(false);
    }
  };

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    const updated = await saveSettings({
      tmdbApiKey: tmdbKey.trim(),
      youtubeApiKey: youtubeKey.trim(),
      streamProxyPrefix: streamProxyPrefix.trim(),
      autoProxyHttpStreams,
      batchSize: Math.min(12, Math.max(1, Number(batchSize) || 4)),
      probeTimeoutMs: Math.min(
        15000,
        Math.max(2000, Number(probeTimeoutMs) || 6500)
      ),
    });
    onSettingsUpdated(updated);
    setTmdbLocked(true);
    setYoutubeLocked(true);
    setSettingsSavedMsg(true);
    window.setTimeout(() => setSettingsSavedMsg(false), 3000);
  };

  const xtreamPreviewUrl = useMemo(() => {
    if (!xtreamServerUrl.trim() || !xtreamUsername.trim()) return '';
    return buildXtreamM3uUrl({
      serverUrl: xtreamServerUrl.trim(),
      username: xtreamUsername.trim(),
      password: xtreamPassword ? '••••••' : '',
    });
  }, [xtreamServerUrl, xtreamUsername, xtreamPassword]);

  const renderSourceImporter = (stayOnLists: boolean) => (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/10 bg-[#121417] p-5 space-y-5">
        {/* Mode Switcher */}
        <div className="flex flex-wrap gap-2 border-b border-white/10 pb-4">
          <button
            type="button"
            onClick={() => {
              setImportError(null);
              setImportSourceMode('file');
            }}
            className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              importSourceMode === 'file'
                ? 'bg-white text-[#0B0C0E]'
                : 'bg-[#181B20] text-white/75 hover:bg-white/10 hover:text-white'
            }`}
          >
            <FileUp className="h-3.5 w-3.5" />
            1. Arquivo .m3u / .m3u8 Local
          </button>

          <button
            type="button"
            onClick={() => {
              setImportError(null);
              setImportSourceMode('url');
            }}
            className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              importSourceMode === 'url'
                ? 'bg-white text-[#0B0C0E]'
                : 'bg-[#181B20] text-white/75 hover:bg-white/10 hover:text-white'
            }`}
          >
            <FileJson className="h-3.5 w-3.5" />
            2. URL Direta (M3U ou JSON)
          </button>

          <button
            type="button"
            onClick={() => {
              setImportError(null);
              setImportSourceMode('xtream');
            }}
            className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              importSourceMode === 'xtream'
                ? 'bg-white text-[#0B0C0E]'
                : 'bg-[#181B20] text-white/75 hover:bg-white/10 hover:text-white'
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            3. Credenciais Xtream Codes
          </button>
        </div>

        {/* Optional List Nickname */}
        <div className="space-y-1.5">
          <label
            htmlFor={`m3u-list-nickname-${stayOnLists ? 'lists' : 'import'}`}
            className="flex items-center gap-2 text-xs font-bold text-white"
          >
            <Server className="h-3.5 w-3.5 text-[#E50914]" />
            Apelido da Lista / Servidor (Opcional)
          </label>
          <input
            id={`m3u-list-nickname-${stayOnLists ? 'lists' : 'import'}`}
            type="text"
            value={listCustomName}
            onChange={(e) => setListCustomName(e.target.value)}
            placeholder="Ex.: Servidor Principal 4K, Feed Catálogo Web, Lista Backup..."
            className="w-full rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
          />
        </div>

        {/* Mode 1: Local .m3u / .m3u8 File (Streaming / Chunks) */}
        {importSourceMode === 'file' && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => handleDrop(e, stayOnLists)}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
              isDragging
                ? 'border-[#E50914] bg-[#E50914]/10'
                : 'border-white/15 bg-[#0B0C0E]/60 hover:border-white/30'
            }`}
          >
            <FileUp className="mb-3 h-9 w-9 text-white/55" />
            <h3 className="font-display text-base font-bold text-white">
              Upload Direto de Arquivo .M3U / .M3U8 (Streaming por Chunks)
            </h3>
            <p className="mt-1 max-w-lg text-xs leading-relaxed text-white/60">
              Suporta listas grandes (200 MB+) sem travar o navegador, com
              agrupamento automático de fontes (4K prioritário) e mesclagem
              inteligente no IndexedDB.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".m3u,.m3u8,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void handleFileImport(file, stayOnLists);
                  e.target.value = '';
                }
              }}
            />

            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-5 text-xs font-bold text-[#0B0C0E] hover:bg-white/90 disabled:opacity-50"
              >
                <Upload className="h-4 w-4" />
                Selecionar Arquivo .M3U / .M3U8
              </button>

              <button
                type="button"
                disabled={importing}
                onClick={() => void handleSampleImport(stayOnLists)}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/20 bg-[#181B20] px-4 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50"
              >
                Testar com Snippet Real M3U + Canais TV
              </button>
            </div>
          </div>
        )}

        {/* Mode 2: Direct URL (M3U or JSON Catalog via /api/fetch-list) */}
        {importSourceMode === 'url' && (
          <form
            onSubmit={(e) => void handleUrlImport(e, stayOnLists)}
            className="space-y-3 rounded-xl border border-white/10 bg-[#0B0C0E]/60 p-5"
          >
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <Link2 className="h-4 w-4 text-[#E50914]" />
              URL Direta (Lista M3U ou Catálogo JSON)
            </div>
            <p className="text-xs leading-relaxed text-white/60">
              Requisitada via backend (<code>/api/fetch-list</code>) para evitar
              bloqueios de CORS. Detecta automaticamente{' '}
              <code>#EXTM3U / #EXTINF</code>, catálogos <code>JSON</code>{' '}
              (mapeando <code>title/name</code>, <code>url/stream_url</code>,{' '}
              <code>poster/logo/cover</code>, <code>category/group</code> e{' '}
              <code>type</code>) e alerta se o link for uma página HTML.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="url"
                value={m3uUrl}
                onChange={(e) => setM3uUrl(e.target.value)}
                placeholder="https://meusite.pages.dev/catalog.json ou http://servidor.com/lista.m3u"
                className="flex-1 rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2.5 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
              />
              <button
                type="submit"
                disabled={importing || !m3uUrl.trim()}
                className="inline-flex h-[42px] items-center justify-center gap-2 rounded-lg bg-[#E50914] px-5 text-xs font-bold text-white hover:bg-[#c80812] disabled:opacity-45 whitespace-nowrap"
              >
                <Globe className="h-4 w-4" />
                {importing ? 'Importando...' : 'Buscar e Importar'}
              </button>
            </div>
          </form>
        )}

        {/* Mode 3: Xtream Codes Credentials */}
        {importSourceMode === 'xtream' && (
          <form
            onSubmit={(e) => void handleXtreamImport(e, stayOnLists)}
            className="space-y-4 rounded-xl border border-white/10 bg-[#0B0C0E]/60 p-5"
          >
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <KeyRound className="h-4 w-4 text-[#E50914]" />
              Conectar via Credenciais Xtream Codes
            </div>
            <p className="text-xs leading-relaxed text-white/60">
              Gera automaticamente a URL M3U Plus (
              <code>
                {'{servidor}'}/get.php?username={'{user}'}&amp;password=
                {'{pass}'}&amp;type=m3u_plus&amp;output=ts
              </code>
              ) e salva as credenciais na tabela <code>m3u_lists</code> para
              re-sincronização futura em 1 clique.
            </p>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-3">
                <label className="block text-[11px] font-semibold text-white/75">
                  URL do Servidor
                </label>
                <input
                  type="text"
                  required
                  value={xtreamServerUrl}
                  onChange={(e) => setXtreamServerUrl(e.target.value)}
                  placeholder="http://servidor.com:8080"
                  className="w-full rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] font-semibold text-white/75">
                  Usuário
                </label>
                <input
                  type="text"
                  required
                  value={xtreamUsername}
                  onChange={(e) => setXtreamUsername(e.target.value)}
                  placeholder="usuario_xtream"
                  className="w-full rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
                />
              </div>

              <div className="space-y-1 sm:col-span-2">
                <label className="block text-[11px] font-semibold text-white/75">
                  Senha
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type={showXtreamPassword ? 'text' : 'password'}
                    required
                    value={xtreamPassword}
                    onChange={(e) => setXtreamPassword(e.target.value)}
                    placeholder="••••••••"
                    className="flex-1 rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowXtreamPassword((s) => !s)}
                    aria-label={
                      showXtreamPassword ? 'Ocultar senha' : 'Mostrar senha'
                    }
                    className="inline-flex h-[38px] items-center justify-center rounded-lg border border-white/15 bg-[#181B20] px-3 text-white/75 hover:bg-white/10"
                  >
                    {showXtreamPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {xtreamPreviewUrl && (
              <div className="rounded-lg border border-white/10 bg-[#121417] px-3 py-2 text-[11px] text-white/60">
                <span className="font-semibold text-white/80">
                  URL gerada:{' '}
                </span>
                <span className="break-all font-mono">{xtreamPreviewUrl}</span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={
                  importing ||
                  !xtreamServerUrl.trim() ||
                  !xtreamUsername.trim() ||
                  !xtreamPassword.trim()
                }
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#E50914] px-5 text-xs font-bold text-white hover:bg-[#c80812] disabled:opacity-45"
              >
                <Server className="h-4 w-4" />
                {importing ? 'Conectando...' : 'Conectar e Importar Xtream'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Live Import Progress */}
      {(importing || importStats) && (
        <div className="rounded-xl border border-white/12 bg-[#121417] p-5 space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-white">
              {importing
                ? uploadProgress ? 'Enviando títulos e fontes ao servidor…' : 'Lendo e agrupando entradas…'
                : importStats?.detectedFormat === 'json'
                  ? 'Catálogo JSON processado e salvo no IndexedDB'
                  : 'Lista M3U processada e salva no IndexedDB'}
            </span>
            {importing && (
              <button
                type="button"
                onClick={() => importAbortRef.current?.abort()}
                className="text-rose-400 hover:underline"
              >
                {uploadProgress ? 'Interromper envio' : 'Cancelar leitura'}
              </button>
            )}
          </div>

          {importStats && (
            <>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-[#E50914] transition-all duration-150"
                  style={{
                    width: `${
                      importing && uploadProgress
                        ? Math.round(100 * uploadProgress.confirmed / Math.max(1, uploadProgress.total))
                        : importStats.totalBytes > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (importStats.bytesRead / importStats.totalBytes) *
                                100
                            )
                          )
                        : importing
                          ? 60
                          : 100
                    }%`,
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 pt-1 text-xs text-white/75 sm:grid-cols-4 tabular-nums">
                <div>
                  <span className="text-white/45 block">Lido</span>
                  {(importStats.bytesRead / (1024 * 1024)).toFixed(2)} MB
                </div>
                <div>
                  <span className="text-white/45 block">Entradas Lidas</span>
                  {importStats.rawEntries}
                </div>
                <div>
                  <span className="text-white/45 block">Títulos Novos</span>
                  {importStats.groupedItems}
                </div>
                <div>
                  <span className="text-white/45 block">
                    Filmes / Séries / TV / Rádio
                  </span>
                  {importStats.byKind.movie} / {importStats.byKind.series} /{' '}
                  {importStats.byKind.live} / {importStats.byKind.radio}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 border-t border-white/10 pt-3 text-xs tabular-nums">
                <div>
                  <span className="text-white/45 block">Inéditos (Fila)</span>
                  <span className="font-semibold text-amber-300">
                    {importStats.newItems}
                  </span>
                </div>
                <div>
                  <span className="text-white/45 block">
                    Mesclados em Existentes
                  </span>
                  <span className="font-semibold text-emerald-300">
                    {importStats.mergedSources}
                  </span>
                </div>
                <div>
                  <span className="text-white/45 block">
                    Duplicados Ignorados
                  </span>
                  <span className="font-semibold text-white/65">
                    {importStats.ignoredDuplicates}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {importError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <div className="flex-1 space-y-1">
            <p className="font-semibold text-rose-100">
              Não foi possível importar a fonte informada
            </p>
            <p className="leading-relaxed">{importError}</p>
          </div>
          <button
            type="button"
            onClick={() => setImportError(null)}
            className="text-rose-200/70 hover:text-white shrink-0"
          >
            Fechar
          </button>
        </div>
      )}
    </div>
  );

  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-4 pt-28 pb-20 sm:px-8 lg:px-12">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-[#E50914] uppercase">
            <ShieldCheck className="h-4 w-4" />
            Painel Administrativo · IndexedDB
          </div>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-white">
            Motor M3U, EPG, Validação e Player Real
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBackHome}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-[#121417] px-4 py-2 text-xs font-semibold text-white/85 hover:bg-white/10"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Voltar ao Início
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="mb-8 flex flex-wrap items-center gap-2 border-b border-white/10 pb-4">
        <button
          type="button"
          onClick={() => setActiveTab('queue')}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            activeTab === 'queue'
              ? 'bg-white text-[#0B0C0E]'
              : 'bg-[#121417] text-white/75 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Database className="h-4 w-4" />
          Fila de Pré-Publicação ({counts.total})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('import')}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            activeTab === 'import'
              ? 'bg-white text-[#0B0C0E]'
              : 'bg-[#121417] text-white/75 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Upload className="h-4 w-4" />
          Importar M3U & EPG
        </button>

        <button
          type="button"
          onClick={() => {
            setConfirmDeleteListId(null);
            setActiveTab('lists');
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            activeTab === 'lists'
              ? 'bg-white text-[#0B0C0E]'
              : 'bg-[#121417] text-white/75 hover:bg-white/10 hover:text-white'
          }`}
        >
          <List className="h-4 w-4" />
          Listas ({m3uLists.length})
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('servers');
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            activeTab === 'servers'
              ? 'bg-white text-[#0B0C0E]'
              : 'bg-[#121417] text-white/75 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Server className="h-4 w-4" />
          Servidores ({servers.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            activeTab === 'settings'
              ? 'bg-white text-[#0B0C0E]'
              : 'bg-[#121417] text-white/75 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Settings className="h-4 w-4" />
          Configurações de API
        </button>
      </div>

      {/* TAB 1: PRE-PUBLICATION QUEUE & PIPELINE */}
      {(importing || resyncingListId) && uploadProgress && (
        <div className="mb-6 rounded-lg border border-white/15 bg-[#121417] px-4 py-3 text-sm text-white">
          <div role="status">
            <p>Enviando ao servidor · {uploadProgress.confirmed.toLocaleString('pt-BR')} de {uploadProgress.total.toLocaleString('pt-BR')} títulos confirmados</p>
            <p className="mt-1 text-xs text-white/70">
              {uploadProgress.sources.toLocaleString('pt-BR')} fontes confirmadas nesta importação.
              A verificação e a publicação ficam disponíveis após o envio.
            </p>
          </div>
          {(activeTab === 'queue' || Boolean(resyncingListId)) && (
            <button type="button" onClick={() => importAbortRef.current?.abort()} className="mt-2 text-xs text-rose-300 hover:underline">
              Interromper envio
            </button>
          )}
        </div>
      )}
      {activeTab === 'queue' && (
        <div className="space-y-6">
          {pendingListIds.length > 0 && !importing && !resyncingListId && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <p>Há listas com envio pendente. Retome o envio para liberar a verificação.</p>
              <button type="button" onClick={() => setActiveTab('lists')} className="font-semibold underline">
                Abrir Listas
              </button>
            </div>
          )}
          {/* Summary Stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-white/10 bg-[#121417] p-4">
              <p className="text-xs text-white/55">Títulos no catálogo local</p>
              <p className="mt-1 font-display text-2xl font-bold text-white tabular-nums">
                {counts.total}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#121417] p-4">
              <p className="text-xs text-white/55">Pendentes</p>
              <p className="mt-1 font-display text-2xl font-bold text-amber-400 tabular-nums">
                {counts.pendente}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#121417] p-4">
              <p className="text-xs text-white/55">Aprovados</p>
              <p className="mt-1 font-display text-2xl font-bold text-emerald-400 tabular-nums">
                {counts.aprovado}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#121417] p-4">
              <p className="text-xs text-white/55">Offline</p>
              <p className="mt-1 font-display text-2xl font-bold text-rose-400 tabular-nums">
                {counts.offline}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#121417] p-4">
              <p className="text-xs text-white/55">Publicados na Home</p>
              <p className="mt-1 font-display text-2xl font-bold text-white tabular-nums">
                {counts.publicado}
              </p>
            </div>
          </div>

          {/* Pipeline Control Dock */}
          <div className="rounded-xl border border-white/12 bg-[#121417] p-5 space-y-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="font-display text-lg font-bold text-white">
                  Pipeline de Pré-Publicação
                </h2>
                <p className="text-xs text-white/60">
                  Verifica as fontes. Ficha e trailer são buscados ao abrir o título.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {!pipeline.running ? (
                  <button
                    type="button"
                    disabled={counts.pendente === 0 || importing || Boolean(resyncingListId) || pendingListIds.length > 0 || catalogActionBusy}
                    onClick={handleRunBatchPipeline}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#E50914] px-4 text-xs font-bold text-white transition-colors hover:bg-[#c80812] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Sparkles className="h-4 w-4" />
                    Processar Pendentes ({counts.pendente})
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleTogglePause}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 text-xs font-bold text-white hover:bg-white/20"
                    >
                      {pipeline.paused ? (
                        <>
                          <Play className="h-4 w-4" />
                          Retomar
                        </>
                      ) : (
                        <>
                          <Pause className="h-4 w-4" />
                          Pausar
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelPipeline}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/15 px-4 text-xs font-bold text-rose-200 hover:bg-rose-500/25"
                    >
                      Cancelar
                    </button>
                  </>
                )}

                <button
                  type="button"
                  disabled={counts.aprovado === 0 || importing || Boolean(resyncingListId) || pendingListIds.length > 0 || catalogActionBusy}
                  onClick={handlePublishBatch}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-xs font-bold text-[#0B0C0E] transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Rocket className="h-4 w-4" />
                  Publicar Aprovados ({counts.aprovado})
                </button>

                <button
                  type="button"
                  disabled={counts.total === 0}
                  onClick={handleReclassify}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-white/20 bg-[#181B20] px-3.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-40"
                >
                  <Wand2 className="h-3.5 w-3.5 text-amber-300" />
                  Unificar Duplicados no Catálogo
                </button>

                {counts.offline > 0 && (
                  <button
                    type="button"
                    onClick={handleClearOffline}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-white/15 bg-[#181B20] px-3 text-xs font-medium text-white/80 hover:bg-white/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Limpar Offline
                  </button>
                )}

                {(counts.total > 0 || m3uLists.length > 0) && (
                  <button
                    type="button"
                    onClick={handleClearAllDb}
                    disabled={catalogActionBusy || pipeline.running || importing || Boolean(resyncingListId) || Boolean(deletingListId)}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs font-medium text-white/55 hover:border-rose-500/40 hover:text-rose-300"
                  >
                    Zerar Banco
                  </button>
                )}
              </div>
            </div>

            {reclassifyMsg && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-200">
                {reclassifyMsg}
              </div>
            )}

            {importResultMsg && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-xs text-sky-100">
                <span>{importResultMsg}</span>
                <button
                  type="button"
                  onClick={() => setImportResultMsg(null)}
                  className="text-white/60 hover:text-white shrink-0"
                >
                  Dispensar
                </button>
              </div>
            )}

            {(pipeline.running || pipeline.processed > 0 || pipeline.lastNote) && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-white">
                    {pipeline.running
                      ? pipeline.paused
                        ? `Pausado em: ${pipeline.currentTitle}`
                        : `Processando (${
                            pipeline.currentStage === 'health'
                              ? 'Etapa A · Health Check'
                              : pipeline.currentStage === 'tmdb'
                                ? 'Etapa B · TMDB pt-BR'
                                : 'Etapa C · Trailer YouTube'
                          }): ${pipeline.currentTitle}`
                      : activeTask?.status === 'cancelled'
                        ? `Cancelado pelo usuário · ${pipeline.processed}/${pipeline.total} itens processados`
                        : `Lote finalizado · ${pipeline.approved} aprovados · ${pipeline.pendingCors || 0} pendentes (CORS/Proxy) · ${pipeline.offline} offline${pipeline.failed ? ` · ${pipeline.failed} falhas` : ''}`}
                    {activeTask?.listName ? ` · Lista: ${activeTask.listName}` : ''}
                    {queuedTasks.length > 0 ? ` · +${queuedTasks.length} na fila` : ''}
                  </span>
                  <span className="text-white/65 tabular-nums">
                    {pipeline.processed} / {pipeline.total}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-[#E50914] transition-all duration-200"
                    style={{
                      width: `${
                        pipeline.total > 0
                          ? Math.round((pipeline.processed / pipeline.total) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
                {pipeline.lastNote && (
                  <p className="text-[11px] text-amber-300/85">
                    Nota: {pipeline.lastNote}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Queue Filters */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-white/10 bg-[#121417] p-1">
              {(
                [
                  ['all', 'Todos'],
                  ['pendente', 'Pendentes'],
                  ['aprovado', 'Aprovados'],
                  ['offline', 'Offline'],
                  ['publicado', 'Publicados'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStatusFilter(key)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    statusFilter === key
                      ? 'bg-white text-[#0B0C0E]'
                      : 'text-white/70 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={kindFilter}
                onChange={(e) =>
                  setKindFilter(e.target.value as 'all' | MediaKind)
                }
                aria-label="Filtrar por tipo"
                className="rounded-lg border border-white/15 bg-[#121417] px-3 py-2 text-xs font-medium text-white focus:outline-none"
              >
                <option value="all">Todos os tipos</option>
                <option value="movie">Filmes (movie)</option>
                <option value="series">Séries (series)</option>
                <option value="live">TV ao Vivo (live)</option>
                <option value="radio">Rádios (radio)</option>
              </select>

              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Filtrar fila por título..."
                className="w-56 rounded-lg border border-white/15 bg-[#121417] px-3 py-2 text-xs text-white placeholder:text-white/40 focus:border-white/35 focus:outline-none"
              />
            </div>
          </div>

          {/* Queue Table */}
          {loadingDb ? (
            <div className="rounded-xl border border-white/10 bg-[#121417] p-12 text-center text-sm text-white/60">
              Carregando IndexedDB...
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-[#121417] p-12 text-center space-y-4">
              <Database className="mx-auto h-10 w-10 text-white/25" />
              <div>
                <p className="font-display text-lg font-bold text-white">
                  {counts.total === 0
                    ? 'Nenhum item importado no IndexedDB'
                    : 'Nenhum item corresponde aos filtros'}
                </p>
                <p className="mt-1 text-sm text-white/55">
                  {counts.total === 0
                    ? 'Importe um arquivo .m3u (até 200 MB+), informe uma URL ou teste com o snippet M3U real.'
                    : 'Ajuste os filtros de status ou tipo para visualizar os registros.'}
                </p>
              </div>
              {counts.total === 0 && (
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveTab('import')}
                    className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-xs font-bold text-[#0B0C0E]"
                  >
                    <Upload className="h-4 w-4" />
                    Ir para Importador M3U
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSampleImport(false)}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-[#181B20] px-4 py-2 text-xs font-semibold text-white hover:bg-white/10"
                  >
                    Carregar Exemplo Real M3U
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#121417]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-white/10 text-xs font-semibold text-white/55">
                    <tr>
                      <th className="px-4 py-3">Título</th>
                      <th className="px-4 py-3">Tipo</th>
                      <th className="px-4 py-3">Plataforma</th>
                      <th className="px-4 py-3">Fontes</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {pagedItems.map((item) => {
                      const kind = item.type;
                      const st = item.status || 'pendente';
                      const sources = item.sources || [];
                      const onlineCount = sources.filter(
                        (s) => s.status === 'online'
                      ).length;
                      const confirmedCount = sources.filter(
                        (s) => s.validationState === 'playback_confirmed'
                      ).length;
                      const blockedCount = sources.filter(
                        (s) =>
                          s.validationState === 'cors_blocked' ||
                          s.validationState === 'proxy_blocked'
                      ).length;
                      const htmlCount = sources.filter(
                        (s) => s.validationState === 'html_challenge'
                      ).length;
                      const offlineCount = sources.filter(
                        (s) => s.status === 'offline'
                      ).length;

                      return (
                        <tr
                          key={item.id}
                          className="transition-colors hover:bg-white/[0.03]"
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-[#0B0C0E]">
                                <MediaImage
                                  src={item.tvgLogo || item.posterImage}
                                  alt={item.title}
                                  className="h-full w-full object-cover"
                                />
                              </div>
                              <div className="min-w-0">
                                <button
                                  type="button"
                                  onClick={() => onSelectItem(item)}
                                  className="truncate font-semibold text-white hover:underline text-left block max-w-[260px]"
                                >
                                  {item.title}
                                </button>
                                <p className="text-xs text-white/55 tabular-nums">
                                  {item.year}
                                  {item.tvgId ? ` · ID: ${item.tvgId}` : ''}
                                  {item.qualityBadge
                                    ? ` · ${item.qualityBadge}`
                                    : ''}
                                  {item.voteAverage
                                    ? ` · TMDB ${item.voteAverage}`
                                    : ''}
                                  {item.youtubeTrailerId ? ' · Trailer YT' : ''}
                                </p>
                              </div>
                            </div>
                          </td>

                          <td className="px-4 py-3 text-xs text-white/80">
                            <span>{KIND_LABELS[kind]}</span>
                            {kind === 'series' && item.episodes && (
                              <span className="block text-[11px] text-white/45 tabular-nums">
                                {item.episodes.length} eps agrupados
                              </span>
                            )}
                          </td>

                          <td className="px-4 py-3">
                            <select
                              value={item.platform}
                              onChange={(e) =>
                                handleChangePlatform(
                                  item,
                                  e.target.value as PlatformId
                                )
                              }
                              aria-label={`Plataforma de ${item.title}`}
                              className="rounded border border-white/10 bg-[#0B0C0E] px-2 py-1 text-xs text-white/85 focus:outline-none"
                            >
                              {Object.entries(PLATFORM_LABELS).map(
                                ([id, label]) => (
                                  <option key={id} value={id}>
                                    {label}
                                  </option>
                                )
                              )}
                            </select>
                          </td>

                          <td className="px-4 py-3 text-xs text-white/75 tabular-nums">
                            <span>
                              {sources.length}{' '}
                              {sources.length === 1 ? 'fonte' : 'fontes'}
                            </span>
                            {sources.length > 0 && (
                              <span className="block truncate max-w-[160px] text-[11px] text-white/45">
                                {sources.map((s) => s.qualityTag || s.label).join(', ')}
                              </span>
                            )}
                            {(item.healthChecked ||
                              confirmedCount > 0 ||
                              blockedCount > 0 ||
                              htmlCount > 0) && (
                              <span className="block text-[11px] space-x-1.5">
                                {confirmedCount > 0 ? (
                                  <span className="text-emerald-400">
                                    {confirmedCount} confirmada{confirmedCount > 1 ? 's' : ''}
                                  </span>
                                ) : onlineCount > 0 ? (
                                  <span className="text-emerald-400/80">
                                    {onlineCount} online
                                  </span>
                                ) : null}
                                {blockedCount > 0 && (
                                  <span className="text-amber-300">
                                    {blockedCount} CORS/Proxy
                                  </span>
                                )}
                                {htmlCount > 0 && (
                                  <span className="text-sky-300">
                                    {htmlCount} HTML
                                  </span>
                                )}
                                {offlineCount > 0 &&
                                  onlineCount === 0 &&
                                  blockedCount === 0 && (
                                    <span className="text-rose-400/85">
                                      {offlineCount} offline
                                    </span>
                                  )}
                              </span>
                            )}
                          </td>

                          <td className="px-4 py-3 text-xs font-semibold">
                            {st === 'publicado' && (
                              <span className="inline-flex items-center gap-1 text-white">
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                {STATUS_LABELS[st]}
                              </span>
                            )}
                            {st === 'aprovado' && (
                              <span className="text-emerald-400">
                                {STATUS_LABELS[st]}
                              </span>
                            )}
                            {st === 'pendente' && (
                              <span className="text-amber-400">
                                {STATUS_LABELS[st]}
                              </span>
                            )}
                            {st === 'offline' && (
                              <span className="inline-flex items-center gap-1 text-rose-400">
                                <WifiOff className="h-3.5 w-3.5" />
                                {STATUS_LABELS[st]}
                              </span>
                            )}
                          </td>

                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busyItemId === item.id}
                                onClick={() => handleProcessSingle(item)}
                                title="Testar disponibilidade da fonte"
                                className="rounded border border-white/15 bg-[#181B20] px-2.5 py-1 text-xs font-medium text-white/85 hover:bg-white/10 disabled:opacity-40"
                              >
                                <RefreshCw
                                  className={`inline h-3 w-3 mr-1 ${
                                    busyItemId === item.id ? 'animate-spin' : ''
                                  }`}
                                />
                                Validar
                              </button>

                              <button
                                type="button"
                                onClick={() => handleTogglePublishSingle(item)}
                                className={`rounded px-2.5 py-1 text-xs font-semibold ${
                                  st === 'publicado'
                                    ? 'border border-white/15 text-white/70 hover:bg-white/10'
                                    : 'bg-white text-[#0B0C0E] hover:bg-white/90'
                                }`}
                              >
                                {st === 'publicado' ? 'Ocultar' : 'Publicar'}
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDeleteItem(item.id)}
                                aria-label={`Excluir ${item.title}`}
                                className="rounded p-1.5 text-white/45 hover:bg-rose-500/15 hover:text-rose-300"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs text-white/60 tabular-nums">
                  <span>
                    Página {page} de {totalPages} ({filteredItems.length} itens)
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="rounded border border-white/15 px-3 py-1 text-white/80 disabled:opacity-35"
                    >
                      Anterior
                    </button>
                    <button
                      type="button"
                      disabled={page >= totalPages}
                      onClick={() =>
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                      className="rounded border border-white/15 px-3 py-1 text-white/80 disabled:opacity-35"
                    >
                      Próxima
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: STREAMING M3U & XMLTV EPG IMPORTER */}
      {activeTab === 'import' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {renderSourceImporter(false)}

            {/* EPG XMLTV (.xml / .xml.gz) Import */}
            <form
              onSubmit={handleImportEpg}
              className="rounded-xl border border-white/10 bg-[#121417] p-6 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-bold text-white">
                  <CalendarClock className="h-4 w-4 text-[#E50914]" />
                  Guia de Programação (EPG XMLTV .xml / .xml.gz)
                </div>
                <span className="text-xs text-white/55 tabular-nums">
                  {epgCount} programas no IndexedDB
                </span>
              </div>
              <p className="text-xs text-white/60">
                Vincula automaticamente a grade “Agora” e “A seguir” aos canais
                de TV ao Vivo pelo atributo <code>tvg-id</code>.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="url"
                  value={epgUrlInput}
                  onChange={(e) => setEpgUrlInput(e.target.value)}
                  placeholder="https://exemplo.com/epg.xml.gz"
                  className="flex-1 rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2.5 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={epgLoading || !epgUrlInput.trim()}
                  className="inline-flex h-[42px] items-center justify-center gap-2 rounded-lg bg-white px-5 text-xs font-bold text-[#0B0C0E] hover:bg-white/90 disabled:opacity-45 whitespace-nowrap"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${epgLoading ? 'animate-spin' : ''}`}
                  />
                  {epgLoading ? 'Importando EPG...' : 'Importar EPG'}
                </button>
              </div>
              {epgStatusMsg && (
                <p className="text-xs text-emerald-400">{epgStatusMsg}</p>
              )}
              {epgError && (
                <p className="text-xs text-rose-400">{epgError}</p>
              )}
            </form>
          </div>

          {/* Rules Summary Card */}
          <div className="rounded-xl border border-white/10 bg-[#121417] p-6 space-y-4 text-xs text-white/70 leading-relaxed">
            <h3 className="font-display text-base font-bold text-white">
              Regras de Classificação & Fontes
            </h3>
            <div>
              <p className="font-semibold text-white">
                3 Modos de Entrada (M3U / JSON / Xtream)
              </p>
              <p>
                Importe arquivos <code>.m3u/.m3u8</code> por chunks, URLs
                diretas (detectando automaticamente <code>#EXTM3U</code>,{' '}
                <code>JSON</code> ou avisando caso seja página HTML) ou
                credenciais <strong>Xtream Codes</strong>.
              </p>
            </div>
            <div>
              <p className="font-semibold text-white">Filmes vs. TV ao Vivo</p>
              <p>
                Apenas URLs com <code>/movie/</code> ou terminadas em{' '}
                <code>.mp4/.mkv/.avi</code> viram Filmes. Streams sem extensão,{' '}
                <code>.ts</code>, <code>.m3u8</code> ou <code>/live/</code>{' '}
                entram estritamente em TV ao Vivo.
              </p>
            </div>
            <div>
              <p className="font-semibold text-white">
                Agrupamento de Canais (FHD/HD/SD/Alt)
              </p>
              <p>
                Sufixos como <code>FHD</code>, <code>HD</code>, <code>SD</code>,{' '}
                <code>H265</code>, <code>[1]</code>, <code>[Alt]</code> e{' '}
                <code>Backup</code> são removidos do título principal e salvos
                como opções em <code>sources</code>.
              </p>
            </div>
            <div>
              <p className="font-semibold text-white">
                Mesclagem Inteligente
              </p>
              <p>
                Links idênticos já publicados são ignorados sem duplicar; novos
                links de títulos publicados entram direto como fonte extra sem
                voltar para a fila pendente.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: M3U LISTS & SERVERS MANAGER */}
      {activeTab === 'lists' && (
        <div className="space-y-6">
          <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-[#121417] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-lg font-bold text-white">
                Gerenciador de Listas, Catálogos JSON & Servidores Xtream
              </h2>
              <p className="mt-1 text-xs text-white/60">
                Adicione novas fontes por arquivo local, URL direta (M3U ou
                JSON) ou credenciais Xtream Codes. Excluir uma lista remove
                apenas os links dela e arquiva fichas sem fontes restantes,
                preservando metadados, favoritos e histórico
                {archivedCount > 0
                  ? ` (${archivedCount} fichas arquivadas no acervo).`
                  : '.'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowAddSourceInLists((v) => !v)}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-[#E50914] px-4 text-xs font-bold text-white hover:bg-[#c80812]"
            >
              <Plus className="h-4 w-4" />
              {showAddSourceInLists
                ? 'Ocultar Painel de Importação'
                : 'Adicionar Nova Fonte'}
            </button>
          </div>

          {showAddSourceInLists && renderSourceImporter(true)}

          {listActionMsg && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
              <span>{listActionMsg}</span>
              <div className="flex items-center gap-3 shrink-0">
                {counts.pendente > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('queue')}
                    className="rounded-md bg-white px-3 py-1 text-[11px] font-bold text-[#0B0C0E] hover:bg-white/90"
                  >
                    Abrir Fila ({counts.pendente} pendentes)
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setListActionMsg(null)}
                  className="text-white/60 hover:text-white"
                >
                  Dispensar
                </button>
              </div>
            </div>
          )}

          {m3uLists.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-[#121417] p-10 text-center">
              <Server className="mx-auto mb-3 h-9 w-9 text-white/35" />
              <p className="text-sm font-semibold text-white">
                Nenhuma lista ou servidor registrado ainda.
              </p>
              <p className="mt-1 text-xs text-white/55">
                Use os 3 modos acima (Arquivo Local, URL M3U/JSON ou Xtream
                Codes) para importar sua primeira fonte.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {m3uLists.map((list) => {
                const live = listLiveStats.get(list.id) || {
                  titleCount: 0,
                  sourceCount: 0,
                };
                const isConfirming = confirmDeleteListId === list.id;
                const isDeleting = deletingListId === list.id;
                const isResyncing = resyncingListId === list.id;
                const uploadPending = pendingListIds.includes(list.id);
                const uploadProgress = pendingListProgress[list.id];
                const canResync = uploadPending ||
                  (list.sourceType === 'xtream' &&
                    Boolean(list.xtreamCredentials)) ||
                  ((list.sourceType === 'url' || list.sourceType === 'json') &&
                    Boolean(list.sourceLocation));

                const originBadge =
                  list.sourceType === 'xtream'
                    ? 'Xtream Codes'
                    : list.sourceType === 'json'
                      ? 'Catálogo JSON'
                      : list.sourceType === 'url'
                        ? 'URL Remota'
                        : list.sourceType === 'file'
                          ? 'Arquivo .M3U'
                          : 'Snippet';

                return (
                  <div
                    key={list.id}
                    className="rounded-xl border border-white/10 bg-[#121417] p-5 transition-colors hover:border-white/20"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-display text-base font-bold text-white">
                            {list.name}
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              list.sourceType === 'xtream'
                                ? 'bg-amber-500/20 text-amber-200'
                                : list.sourceType === 'json'
                                  ? 'bg-sky-500/20 text-sky-200'
                                  : 'bg-white/10 text-white/80'
                            }`}
                          >
                            {originBadge}
                          </span>
                          <span className="rounded bg-[#0B0C0E] px-2 py-0.5 font-mono text-[10px] text-white/50">
                            {list.id}
                          </span>
                        </div>

                        {list.sourceType === 'xtream' &&
                        list.xtreamCredentials ? (
                          <p className="truncate text-xs text-white/60">
                            Servidor:{' '}
                            <span className="text-white/85">
                              {list.xtreamCredentials.serverUrl}
                            </span>{' '}
                            · Usuário:{' '}
                            <span className="font-mono text-white/85">
                              {list.xtreamCredentials.username}
                            </span>{' '}
                            · Credenciais salvas para re-sincronização
                          </p>
                        ) : (
                          list.sourceLocation && (
                            <p className="truncate text-xs text-white/55">
                              Origem: {list.sourceLocation}
                            </p>
                          )
                        )}

                        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-white/70 tabular-nums">
                          <span>
                            Importada em:{' '}
                            <strong className="text-white/90">
                              {new Date(list.importedAt).toLocaleString(
                                'pt-BR'
                              )}
                            </strong>
                          </span>
                          <span>
                            Entradas lidas:{' '}
                            <strong className="text-white">
                              {list.totalEntries}
                            </strong>
                          </span>
                          <span>
                            Títulos ativos:{' '}
                            <strong className="text-emerald-400">
                              {live.titleCount}
                            </strong>
                          </span>
                          {uploadProgress && (
                            <span className="text-amber-300">
                              Envio pendente · {uploadProgress.confirmed}/{uploadProgress.total} títulos confirmados
                            </span>
                          )}
                          <span>
                            Fontes vinculadas:{' '}
                            <strong className="text-sky-300">
                              {live.sourceCount}
                            </strong>
                          </span>
                        </div>

                        <div className="flex flex-wrap gap-4 text-[11px] text-white/50 tabular-nums">
                          <span>+{list.newItemsCreated} novos títulos</span>
                          <span>
                            +{list.mergedSourcesCount} fontes mescladas
                          </span>
                          <span>
                            {list.ignoredDuplicatesCount} duplicados ignorados
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {!isConfirming && (
                          <button
                            type="button"
                            disabled={
                              verifyingListId === list.id ||
                              live.titleCount === 0 ||
                              importing || uploadPending || catalogActionBusy
                            }
                            onClick={() => void handleVerifyListInBackground(list)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 bg-[#181B20] px-3.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-45"
                          >
                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                            {verifyingListId === list.id
                              ? 'Agendando...'
                              : 'Verificar Lista'}
                          </button>
                        )}

                        {canResync && !isConfirming && (
                          <button
                            type="button"
                            disabled={Boolean(resyncingListId) || importing || catalogActionBusy || Boolean(deletingListId)}
                            onClick={() => void handleResyncM3uList(list)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 bg-[#181B20] px-3.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-45"
                          >
                            <RefreshCw
                              className={`h-3.5 w-3.5 ${
                                isResyncing ? 'animate-spin' : ''
                              }`}
                            />
                            {isResyncing
                              ? 'Sincronizando...'
                              : uploadPending ? 'Retomar envio' : 'Re-sincronizar'}
                          </button>
                        )}

                        {isConfirming ? (
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2">
                            <span className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-rose-200">
                              <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
                              Remover {live.sourceCount} fontes desta lista?
                            </span>
                            <button
                              type="button"
                              disabled={isDeleting || importing || Boolean(resyncingListId) || catalogActionBusy}
                              onClick={() => void handleDeleteM3uList(list)}
                              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {isDeleting
                                ? 'Excluindo...'
                                : 'Confirmar Exclusão'}
                            </button>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteListId(null)}
                              className="inline-flex h-8 items-center rounded-md border border-white/15 bg-[#0B0C0E] px-3 text-xs font-semibold text-white/80 hover:bg-white/10"
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteListId(list.id)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/20"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Excluir Lista
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB: CONTENT SERVERS */}
      {activeTab === 'servers' && (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-xl font-bold text-white">
                Servidores de Conteúdo & Provedores IPTV/VOD
              </h2>
              <p className="mt-1 text-xs text-white/60">
                Cadastre e gerencie servidores autorizados (M3U, Xtream Codes API, JSON e Saimo base format). As credenciais são armazenadas de forma segura no backend.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditingServer(null);
                setServerForm({ name: '', baseUrl: '', serverType: 'm3u', username: '', password: '' });
                setServerModalOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-xs font-semibold text-[#0B0C0E] hover:bg-white/90"
            >
              <Plus className="h-4 w-4" />
              Adicionar Servidor
            </button>
          </div>

          {serverActionMsg && (
            <div className="rounded-xl border border-white/15 bg-[#121417] p-4 text-xs text-white/80">
              {serverActionMsg}
            </div>
          )}

          {loadingServers ? (
            <div className="py-12 text-center text-xs text-white/50">Carregando servidores...</div>
          ) : servers.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-[#121417] p-8 text-center">
              <Server className="mx-auto h-8 w-8 text-white/30" />
              <p className="mt-3 text-sm font-semibold text-white">Nenhum servidor cadastrado</p>
              <p className="mt-1 text-xs text-white/50">Adicione seu primeiro servidor Xtream ou M3U para começar.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {servers.map((srv) => {
                const isTesting = testingServerId === srv.id;
                const isSyncing = syncingServerId === srv.id;
                return (
                  <div
                    key={srv.id}
                    className="flex flex-col gap-4 rounded-xl border border-white/10 bg-[#121417] p-5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2.5">
                        <span className="font-display font-bold text-white text-base">{srv.name}</span>
                        <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-white/80 uppercase">
                          {srv.serverType}
                        </span>
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                            srv.lastSyncStatus === 'nominal'
                              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                              : srv.lastSyncStatus === 'error'
                              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                              : 'bg-white/10 text-white/60'
                          }`}
                        >
                          {srv.lastSyncStatus === 'nominal' ? 'Operacional' : srv.lastSyncStatus === 'error' ? 'Erro' : srv.lastSyncStatus === 'syncing' ? 'Sincronizando...' : 'Não Testado'}
                        </span>
                      </div>
                      <p className="text-xs text-white/55 truncate max-w-xl">{srv.baseUrl}</p>
                      <div className="flex flex-wrap items-center gap-4 text-xs text-white/45 pt-1">
                        <span>Itens: <strong className="text-white/80 tabular-nums">{srv.itemCount}</strong></span>
                        <span aria-hidden="true">·</span>
                        <span>Última Sincronização: <strong className="text-white/85">{srv.lastSyncAt ? new Date(srv.lastSyncAt).toLocaleString('pt-BR') : 'Nunca'}</strong></span>
                        {srv.syncReason && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-rose-300">{srv.syncReason}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={isTesting}
                        onClick={() => handleTestServer(srv.id)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${isTesting ? 'animate-spin' : ''}`} />
                        {isTesting ? 'Testando...' : 'Testar'}
                      </button>
                      <button
                        type="button"
                        disabled={isSyncing}
                        onClick={() => handleSyncServer(srv.id)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-xs font-semibold text-[#0B0C0E] hover:bg-white/90 disabled:opacity-50"
                      >
                        <WifiOff className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Sincronizando...' : 'Sincronizar'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingServer(srv);
                          setServerForm({
                            name: srv.name,
                            baseUrl: srv.baseUrl,
                            serverType: srv.serverType,
                            username: srv.username || '',
                            password: srv.password || '',
                          });
                          setServerModalOpen(true);
                        }}
                        className="inline-flex h-9 items-center rounded-lg border border-white/15 bg-white/5 px-3 text-xs font-semibold text-white hover:bg-white/10"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteServer(srv.id)}
                        className="inline-flex h-9 items-center rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 text-xs font-semibold text-rose-200 hover:bg-rose-500/20"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add / Edit Server Modal */}
          {serverModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
              <form
                onSubmit={handleSaveServer}
                className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#121417] p-6 space-y-5 shadow-2xl"
              >
                <div>
                  <h3 className="font-display text-lg font-bold text-white">
                    {editingServer ? 'Editar Servidor de Conteúdo' : 'Cadastrar Servidor de Conteúdo'}
                  </h3>
                  <p className="mt-1 text-xs text-white/60">
                    Insira as informações de conexão do provedor IPTV/VOD.
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-white/80 mb-1.5">
                      Nome do Servidor
                    </label>
                    <input
                      type="text"
                      required
                      value={serverForm.name}
                      onChange={(e) => setServerForm({ ...serverForm, name: e.target.value })}
                      placeholder="Ex: Provedor Top IPTV"
                      className="w-full rounded-xl border border-white/15 bg-[#0B0C0E] px-4 py-2.5 text-sm text-white focus:border-white focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-white/80 mb-1.5">
                      Tipo de Servidor / Formato
                    </label>
                    <select
                      value={serverForm.serverType}
                      onChange={(e) => setServerForm({ ...serverForm, serverType: e.target.value as any })}
                      className="w-full rounded-xl border border-white/15 bg-[#0B0C0E] px-4 py-2.5 text-sm text-white focus:border-white focus:outline-none"
                    >
                      <option value="m3u">Lista M3U (URL / Stream)</option>
                      <option value="xtream">Xtream Codes API</option>
                      <option value="json">Catálogo JSON</option>
                      <option value="saimo">Formato Saimo (indice.txt / bases)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-white/80 mb-1.5">
                      URL Base do Servidor (ou URL M3U)
                    </label>
                    <input
                      type="url"
                      required
                      value={serverForm.baseUrl}
                      onChange={(e) => setServerForm({ ...serverForm, baseUrl: e.target.value })}
                      placeholder="https://servidor.com:8080"
                      className="w-full rounded-xl border border-white/15 bg-[#0B0C0E] px-4 py-2.5 text-sm text-white focus:border-white focus:outline-none"
                    />
                  </div>

                  {serverForm.serverType === 'xtream' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-white/80 mb-1.5">Usuário</label>
                        <input
                          type="text"
                          value={serverForm.username}
                          onChange={(e) => setServerForm({ ...serverForm, username: e.target.value })}
                          className="w-full rounded-xl border border-white/15 bg-[#0B0C0E] px-4 py-2.5 text-sm text-white focus:border-white focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-white/80 mb-1.5">Senha</label>
                        <input
                          type="password"
                          value={serverForm.password}
                          onChange={(e) => setServerForm({ ...serverForm, password: e.target.value })}
                          className="w-full rounded-xl border border-white/15 bg-[#0B0C0E] px-4 py-2.5 text-sm text-white focus:border-white focus:outline-none"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setServerModalOpen(false)}
                    className="rounded-xl border border-white/15 bg-transparent px-4 py-2.5 text-xs font-semibold text-white hover:bg-white/10"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="rounded-xl bg-white px-5 py-2.5 text-xs font-semibold text-[#0B0C0E] hover:bg-white/90"
                  >
                    Salvar Servidor
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: API & PROXY SETTINGS */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          <form
            onSubmit={handleSaveSettings}
            className="max-w-2xl rounded-xl border border-white/10 bg-[#121417] p-6 space-y-5"
          >
            <div>
              <h2 className="font-display text-lg font-bold text-white">
                Configurações de API, Proxy HTTP→HTTPS & Lotes
              </h2>
              <p className="mt-1 text-xs text-white/60">
                As chaves de API são protegidas por cadeado e salvas no{' '}
                <code>localStorage</code> e no cache local.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-white/80">
                TMDB API Key (v3 API Key ou Token Bearer v4)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type={tmdbLocked ? 'password' : 'text'}
                  value={tmdbLocked ? '••••••••••••' : tmdbKey}
                  readOnly={tmdbLocked}
                  disabled={tmdbLocked}
                  onChange={(e) => setTmdbKey(e.target.value)}
                  placeholder="Cole sua chave TMDB para sinopse, elenco, nota e Watch Providers BR"
                  className={`flex-1 rounded-lg border border-white/15 px-3.5 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none ${
                    tmdbLocked
                      ? 'cursor-not-allowed bg-[#0B0C0E]/60 text-white/55'
                      : 'bg-[#0B0C0E]'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setTmdbLocked((locked) => !locked)}
                  aria-label={
                    tmdbLocked
                      ? 'Desbloquear campo TMDB API Key'
                      : 'Bloquear campo TMDB API Key'
                  }
                  title={
                    tmdbLocked
                      ? 'Desbloquear para visualizar/editar'
                      : 'Bloquear campo'
                  }
                  className={`inline-flex h-[42px] items-center gap-1.5 rounded-lg border px-3.5 text-xs font-semibold transition-colors ${
                    tmdbLocked
                      ? 'border-white/15 bg-[#181B20] text-white/80 hover:bg-white/10'
                      : 'border-amber-400/50 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25'
                  }`}
                >
                  {tmdbLocked ? (
                    <>
                      <Lock className="h-4 w-4" />
                      <span className="hidden sm:inline">Desbloquear</span>
                    </>
                  ) : (
                    <>
                      <Unlock className="h-4 w-4" />
                      <span className="hidden sm:inline">Bloquear</span>
                    </>
                  )}
                </button>
              </div>
              <p className="text-[11px] text-white/45">
                {tmdbKey
                  ? 'Chave TMDB carregada no navegador.'
                  : 'Nenhuma chave local informada — clique no cadeado para inserir.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-white/80">
                YouTube Data API v3 Key
              </label>
              <div className="flex items-center gap-2">
                <input
                  type={youtubeLocked ? 'password' : 'text'}
                  value={youtubeLocked ? '••••••••••••' : youtubeKey}
                  readOnly={youtubeLocked}
                  disabled={youtubeLocked}
                  onChange={(e) => setYoutubeKey(e.target.value)}
                  placeholder="Cole sua chave YouTube Data API v3 (ou deixe vazio para busca automática)"
                  className={`flex-1 rounded-lg border border-white/15 px-3.5 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none ${
                    youtubeLocked
                      ? 'cursor-not-allowed bg-[#0B0C0E]/60 text-white/55'
                      : 'bg-[#0B0C0E]'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setYoutubeLocked((locked) => !locked)}
                  aria-label={
                    youtubeLocked
                      ? 'Desbloquear campo YouTube API Key'
                      : 'Bloquear campo YouTube API Key'
                  }
                  title={
                    youtubeLocked
                      ? 'Desbloquear para visualizar/editar'
                      : 'Bloquear campo'
                  }
                  className={`inline-flex h-[42px] items-center gap-1.5 rounded-lg border px-3.5 text-xs font-semibold transition-colors ${
                    youtubeLocked
                      ? 'border-white/15 bg-[#181B20] text-white/80 hover:bg-white/10'
                      : 'border-amber-400/50 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25'
                  }`}
                >
                  {youtubeLocked ? (
                    <>
                      <Lock className="h-4 w-4" />
                      <span className="hidden sm:inline">Desbloquear</span>
                    </>
                  ) : (
                    <>
                      <Unlock className="h-4 w-4" />
                      <span className="hidden sm:inline">Bloquear</span>
                    </>
                  )}
                </button>
              </div>
              <p className="text-[11px] text-white/45">
                {youtubeKey
                  ? 'Chave YouTube carregada no navegador.'
                  : 'Nenhuma chave local informada — clique no cadeado para inserir.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-white/80">
                Prefixo de Proxy CORS / Stream (Opcional — padrão automático: /api/stream?url=)
              </label>
              <input
                type="text"
                value={streamProxyPrefix}
                onChange={(e) => setStreamProxyPrefix(e.target.value)}
                placeholder="Vazio usa automaticamente /api/stream?url= para links http:// em https://"
                className="w-full rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
              />
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-[#0B0C0E]/70 p-4 transition-colors hover:border-white/25">
              <input
                type="checkbox"
                checked={autoProxyHttpStreams}
                onChange={(e) => setAutoProxyHttpStreams(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-white/25 bg-[#121417] accent-[#E50914]"
              />
              <div className="space-y-1">
                <span className="block text-xs font-bold text-white">
                  Modo Proxy Automático (ativado por padrão para links http://)
                </span>
                <span className="block text-[11px] leading-relaxed text-white/60">
                  Roteia automaticamente links <code>http://</code> (incluindo{' '}
                  <code>.m3u8</code>, segmentos <code>.ts</code> e mídias em
                  páginas HTTPS) pelo Proxy de servidor com cabeçalhos CORS,
                  preservando arquivos <code>https://</code> diretos no elemento{' '}
                  <code>&lt;video&gt;</code> nativo sem{' '}
                  <code>crossOrigin</code>.
                </span>
              </div>
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-white/80">
                  Tamanho do Lote (itens simultâneos)
                </label>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value))}
                  className="w-full rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2.5 text-sm text-white tabular-nums focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-white/80">
                  Timeout do Teste de Stream (ms)
                </label>
                <input
                  type="number"
                  min={2000}
                  max={15000}
                  step={500}
                  value={probeTimeoutMs}
                  onChange={(e) => setProbeTimeoutMs(Number(e.target.value))}
                  className="w-full rounded-lg border border-white/15 bg-[#0B0C0E] px-3.5 py-2.5 text-sm text-white tabular-nums focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center gap-4 pt-2">
              <button
                type="submit"
                className="inline-flex h-10 items-center justify-center rounded-lg bg-[#E50914] px-5 text-xs font-bold text-white hover:bg-[#c80812]"
              >
                Salvar Configurações
              </button>
              {settingsSavedMsg && (
                <span className="text-xs font-medium text-emerald-400">
                  Configurações salvas no dispositivo.
                </span>
              )}
            </div>
          </form>

          {/* Backup, Migração e Rollback do Acervo */}
          <div className="max-w-2xl rounded-xl border border-white/10 bg-[#121417] p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-bold text-white">
                  Backup, Migração e Rollback do Acervo
                </h3>
                <p className="mt-1 text-xs text-white/60">
                  Gera snapshot automático antes de mesclar fichas, favoritos e
                  histórico locais com o acervo permanente sem sobrescrever
                  dados existentes.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                disabled={migrationBusy || !user}
                onClick={() => void handleRunManualMigration()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-4 text-xs font-bold text-[#0B0C0E] hover:bg-white/90 disabled:opacity-45"
              >
                <Database className="h-3.5 w-3.5" />
                {migrationBusy
                  ? 'Processando...'
                  : 'Criar Backup e Sincronizar Acervo'}
              </button>

              <button
                type="button"
                disabled={migrationBusy}
                onClick={() => void handleRestoreLocalSnapshot()}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/15 bg-[#181B20] px-4 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-45"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Restaurar Snapshot Local
              </button>
            </div>

            {!user && (
              <p className="text-xs text-amber-200/80">
                Entre com sua conta Google na aba Perfil para habilitar backups
                e rollback na nuvem.
              </p>
            )}

            {migrationMsg && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200">
                {migrationMsg}
              </div>
            )}

            {migrationBackups.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-xs font-semibold text-white/75">
                  Histórico de Lotes & Backups ({migrationBackups.length})
                </p>
                <div className="space-y-2">
                  {migrationBackups.slice(0, 5).map((b) => (
                    <div
                      key={b.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#0B0C0E] px-3.5 py-2.5 text-xs"
                    >
                      <div className="space-y-0.5">
                        <p className="font-mono text-[11px] text-white/85">
                          {b.id} ·{' '}
                          <span
                            className={
                              b.status === 'rolled_back'
                                ? 'text-amber-300'
                                : 'text-emerald-400'
                            }
                          >
                            {b.status === 'rolled_back'
                              ? 'Revertido'
                              : 'Concluído'}
                          </span>
                        </p>
                        <p className="text-[11px] text-white/55 tabular-nums">
                          {new Date(b.createdAt).toLocaleString('pt-BR')} · +
                          {b.summary.createdWorks ?? 0} obras ·{' '}
                          {b.summary.mergedWorks ?? 0} mescladas ·{' '}
                          {b.summary.migratedHistory ?? 0} históricos
                        </p>
                      </div>

                      {b.status === 'completed' && (
                        <button
                          type="button"
                          disabled={migrationBusy}
                          onClick={() => void handleRollbackServerBackup(b.id)}
                          className="rounded-md border border-rose-500/35 bg-rose-500/10 px-3 py-1.5 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/20 disabled:opacity-45"
                        >
                          Executar Rollback
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
