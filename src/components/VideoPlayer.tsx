import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Layers,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { PLATFORM_LABELS } from '../data/catalog';
import {
  authorizeStreamOrigins,
  redactUrlCredentials,
} from '../services/streamOrigins';
import {
  SaveWatchProgressPayload,
  findPreferredSourceIndex,
  getNextSeriesEpisode,
} from '../services/watchHistory';
import { CatalogItem, MediaSource, SeriesEpisode } from '../types/streaming';
import { HybridPlayer } from './HybridPlayer';
import { MediaImage } from './MediaImage';

interface VideoPlayerProps {
  item: CatalogItem | null;
  season?: number;
  episodeNumber?: number;
  episodeId?: string;
  episodeTitle?: string;
  episodeLabel?: string;
  initialProgressPercent?: number;
  initialTimeSeconds?: number;
  streamUrl?: string;
  sources?: MediaSource[];
  preferredSourceId?: string;
  preferredSourceLabel?: string;
  preferredSourceUrl?: string;
  streamProxyPrefix?: string;
  autoProxyHttpStreams?: boolean;
  onOpenAdminSettings?: () => void;
  onProgressUpdate?: (payload: SaveWatchProgressPayload) => void;
  onSelectEpisode?: (
    episode: SeriesEpisode,
    preferredSource?: MediaSource
  ) => void;
  onClose: () => void;
}

function formatTime(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`;
  return `${pad(mins)}:${pad(secs)}`;
}

export function VideoPlayer({
  item,
  season,
  episodeNumber,
  episodeId,
  episodeTitle,
  episodeLabel,
  initialProgressPercent = 0,
  initialTimeSeconds = 0,
  streamUrl,
  sources,
  preferredSourceId,
  preferredSourceLabel,
  preferredSourceUrl,
  streamProxyPrefix = '',
  autoProxyHttpStreams = true,
  onOpenAdminSettings,
  onProgressUpdate,
  onSelectEpisode,
  onClose,
}: VideoPlayerProps) {
  const availableSources = useMemo<MediaSource[]>(() => {
    const base = sources && sources.length > 0 ? sources : item?.sources ?? [];
    if (streamUrl && !base.some((s) => s.url === streamUrl)) {
      return [
        {
          id: 'direct-url',
          label: 'Fonte Direta',
          url: streamUrl,
          status: 'pending',
        },
        ...base,
      ];
    }
    return base;
  }, [sources, item?.sources, streamUrl]);

  const initialSourceIdx = useMemo(() => {
    return findPreferredSourceIndex(availableSources, {
      id: preferredSourceId,
      label: preferredSourceLabel,
      url: preferredSourceUrl || streamUrl,
    });
  }, [
    availableSources,
    preferredSourceId,
    preferredSourceLabel,
    preferredSourceUrl,
    streamUrl,
  ]);

  const [sourceIndex, setSourceIndex] = useState(initialSourceIdx);
  const [forceInternalProxy, setForceInternalProxy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('Carregando stream...');
  const [isBuffering, setIsBuffering] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [playbackError, setPlaybackError] = useState<{
    reason: string;
    isMixedContentOrCors: boolean;
  } | null>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(item?.durationSeconds || 5400);
  const [volume, setVolume] = useState(90);
  const [isMuted, setIsMuted] = useState(false);
  const [showSourcesMenu, setShowSourcesMenu] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Next episode overlay state
  const [dismissedNextEpKey, setDismissedNextEpKey] = useState<string | null>(
    null
  );
  const [nextEpCountdown, setNextEpCountdown] = useState<number>(10);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedAtRef = useRef<number>(0);
  const latestTimeRef = useRef<{ currentTime: number; duration: number }>({
    currentTime: 0,
    duration: item?.durationSeconds || 0,
  });

  const handleVideoElement = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
  }, []);

  const activeSource = availableSources[sourceIndex];
  const rawStreamUrl = activeSource?.url || '';
  const isLive = item?.type === 'live';

  const currentEpisodeKey = item
    ? `${item.id}:${season || 1}:${episodeNumber || 1}:${episodeId || episodeLabel || ''}`
    : '';

  const nextEpisode = useMemo(() => {
    if (!item || item.type !== 'series' || isLive) return null;
    return getNextSeriesEpisode(
      item,
      season,
      episodeNumber,
      episodeId,
      episodeLabel
    );
  }, [item, isLive, season, episodeNumber, episodeId, episodeLabel]);

  const commitProgress = useCallback(
    (currSec: number, durSec: number, force = false) => {
      if (!item || isLive || item.type === 'radio' || !onProgressUpdate) return;
      const effectiveDuration =
        durSec > 0 ? durSec : item.durationSeconds || 0;
      if (effectiveDuration <= 0 || currSec <= 0) return;

      const now = Date.now();
      if (!force && now - lastSavedAtRef.current < 5000) {
        return;
      }
      lastSavedAtRef.current = now;

      onProgressUpdate({
        itemId: item.id,
        type: item.type === 'series' ? 'series' : 'movie',
        season,
        episodeNumber,
        episodeId,
        episodeTitle,
        episodeLabel,
        currentTime: currSec,
        duration: effectiveDuration,
        selectedSourceId: activeSource?.id,
        selectedSourceLabel: activeSource?.label,
        selectedSourceUrl: activeSource?.url,
        updatedAt: now,
      });
    },
    [
      item,
      isLive,
      onProgressUpdate,
      season,
      episodeNumber,
      episodeId,
      episodeTitle,
      episodeLabel,
      activeSource?.id,
      activeSource?.label,
      activeSource?.url,
    ]
  );

  useEffect(() => {
    if (!item || availableSources.length === 0) return;
    void authorizeStreamOrigins(availableSources.map((s) => s.url));
  }, [item, availableSources]);

  useEffect(() => {
    setSourceIndex(initialSourceIdx);
    setForceInternalProxy(false);
    setPlaybackError(null);
    setIsReady(false);
    setIsBuffering(Boolean(item));
    setCurrentTime(0);
    setDuration(item?.durationSeconds || 5400);
    setDismissedNextEpKey(null);
    setNextEpCountdown(10);
    lastSavedAtRef.current = 0;
    latestTimeRef.current = {
      currentTime: 0,
      duration: item?.durationSeconds || 0,
    };
  }, [
    item?.id,
    season,
    episodeNumber,
    episodeId,
    episodeLabel,
    initialSourceIdx,
    item,
  ]);

  useEffect(() => {
    if (!item) return;
    setIsReady(false);
    setIsPlaying(true);
    if (!rawStreamUrl) {
      setIsBuffering(false);
      setPlaybackError({
        reason: 'Nenhuma URL de stream cadastrada para este título.',
        isMixedContentOrCors: false,
      });
    } else {
      setPlaybackError(null);
      setIsBuffering(true);
      setStatusMessage(`Conectando a ${activeSource?.label || 'fonte'}...`);
    }
  }, [item, rawStreamUrl, sourceIndex, forceInternalProxy, activeSource?.label]);

  const advanceToNextSourceOrFail = useCallback(
    (reason: string, isMixedOrCors: boolean) => {
      if (sourceIndex + 1 < availableSources.length) {
        const nextIdx = sourceIndex + 1;
        setStatusMessage(
          `Falha na ${activeSource?.label || 'fonte atual'}. Tentando ${
            availableSources[nextIdx].label
          }...`
        );
        setSourceIndex(nextIdx);
      } else {
        setIsBuffering(false);
        setPlaybackError({
          reason,
          isMixedContentOrCors: isMixedOrCors,
        });
      }
    },
    [sourceIndex, availableSources, activeSource?.label]
  );

  const handleCloseWithSave = useCallback(() => {
    commitProgress(
      latestTimeRef.current.currentTime,
      latestTimeRef.current.duration,
      true
    );
    onClose();
  }, [commitProgress, onClose]);

  const handleAdvanceToNextEpisode = useCallback(() => {
    if (!nextEpisode || !onSelectEpisode) return;
    commitProgress(
      latestTimeRef.current.currentTime,
      latestTimeRef.current.duration,
      true
    );
    onSelectEpisode(nextEpisode, activeSource);
  }, [nextEpisode, onSelectEpisode, commitProgress, activeSource]);

  const remainingSeconds =
    duration > 30 ? Math.max(0, duration - currentTime) : Number.POSITIVE_INFINITY;

  const showNextEpisodeCard = Boolean(
    item &&
      item.type === 'series' &&
      !isLive &&
      nextEpisode &&
      onSelectEpisode &&
      isReady &&
      !playbackError &&
      remainingSeconds <= 30 &&
      dismissedNextEpKey !== currentEpisodeKey
  );

  // Manage 10-second countdown when Next Episode card becomes visible
  useEffect(() => {
    if (!showNextEpisodeCard) {
      setNextEpCountdown(10);
      return;
    }

    const timer = window.setInterval(() => {
      setNextEpCountdown((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [showNextEpisodeCard]);

  useEffect(() => {
    if (showNextEpisodeCard && nextEpCountdown === 0) {
      handleAdvanceToNextEpisode();
    }
  }, [showNextEpisodeCard, nextEpCountdown, handleAdvanceToNextEpisode]);

  useEffect(() => {
    if (!item) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseWithSave();
      } else if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [item, handleCloseWithSave]);

  if (!item) return null;

  const handleSeek = (nextSec: number) => {
    if (isLive || !videoRef.current) return;
    videoRef.current.currentTime = nextSec;
    setCurrentTime(nextSec);
    latestTimeRef.current.currentTime = nextSec;
  };

  const handleCopyStreamUrl = async () => {
    if (!rawStreamUrl) return;
    try {
      await navigator.clipboard.writeText(rawStreamUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2500);
    } catch {
      // Fallback ignored
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Reproduzindo ${item.title}`}
      className="fixed inset-0 z-50 flex flex-col justify-between bg-black text-white select-none"
    >
      {/* Video Viewport */}
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        {rawStreamUrl && (
          <HybridPlayer
            url={rawStreamUrl}
            title={item.title}
            isLive={isLive}
            initialProgressPercent={initialProgressPercent}
            initialTimeSeconds={initialTimeSeconds}
            isPlaying={isPlaying}
            isMuted={isMuted}
            volume={volume}
            nativeControls={false}
            showOverlay={false}
            showDiagnostics={showDiagnostics}
            streamProxyPrefix={streamProxyPrefix}
            autoProxyHttpStreams={autoProxyHttpStreams}
            forceProxy={forceInternalProxy}
            enablePreflight={true}
            onVideoElement={handleVideoElement}
            onBufferingChange={(buffering, msg) => {
              setIsBuffering(buffering);
              if (msg) setStatusMessage(msg);
            }}
            onReady={(vidDur) => {
              setIsBuffering(false);
              setIsReady(true);
              setStatusMessage('');
              if (vidDur > 0) {
                setDuration(vidDur);
                latestTimeRef.current.duration = vidDur;
              }
            }}
            onPlayStateChange={setIsPlaying}
            onTimeUpdate={(curr, dur) => {
              setCurrentTime(curr);
              latestTimeRef.current.currentTime = curr;
              if (dur > 0) {
                setDuration(dur);
                latestTimeRef.current.duration = dur;
              }
              if (isReady) {
                commitProgress(curr, dur, false);
              }
            }}
            onPause={(curr, dur) => {
              commitProgress(curr, dur, true);
            }}
            onEnded={() => {
              const effDur =
                latestTimeRef.current.duration || duration || item.durationSeconds;
              if (effDur > 0) {
                commitProgress(effDur, effDur, true);
              }
            }}
            onError={(err) => {
              advanceToNextSourceOrFail(err.reason, err.isMixedContentOrCors);
            }}
          />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/75" />
      </div>

      {/* Top Bar */}
      <div className="relative z-20 flex items-center justify-between gap-4 px-5 py-5 sm:px-10">
        <button
          type="button"
          onClick={handleCloseWithSave}
          className="inline-flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/65 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/15"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar ao catálogo
        </button>

        <div className="hidden text-center sm:block">
          <p className="font-display text-base font-bold tracking-tight text-white">
            {item.title}
          </p>
          <p className="text-xs text-white/65">
            {isLive ? 'TV ao Vivo' : episodeLabel || item.duration} ·{' '}
            {PLATFORM_LABELS[item.platform]}
            {activeSource ? ` · ${activeSource.label}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDiagnostics((d) => !d)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium backdrop-blur-md transition-colors ${
              showDiagnostics
                ? 'border-[#E50914]/60 bg-[#E50914]/20 text-white'
                : 'border-white/15 bg-black/65 text-white/85 hover:bg-white/15'
            }`}
          >
            <Activity className="h-3.5 w-3.5 text-[#E50914]" />
            Diagnóstico
          </button>

          <button
            type="button"
            onClick={handleCopyStreamUrl}
            title="Copiar URL do Stream para VLC"
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/65 px-3 py-2 text-xs font-medium text-white/85 backdrop-blur-md hover:bg-white/15"
          >
            {copiedUrl ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                URL Copiada
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copiar URL
              </>
            )}
          </button>
        </div>
      </div>

      {/* Center Status / Error Overlay */}
      <div className="relative z-20 mx-auto flex max-w-lg flex-col items-center justify-center px-4 text-center">
        {isBuffering && !playbackError && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/70 px-6 py-5 backdrop-blur-md">
            <Loader2 className="h-8 w-8 animate-spin text-[#E50914]" />
            <p className="text-xs font-medium text-white/85">
              {statusMessage || 'Carregando stream...'}
            </p>
          </div>
        )}

        {playbackError && (
          <div className="w-full space-y-4 rounded-xl border border-white/15 bg-[#121417]/95 p-6 shadow-2xl backdrop-blur-xl">
            <AlertTriangle className="mx-auto h-9 w-9 text-amber-400" />
            <div>
              <h3 className="font-display text-lg font-bold text-white">
                Falha ao reproduzir no navegador
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-white/75">
                {playbackError.reason}
              </p>
              {rawStreamUrl && (
                <p className="mt-2 truncate rounded bg-black/60 px-2.5 py-1.5 font-mono text-[11px] text-white/55">
                  {redactUrlCredentials(rawStreamUrl)}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={handleCopyStreamUrl}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-4 text-xs font-bold text-[#0B0C0E] hover:bg-white/90"
              >
                {copiedUrl ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Copiado!
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copiar URL do Stream (VLC)
                  </>
                )}
              </button>

              {playbackError.isMixedContentOrCors && !forceInternalProxy && (
                <button
                  type="button"
                  onClick={() => {
                    setForceInternalProxy(true);
                    setSourceIndex(0);
                    setPlaybackError(null);
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E50914] px-4 text-xs font-bold text-white hover:bg-[#c80812]"
                >
                  Tentar via Proxy Interno
                </button>
              )}

              {onOpenAdminSettings && (
                <button
                  type="button"
                  onClick={() => {
                    handleCloseWithSave();
                    onOpenAdminSettings();
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 bg-[#181B20] px-3.5 text-xs font-semibold text-white/85 hover:bg-white/10"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Configurar Proxy
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Floating Next Episode Card (Last 30s of Series Episode) */}
      {showNextEpisodeCard && nextEpisode && (
        <div
          role="region"
          aria-label="Próximo Episódio"
          className="fixed right-5 bottom-28 z-30 w-80 overflow-hidden rounded-xl border border-white/15 bg-[#121417]/95 shadow-2xl backdrop-blur-xl sm:right-10 sm:bottom-32 sm:w-96"
        >
          <div className="flex gap-3 p-3">
            <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-black/70">
              <MediaImage
                src={item.backdropImage || item.posterImage}
                alt={nextEpisode.title}
                className="h-full w-full object-cover"
              />
              <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">
                T{nextEpisode.season}:E{nextEpisode.episode}
              </span>
            </div>

            <div className="min-w-0 flex-1 flex flex-col justify-between">
              <div>
                <p className="text-[11px] font-semibold tracking-wide text-[#E50914] uppercase">
                  A seguir · T{nextEpisode.season}:E{nextEpisode.episode}
                </p>
                <p className="mt-0.5 line-clamp-2 font-display text-sm font-bold text-white">
                  {nextEpisode.episode}. {nextEpisode.title}
                </p>
              </div>
              {nextEpisode.duration && (
                <p className="text-[11px] text-white/55 tabular-nums">
                  {nextEpisode.duration}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-white/10 bg-black/35 px-3 py-2.5">
            <button
              type="button"
              onClick={handleAdvanceToNextEpisode}
              className="relative flex-1 inline-flex h-9 items-center justify-center gap-1.5 overflow-hidden rounded-lg bg-white px-3 text-xs font-bold text-[#0B0C0E] transition-colors hover:bg-white/90"
            >
              <span
                className="absolute inset-y-0 left-0 bg-[#E50914]/15 transition-all duration-1000 ease-linear"
                style={{ width: `${((10 - nextEpCountdown) / 10) * 100}%` }}
              />
              <SkipForward className="relative z-10 h-3.5 w-3.5 fill-current" />
              <span className="relative z-10 tabular-nums">
                Próximo Episódio ({nextEpCountdown}s)
              </span>
            </button>

            <button
              type="button"
              onClick={() => setDismissedNextEpKey(currentEpisodeKey)}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-white/15 bg-white/5 px-3 text-xs font-semibold text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Bottom Control Dock */}
      <div className="relative z-20 space-y-4 px-5 pb-6 sm:px-10 sm:pb-8">
        {!isLive && (
          <div className="flex items-center gap-3">
            <span className="w-14 text-right text-xs font-medium text-white/80 tabular-nums">
              {formatTime(currentTime)}
            </span>

            <input
              type="range"
              min={0}
              max={duration || 100}
              value={Math.min(currentTime, duration || 100)}
              onChange={(e) => handleSeek(Number(e.target.value))}
              aria-label="Linha do tempo do vídeo"
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/25 accent-[#E50914]"
            />

            <span className="w-14 text-xs font-medium text-white/60 tabular-nums">
              {formatTime(duration)}
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => {
                const next = !isPlaying;
                if (!next) {
                  commitProgress(
                    latestTimeRef.current.currentTime,
                    latestTimeRef.current.duration,
                    true
                  );
                }
                setIsPlaying(next);
                if (next && videoRef.current?.paused) {
                  videoRef.current.play().catch(() => {});
                }
              }}
              aria-label={isPlaying ? 'Pausar' : 'Reproduzir'}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#0B0C0E] transition-transform hover:scale-105"
            >
              {isPlaying ? (
                <Pause className="h-5 w-5 fill-current" />
              ) : (
                <Play className="h-5 w-5 fill-current ml-0.5" />
              )}
            </button>

            {!isLive && (
              <>
                <button
                  type="button"
                  onClick={() => handleSeek(Math.max(0, currentTime - 10))}
                  aria-label="Voltar 10 segundos"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white/85 hover:bg-white/10"
                >
                  <RotateCcw className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleSeek(Math.min(duration, currentTime + 10))
                  }
                  aria-label="Avançar 10 segundos"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white/85 hover:bg-white/10"
                >
                  <RotateCw className="h-5 w-5" />
                </button>
              </>
            )}

            <div className="flex items-center gap-2 pl-2">
              <button
                type="button"
                onClick={() => setIsMuted((m) => !m)}
                aria-label={isMuted ? 'Ativar som' : 'Silenciar'}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white/85 hover:bg-white/10"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="h-5 w-5" />
                ) : (
                  <Volume2 className="h-5 w-5" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  setIsMuted(false);
                }}
                aria-label="Volume"
                className="hidden h-1 w-24 cursor-pointer appearance-none rounded-full bg-white/30 accent-white sm:block"
              />
            </div>

            {isLive && (
              <span className="ml-2 rounded-[4px] bg-[#E50914] px-2 py-0.5 text-[11px] font-bold tracking-wider text-white uppercase">
                AO VIVO
              </span>
            )}
          </div>

          <div className="relative flex items-center gap-2">
            {/* Fonte 1/X & Versões Selector */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowSourcesMenu((s) => !s)}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/15 bg-black/60 px-3.5 text-xs font-semibold text-white hover:bg-white/15 tabular-nums"
              >
                <Layers className="h-4 w-4 text-[#E50914]" />
                <span>
                  {availableSources.length > 0
                    ? `Fonte ${sourceIndex + 1}/${availableSources.length}${
                        activeSource?.qualityTag
                          ? ` · ${activeSource.qualityTag}`
                          : ''
                      }`
                    : 'Fonte 0/0'}
                </span>
              </button>

              {showSourcesMenu && (
                <div className="absolute right-0 bottom-12 w-72 rounded-lg border border-white/15 bg-[#121417] p-1.5 shadow-2xl">
                  <p className="px-2.5 py-1.5 text-[11px] font-semibold text-white/45 uppercase">
                    Fontes e Versões ({availableSources.length})
                  </p>
                  {availableSources.length === 0 ? (
                    <p className="px-2.5 py-2 text-xs text-white/60">
                      Nenhuma fonte alternativa disponível.
                    </p>
                  ) : (
                    availableSources.map((src, idx) => (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => {
                          setSourceIndex(idx);
                          setShowSourcesMenu(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs font-medium transition-colors ${
                          idx === sourceIndex
                            ? 'bg-[#E50914] text-white'
                            : 'text-white/85 hover:bg-white/10'
                        }`}
                      >
                        <span className="truncate pr-2">
                          {src.label}
                        </span>
                        <span className="shrink-0 text-[10px] opacity-85">
                          {src.status === 'online'
                            ? 'Online'
                            : src.status === 'offline'
                              ? 'Offline'
                              : 'Stream'}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label="Alternar tela cheia"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 bg-black/60 text-white/85 hover:bg-white/15"
            >
              {isFullscreen ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
