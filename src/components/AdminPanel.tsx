import { useEffect, useMemo, useRef, useState, DragEvent, FormEvent } from 'react';
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

export type AdminTab = 'queue' | 'import' | 'lists' | 'settings';

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
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [m3uLists, setM3uLists] = useState<M3uListRecord[]>([]);
  const [loadingDb, setLoadingDb] = useState(true);
  const [epgCount, setEpgCount] = useState(0);

  // Filters & Pagination
  const [statusFilter, setStatusFilter] = useState<'all' | PublishStatus>('all');
  const [kindFilter, setKindFilter] = useState<'all' | MediaKind>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);

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

  // EPG state
  const [epgUrlInput, setEpgUrlInput] = useState(settings.epgUrl || '');
  const [epgLoading, setEpgLoading] = useState(false);
  const [epgStatusMsg, setEpgStatusMsg] = useState<string | null>(null);
  const [epgError, setEpgError] = useState<string | null>(null);

  // Reclassify status
  const [reclassifyMsg, setReclassifyMsg] = useState<string | null>(null);

  // Pipeline state
  const [pipeline, setPipeline] = useState<PipelineProgress>({
    running: false,
    paused: false,
    processed: 0,
    total: 0,
    approved: 0,
    offline: 0,
    currentTitle: '',
    currentStage: 'health',
  });
  const pauseFlagRef = useRef(false);
  const cancelFlagRef = useRef(false);
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

  const refreshItems = async () => {
    const [all, epg, lists] = await Promise.all([
      db.mediaItems.orderBy('createdAt').reverse().toArray(),
      getAllEpgPrograms(),
      getAllM3uLists(),
    ]);
    setItems(all);
    setEpgCount(epg.length);
    setM3uLists(lists);
    setLoadingDb(false);
    onCatalogChanged();
  };

  useEffect(() => {
    void refreshItems();
  }, []);

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
  const formatMergeSummary = (result: M3UImportStats) => {
    const formatLabel =
      result.detectedFormat === 'json' ? 'Catálogo JSON' : 'Lista M3U';
    return `${formatLabel} importado(a) · Mesclagem inteligente: ${result.newItems} novos títulos na fila, ${result.mergedSources} novas fontes adicionadas a títulos existentes e ${result.ignoredDuplicates} links duplicados ignorados.`;
  };

  const handleFileImport = async (file: File, stayOnLists = false) => {
    setImporting(true);
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
      });
      setImportStats(result);
      const summary = formatMergeSummary(result);
      setImportResultMsg(summary);
      if (stayOnLists) setListActionMsg(summary);
      setListCustomName('');
      await refreshItems();
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
      });
      setImportStats(result);
      const summary = formatMergeSummary(result);
      setImportResultMsg(summary);
      if (stayOnLists) setListActionMsg(summary);
      setM3uUrl('');
      setListCustomName('');
      await refreshItems();
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
      await refreshItems();
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
    setImportError(null);
    setImportResultMsg(null);
    setListActionMsg(null);
    try {
      const result = await importM3UFromText(SAMPLE_M3U_SNIPPET, {
        customName: listCustomName.trim() || undefined,
        onProgress: (stats) => setImportStats(stats),
      });
      setImportStats(result);
      const summary = formatMergeSummary(result);
      setImportResultMsg(summary);
      if (stayOnLists) setListActionMsg(summary);
      setListCustomName('');
      await refreshItems();
      if (!stayOnLists) setActiveTab('queue');
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Erro ao carregar snippet M3U.'
      );
    } finally {
      setImporting(false);
    }
  };

  const handleResyncM3uList = async (list: M3uListRecord) => {
    setResyncingListId(list.id);
    setImportError(null);
    setListActionMsg(null);
    try {
      const result = await resyncM3uList(list, {
        onProgress: (stats) => setImportStats(stats),
      });
      await refreshItems();
      setListActionMsg(
        `Lista "${list.name}" re-sincronizada: ${result.newItems} novos títulos, ${result.mergedSources} fontes mescladas e ${result.ignoredDuplicates} duplicados ignorados.`
      );
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Falha ao re-sincronizar lista.'
      );
    } finally {
      setResyncingListId(null);
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

  // Pipeline Batch Processing
  const handleRunBatchPipeline = async () => {
    const pendingItems = items.filter(
      (i) => (i.status || 'pendente') === 'pendente'
    );
    if (pendingItems.length === 0) return;

    pauseFlagRef.current = false;
    cancelFlagRef.current = false;

    let processed = 0;
    let approved = 0;
    let offline = 0;

    setPipeline({
      running: true,
      paused: false,
      processed: 0,
      total: pendingItems.length,
      approved: 0,
      offline: 0,
      currentTitle: pendingItems[0].title,
      currentStage: 'health',
    });

    const chunkSize = Math.max(1, settings.batchSize || 4);

    for (let i = 0; i < pendingItems.length; i += chunkSize) {
      if (cancelFlagRef.current) break;

      while (pauseFlagRef.current) {
        if (cancelFlagRef.current) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (cancelFlagRef.current) break;

      const batch = pendingItems.slice(i, i + chunkSize);

      await Promise.all(
        batch.map(async (item) => {
          const updated = await processItemFullPipeline(
            item,
            settings,
            (stage, note) => {
              setPipeline((prev) => ({
                ...prev,
                currentTitle: item.title,
                currentStage: stage,
                lastNote: note || prev.lastNote,
              }));
            }
          );

          processed += 1;
          if (updated.status === 'aprovado') approved += 1;
          else if (updated.status === 'offline') offline += 1;

          setPipeline((prev) => ({
            ...prev,
            processed,
            approved,
            offline,
          }));
        })
      );

      await refreshItems();
    }

    setPipeline((prev) => ({
      ...prev,
      running: false,
      paused: false,
      currentStage: 'done',
    }));
  };

  const handleTogglePause = () => {
    pauseFlagRef.current = !pauseFlagRef.current;
    setPipeline((prev) => ({ ...prev, paused: pauseFlagRef.current }));
  };

  const handleCancelPipeline = () => {
    cancelFlagRef.current = true;
    pauseFlagRef.current = false;
  };

  const handleProcessSingle = async (item: CatalogItem) => {
    setBusyItemId(item.id);
    try {
      await processItemFullPipeline(item, settings);
      await refreshItems();
    } finally {
      setBusyItemId(null);
    }
  };

  const handlePublishBatch = async () => {
    const approvedItems = items.filter((i) => i.status === 'aprovado');
    if (approvedItems.length === 0) return;
    const now = Date.now();
    await db.mediaItems.bulkPut(
      approvedItems.map((item) => ({
        ...item,
        status: 'publicado' as PublishStatus,
        updatedAt: now,
      }))
    );
    await refreshItems();
  };

  const handleTogglePublishSingle = async (item: CatalogItem) => {
    const nextStatus: PublishStatus =
      item.status === 'publicado' ? 'aprovado' : 'publicado';
    await db.mediaItems.put({
      ...item,
      status: nextStatus,
      updatedAt: Date.now(),
    });
    await refreshItems();
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
    await refreshItems();
  };

  const handleDeleteItem = async (id: string) => {
    await db.mediaItems.delete(id);
    await refreshItems();
  };

  const handleClearOffline = async () => {
    const offlineIds = items
      .filter((i) => i.status === 'offline')
      .map((i) => i.id);
    if (offlineIds.length === 0) return;
    await db.mediaItems.bulkDelete(offlineIds);
    await refreshItems();
  };

  const handleClearAllDb = async () => {
    await Promise.all([db.mediaItems.clear(), db.m3u_lists.clear()]);
    setReclassifyMsg('Catálogo e listas M3U limpos no IndexedDB.');
    setImportResultMsg(null);
    await refreshItems();
  };

  const handleDeleteM3uList = async (list: M3uListRecord) => {
    setDeletingListId(list.id);
    setListActionMsg(null);
    try {
      const res = await deleteM3uList(list.id);
      setConfirmDeleteListId(null);
      await refreshItems();
      setListActionMsg(
        `Lista "${list.name}" excluída: ${res.removedSources} fontes removidas, ${res.updatedItems} títulos preservados com outras listas e ${res.removedItems} títulos sem fontes restantes removidos do catálogo.`
      );
    } finally {
      setDeletingListId(null);
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
                ? 'Processando fonte e aplicando mesclagem inteligente...'
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
                Cancelar
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
                      importStats.totalBytes > 0
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
      {activeTab === 'queue' && (
        <div className="space-y-6">
          {/* Summary Stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-white/10 bg-[#121417] p-4">
              <p className="text-xs text-white/55">Total Importado</p>
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
                  Pipeline de Pré-Publicação (Etapas A · B · C)
                </h2>
                <p className="text-xs text-white/60">
                  A: Teste de Stream · B: TMDB pt-BR + Plataforma · C: Trailer
                  Dublado YouTube
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {!pipeline.running ? (
                  <button
                    type="button"
                    disabled={counts.pendente === 0}
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
                  disabled={counts.aprovado === 0}
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

                {counts.total > 0 && (
                  <button
                    type="button"
                    onClick={handleClearAllDb}
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

            {(pipeline.running || pipeline.processed > 0) && (
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
                      : `Lote finalizado · ${pipeline.approved} aprovados · ${pipeline.offline} offline`}
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
                            {item.healthChecked && (
                              <span className="block text-[11px] text-emerald-400/80">
                                {onlineCount} online
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
                                title="Testar link + TMDB + YouTube"
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
                apenas os links dela e preserva títulos presentes em outras
                listas.
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
                const canResync =
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
                        {canResync && !isConfirming && (
                          <button
                            type="button"
                            disabled={isResyncing || importing}
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
                              : 'Re-sincronizar'}
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
                              disabled={isDeleting}
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

      {/* TAB 4: API & PROXY SETTINGS */}
      {activeTab === 'settings' && (
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
              <code>localStorage</code> e no IndexedDB.
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
                Configurações salvas no localStorage e IndexedDB.
              </span>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
