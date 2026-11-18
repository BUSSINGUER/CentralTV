import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
} from 'lucide-react';
import { redactUrlCredentials } from '../services/streamOrigins';

import {
  DetectedMediaType,
  HybridEngineKind,
  detectMediaTypeFromUrl,
  evaluateNativeCodecSupport,
  classifyM3uContent,
  unwrapTargetUrl,
  getCleanPath,
} from './player/MediaTypeDetector';
import {
  PlaybackAttempt,
  applyStreamProxyUrl,
  buildPlaybackAttempts,
} from './player/MediaSourceResolver';
import {
  PlayerDiagnostics,
  DiagnosticHttpEntry,
  DiagnosticHlsError,
  MEDIA_ERROR_LABELS,
  createInitialDiagnostics,
  PlayerDiagnosticsPanel,
} from './player/PlaybackDiagnostics';

export type {
  HybridEngineKind,
  DetectedMediaType,
  PlayerDiagnostics,
  DiagnosticHttpEntry,
  DiagnosticHlsError,
};

export interface HybridPlayerError {
  reason: string;
  isMixedContentOrCors: boolean;
  httpStatus?: number;
  mediaErrorCode?: number;
  mediaErrorMessage?: string;
}

export interface HybridPlayerProps {
  url: string;
  title: string;
  isLive?: boolean;
  initialProgressPercent?: number;
  initialTimeSeconds?: number;
  isPlaying?: boolean;
  isMuted?: boolean;
  volume?: number;
  nativeControls?: boolean;
  showOverlay?: boolean;
  showDiagnostics?: boolean;
  streamProxyPrefix?: string;
  autoProxyHttpStreams?: boolean;
  forceProxy?: boolean;
  enablePreflight?: boolean;
  onVideoElement?: (video: HTMLVideoElement | null) => void;
  onEngineChange?: (engine: HybridEngineKind) => void;
  onDiagnosticsChange?: (diag: PlayerDiagnostics) => void;
  onBufferingChange?: (buffering: boolean, statusMessage?: string) => void;
  onReady?: (durationSeconds: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onPause?: (currentTime: number, duration: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onError?: (error: HybridPlayerError) => void;
  onEnded?: () => void;
  className?: string;
}

interface ShakaPlayerInstance {
  attach: (mediaElement: HTMLMediaElement) => Promise<void>;
  load: (assetUri: string) => Promise<void>;
  addEventListener: (
    type: string,
    listener: (event: Event & { detail?: unknown }) => void
  ) => void;
  destroy: () => Promise<void>;
}

export function HybridPlayer({
  url,
  title,
  isLive = false,
  initialProgressPercent = 0,
  initialTimeSeconds = 0,
  isPlaying = true,
  isMuted = false,
  volume = 90,
  nativeControls = true,
  showOverlay = true,
  showDiagnostics = false,
  streamProxyPrefix = '',
  autoProxyHttpStreams = true,
  forceProxy = false,
  enablePreflight = false,
  onVideoElement,
  onEngineChange,
  onDiagnosticsChange,
  onBufferingChange,
  onReady,
  onTimeUpdate,
  onPause,
  onPlayStateChange,
  onError,
  onEnded,
  className = '',
}: HybridPlayerProps) {
  const initialMediaType = useMemo(
    () => detectMediaTypeFromUrl(url, isLive),
    [url, isLive]
  );

  const [isBuffering, setIsBuffering] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Carregando stream...');
  const [errorState, setErrorState] = useState<HybridPlayerError | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [directVideoSrc, setDirectVideoSrc] = useState<string | undefined>(
    undefined
  );
  const [diagnostics, setDiagnostics] = useState<PlayerDiagnostics>(() =>
    createInitialDiagnostics(url, initialMediaType)
  );
  const [diagExpanded, setDiagExpanded] = useState(true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shakaRef = useRef<ShakaPlayerInstance | null>(null);
  const mpegtsRef = useRef<mpegts.Player | null>(null);
  const failTimeoutRef = useRef<number | null>(null);
  const playStartPerfRef = useRef<number>(performance.now());
  const firstFrameRecordedRef = useRef(false);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const initialProgressRef = useRef(initialProgressPercent);
  initialProgressRef.current = initialProgressPercent;
  const initialTimeRef = useRef(initialTimeSeconds);
  initialTimeRef.current = initialTimeSeconds;

  const callbacksRef = useRef({
    onVideoElement,
    onEngineChange,
    onDiagnosticsChange,
    onBufferingChange,
    onReady,
    onTimeUpdate,
    onPause,
    onPlayStateChange,
    onError,
    onEnded,
  });
  callbacksRef.current = {
    onVideoElement,
    onEngineChange,
    onDiagnosticsChange,
    onBufferingChange,
    onReady,
    onTimeUpdate,
    onPause,
    onPlayStateChange,
    onError,
    onEnded,
  };

  const patchDiagnostics = useCallback(
    (updater: (prev: PlayerDiagnostics) => PlayerDiagnostics) => {
      setDiagnostics((prev) => {
        const next = updater(prev);
        callbacksRef.current.onDiagnosticsChange?.(next);
        return next;
      });
    },
    []
  );

  const attempts = useMemo(
    () =>
      buildPlaybackAttempts(
        url,
        initialMediaType,
        streamProxyPrefix,
        autoProxyHttpStreams,
        forceProxy
      ),
    [url, initialMediaType, streamProxyPrefix, autoProxyHttpStreams, forceProxy]
  );

  useEffect(() => {
    setAttemptIndex(0);
    setErrorState(null);
    setAutoplayBlocked(false);
    setIsReady(false);
    setIsBuffering(Boolean(url));
    setDirectVideoSrc(undefined);
    firstFrameRecordedRef.current = false;
    setDiagnostics(createInitialDiagnostics(url, initialMediaType));
  }, [url, initialMediaType, forceProxy, autoProxyHttpStreams, streamProxyPrefix]);

  // Stable ref callback so parent re-renders NEVER detach/reattach <video>
  const setVideoNode = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    callbacksRef.current.onVideoElement?.(node);
  }, []);

  const destroyPlayers = useCallback((clearNativeAttr = true) => {
    if (failTimeoutRef.current) {
      window.clearTimeout(failTimeoutRef.current);
      failTimeoutRef.current = null;
    }

    if (hlsRef.current) {
      const hls = hlsRef.current;
      hlsRef.current = null;
      try {
        hls.destroy();
      } catch {
        // Ignore HLS teardown errors
      }
    }

    if (shakaRef.current) {
      const shakaPlayer = shakaRef.current;
      shakaRef.current = null;
      void shakaPlayer.destroy().catch(() => {});
    }

    if (mpegtsRef.current) {
      const tsPlayer = mpegtsRef.current;
      mpegtsRef.current = null;
      try {
        tsPlayer.unload();
        tsPlayer.detachMediaElement();
        tsPlayer.destroy();
      } catch {
        // Ignore mpegts teardown errors
      }
    }

    const video = videoRef.current;
    if (video) {
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.oncanplay = null;
      video.onplaying = null;
      video.onstalled = null;
      video.onresize = null;
      video.onerror = null;
      if (clearNativeAttr && video.hasAttribute('src')) {
        try {
          video.pause();
        } catch {
          // Ignore pause race
        }
        video.removeAttribute('src');
        try {
          video.load();
        } catch {
          // Ignore reset load errors
        }
      }
    }
  }, []);

  const attemptManualPlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setAutoplayBlocked(false);
    try {
      await video.play();
      callbacksRef.current.onPlayStateChange?.(true);
    } catch (err) {
      const e = err as DOMException | Error;
      const name = e?.name || 'PlayError';
      const message = e?.message || 'Falha ao iniciar reprodução manual';
      patchDiagnostics((prev) => ({
        ...prev,
        playRejection: { name, message, timestampMs: Date.now() },
      }));
      if (name === 'NotAllowedError') {
        setAutoplayBlocked(true);
      }
    }
  }, [patchDiagnostics]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    destroyPlayers(false);
    setIsReady(false);
    setErrorState(null);
    setAutoplayBlocked(false);
    firstFrameRecordedRef.current = false;
    playStartPerfRef.current = performance.now();

    if (!url || attempts.length === 0) {
      setDirectVideoSrc(undefined);
      const emptyErr: HybridPlayerError = {
        reason: 'Nenhuma URL de stream informada para reprodução.',
        isMixedContentOrCors: false,
      };
      setIsBuffering(false);
      setErrorState(emptyErr);
      callbacksRef.current.onBufferingChange?.(false, '');
      callbacksRef.current.onError?.(emptyErr);
      return;
    }

    const currentAttempt = attempts[attemptIndex] || attempts[attempts.length - 1];
    const targetUrl = currentAttempt.url;
    const isProxyTarget = currentAttempt.mode === 'proxy';

    let cancelled = false;
    let readyFired = false;
    let seekApplied = false;
    let handledFailure = false;
    const abortController = new AbortController();

    const codecCheck = evaluateNativeCodecSupport(video, initialMediaType);
    patchDiagnostics((prev) => ({
      ...prev,
      mediaType: initialMediaType,
      codecSupportNote: codecCheck.note,
      finalUrlRedacted: redactUrlCredentials(targetUrl),
    }));

    const updateBuffering = (buffering: boolean, msg = '') => {
      if (cancelled) return;
      setIsBuffering(buffering);
      setStatusMessage(msg);
      callbacksRef.current.onBufferingChange?.(buffering, msg);
    };

    const recordHttp = (entry: Omit<DiagnosticHttpEntry, 'timestampMs'>) => {
      if (cancelled) return;
      patchDiagnostics((prev) => ({
        ...prev,
        httpStatuses: [
          ...prev.httpStatuses.slice(-7),
          { ...entry, timestampMs: Date.now() },
        ],
      }));
    };

    const diagnoseHttpResponseOnFailure = async (
      failedUrl: string
    ): Promise<{
      reason: string;
      isMixedContentOrCors: boolean;
      httpStatus?: number;
    }> => {
      const isHttpsPage =
        typeof window !== 'undefined' && window.location.protocol === 'https:';
      const isHttpRaw = /^http:\/\//i.test(url);

      if (failedUrl.startsWith('/api/stream') || /^https?:\/\//i.test(failedUrl)) {
        try {
          const probeUrl = failedUrl.startsWith('/api/stream')
            ? failedUrl
            : `/api/check-stream?url=${encodeURIComponent(failedUrl)}&timeoutMs=4500`;
          const resp = await fetch(probeUrl, {
            method: 'GET',
            headers: failedUrl.startsWith('/api/stream')
              ? { Range: 'bytes=0-511' }
              : {},
            signal: AbortSignal.timeout(4500),
          });

          if (failedUrl.startsWith('/api/stream')) {
            const errCode = resp.headers.get('x-aura-error-code') || '';
            const upstreamStatus = resp.headers.get('x-aura-upstream-status');
            const upstreamCt = resp.headers.get('x-aura-upstream-content-type') || '';
            const bodyText = !resp.ok ? (await resp.text().catch(() => '')).slice(0, 200) : '';

            recordHttp({
              urlRedacted: redactUrlCredentials(failedUrl),
              status: resp.status,
              contentType: upstreamCt || resp.headers.get('content-type') || '',
              note: errCode || (upstreamStatus ? `upstream=${upstreamStatus}` : undefined),
            });

            if (errCode === 'upstream_html') {
              return {
                reason: `O servidor de origem respondeu HTTP ${upstreamStatus || resp.status} com página HTML (${upstreamCt || 'text/html'}) em vez de vídeo (ex.: conta expirada, debug mode ou link offline).`,
                isMixedContentOrCors: false,
                httpStatus: resp.status,
              };
            }
            if (errCode === 'm3u_playlist_not_hls') {
              return {
                reason: 'A URL aponta para uma lista M3U de canais e não para um stream de vídeo ou manifesto HLS.',
                isMixedContentOrCors: false,
                httpStatus: resp.status,
              };
            }
            if (errCode === 'origin_not_allowed' || errCode === 'ssrf_blocked') {
              return {
                reason: bodyText || `Proxy bloqueou a requisição (${errCode}, HTTP ${resp.status}).`,
                isMixedContentOrCors: false,
                httpStatus: resp.status,
              };
            }
            if (resp.status >= 400) {
              return {
                reason: bodyText || `Servidor de origem retornou HTTP ${upstreamStatus || resp.status}.`,
                isMixedContentOrCors: false,
                httpStatus: resp.status,
              };
            }
          } else if (resp.ok) {
            const check = (await resp.json().catch(() => null)) as {
              ok?: boolean;
              status?: number;
              contentType?: string;
              reason?: string;
            } | null;
            if (check) {
              recordHttp({
                urlRedacted: redactUrlCredentials(failedUrl),
                status: check.status ?? 0,
                contentType: check.contentType,
                note: check.reason,
              });
              if (check.ok === false) {
                return {
                  reason: check.reason || `Servidor respondeu HTTP ${check.status}`,
                  isMixedContentOrCors: false,
                  httpStatus: check.status,
                };
              }
            }
          }
        } catch {
          // Diagnostic check timed out or aborted
        }
      }

      if (isHttpsPage && isHttpRaw && !isProxyTarget) {
        return {
          reason:
            'Conteúdo misto (HTTP em página HTTPS) bloqueado pelo navegador ao tentar reprodução direta.',
          isMixedContentOrCors: true,
        };
      }

      return {
        reason: 'Não foi possível reproduzir este stream.',
        isMixedContentOrCors: false,
      };
    };

    const failOrAdvanceAttempt = async (
      rawReason: string,
      opts?: {
        isMixedOrCors?: boolean;
        httpStatus?: number;
        skipAdvance?: boolean;
        mediaErr?: { code: number; label: string; message: string } | null;
      }
    ) => {
      if (cancelled || handledFailure) return;
      handledFailure = true;
      if (failTimeoutRef.current) {
        window.clearTimeout(failTimeoutRef.current);
        failTimeoutRef.current = null;
      }

      const diagnosed =
        opts?.httpStatus || opts?.mediaErr?.code === 3
          ? {
              reason: rawReason,
              isMixedContentOrCors: Boolean(opts?.isMixedOrCors),
              httpStatus: opts?.httpStatus,
            }
          : await diagnoseHttpResponseOnFailure(targetUrl);

      if (cancelled) return;

      const finalReason =
        diagnosed.reason !== 'Não foi possível reproduzir este stream.'
          ? diagnosed.reason
          : rawReason;

      // Do not retry proxy if the failure is an unsupported local container/codec (MEDIA_ERR_DECODE)
      // or an M3U playlist mistakenly treated as a video stream
      const canAdvance =
        !opts?.skipAdvance &&
        attemptIndex + 1 < attempts.length &&
        opts?.mediaErr?.code !== 3;

      if (canAdvance) {
        const nextAttempt = attempts[attemptIndex + 1];
        updateBuffering(
          true,
          `Falha em ${currentAttempt.label}. Tentando ${nextAttempt.label}...`
        );
        window.setTimeout(() => {
          if (!cancelled) {
            destroyPlayers(true);
            setDirectVideoSrc(undefined);
            setAttemptIndex((idx) => idx + 1);
          }
        }, 0);
        return;
      }

      const finalError: HybridPlayerError = {
        reason: finalReason,
        isMixedContentOrCors: diagnosed.isMixedContentOrCors,
        httpStatus: diagnosed.httpStatus,
        mediaErrorCode: opts?.mediaErr?.code,
        mediaErrorMessage: opts?.mediaErr?.message,
      };

      updateBuffering(false, '');
      setErrorState(finalError);
      window.setTimeout(() => {
        if (!cancelled) {
          destroyPlayers(true);
          setDirectVideoSrc(undefined);
          callbacksRef.current.onError?.(finalError);
        }
      }, 0);
    };

    const markFirstFrameIfNeeded = () => {
      if (cancelled || firstFrameRecordedRef.current) return;
      firstFrameRecordedRef.current = true;
      const elapsed = Math.max(
        1,
        Math.round(performance.now() - playStartPerfRef.current)
      );
      patchDiagnostics((prev) => ({
        ...prev,
        timeToFirstFrameMs: elapsed,
      }));
    };

    const tryAutoPlayWithRecovery = () => {
      if (cancelled || !isPlayingRef.current) return;
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err: unknown) => {
          if (cancelled) return;
          const e = err as DOMException | Error;
          const name = e?.name || 'PlayError';
          const message = e?.message || 'Rejeição em video.play()';
          patchDiagnostics((prev) => ({
            ...prev,
            playRejection: { name, message, timestampMs: Date.now() },
          }));

          if (name === 'NotAllowedError') {
            // Autoplay with audio blocked -> surface manual play button cleanly instead of fake error
            setAutoplayBlocked(true);
            updateBuffering(false, '');
            callbacksRef.current.onPlayStateChange?.(false);
          } else if (name === 'NotSupportedError') {
            void failOrAdvanceAttempt(
              `Formato ou codec não suportado (${message}).`,
              { skipAdvance: false }
            );
          }
        });
      }
    };

    const applyInitialResumeSeek = () => {
      if (cancelled || seekApplied || isLive) return;
      const vidDur =
        video.duration && Number.isFinite(video.duration)
          ? Math.floor(video.duration)
          : 0;
      if (vidDur <= 0 || video.readyState < 1) return;

      const exactSec = initialTimeRef.current;
      const resumePct = initialProgressRef.current;
      const targetSec =
        exactSec > 0
          ? Math.floor(exactSec)
          : resumePct > 0
            ? Math.floor((resumePct / 100) * vidDur)
            : 0;

      seekApplied = true;
      const maxResumeSec = vidDur * 0.92;
      if (targetSec > 10 && targetSec < maxResumeSec) {
        try {
          video.currentTime = targetSec;
        } catch {
          seekApplied = false;
        }
      }
    };

    const wireCommonVideoDiagnosticListeners = () => {
      video.onloadedmetadata = () => {
        if (cancelled) return;
        patchDiagnostics((prev) => ({
          ...prev,
          loadedmetadata: {
            fired: true,
            timestampMs: Date.now(),
            width: video.videoWidth || undefined,
            height: video.videoHeight || undefined,
            duration:
              video.duration && Number.isFinite(video.duration)
                ? Math.round(video.duration)
                : undefined,
          },
        }));
        applyInitialResumeSeek();
        markReady();
      };

      video.onloadeddata = () => {
        if (cancelled) return;
        applyInitialResumeSeek();
        markFirstFrameIfNeeded();
      };

      video.oncanplay = () => {
        if (cancelled) return;
        patchDiagnostics((prev) => ({
          ...prev,
          canplay: { fired: true, timestampMs: Date.now() },
        }));
        applyInitialResumeSeek();
        markReady();
      };

      video.onplaying = () => {
        if (cancelled) return;
        setAutoplayBlocked(false);
        markFirstFrameIfNeeded();
        patchDiagnostics((prev) => ({
          ...prev,
          playing: { fired: true, timestampMs: Date.now() },
        }));
      };

      video.onstalled = () => {
        if (cancelled) return;
        patchDiagnostics((prev) => ({
          ...prev,
          stalled: {
            count: prev.stalled.count + 1,
            lastTimestampMs: Date.now(),
          },
        }));
      };

      video.onresize = () => {
        if (cancelled || !video.videoWidth || !video.videoHeight) return;
        patchDiagnostics((prev) => ({
          ...prev,
          loadedmetadata: {
            ...prev.loadedmetadata,
            width: video.videoWidth,
            height: video.videoHeight,
          },
        }));
      };
    };

    const markReady = () => {
      if (cancelled) return;
      applyInitialResumeSeek();
      if (readyFired) return;
      readyFired = true;
      if (failTimeoutRef.current) {
        window.clearTimeout(failTimeoutRef.current);
        failTimeoutRef.current = null;
      }

      updateBuffering(false, '');
      setIsReady(true);

      const vidDur =
        video.duration && Number.isFinite(video.duration)
          ? Math.floor(video.duration)
          : 0;

      if (video.paused && isPlayingRef.current) {
        tryAutoPlayWithRecovery();
      }
      callbacksRef.current.onReady?.(vidDur);
    };

    const armLoadTimeout = () => {
      if (failTimeoutRef.current) {
        window.clearTimeout(failTimeoutRef.current);
      }
      const timeoutMs = isProxyTarget ? 12000 : 8000;
      failTimeoutRef.current = window.setTimeout(() => {
        void failOrAdvanceAttempt(
          'Tempo limite esgotado ao aguardar metadados/frames do stream.'
        );
      }, timeoutMs);
    };

    const setEngine = (engine: HybridEngineKind) => {
      patchDiagnostics((prev) => ({ ...prev, engine }));
      callbacksRef.current.onEngineChange?.(engine);
    };

    const initShaka = async (dashUrl: string) => {
      if (cancelled || !videoRef.current) return;
      try {
        setDirectVideoSrc(undefined);
        setEngine('shaka');
        updateBuffering(true, `Carregando MPEG-DASH (${currentAttempt.label})...`);

        const shakaModule = await import('shaka-player');
        if (cancelled || !videoRef.current) return;

        const shaka = shakaModule.default;
        shaka.polyfill?.installAll?.();

        if (!shaka.Player.isBrowserSupported()) {
          void failOrAdvanceAttempt(
            'Navegador não suporta reprodução MPEG-DASH (MediaSource Extensions).'
          );
          return;
        }

        const player = new shaka.Player() as unknown as ShakaPlayerInstance;
        shakaRef.current = player;

        player.addEventListener('error', (event) => {
          const detail = event.detail as
            | { code?: number; message?: string }
            | undefined;
          const codeLabel = detail?.code ? `código ${detail.code}` : 'erro de rede';
          void failOrAdvanceAttempt(`Erro no Shaka Player (${codeLabel}).`);
        });

        await player.attach(videoRef.current);
        if (cancelled) {
          await player.destroy().catch(() => {});
          return;
        }

        wireCommonVideoDiagnosticListeners();
        await player.load(dashUrl);
        if (!cancelled) {
          markReady();
        }
      } catch (err) {
        if (!cancelled) {
          const msg =
            err instanceof Error
              ? err.message
              : 'Falha ao carregar manifesto no Shaka Player.';
          void failOrAdvanceAttempt(msg);
        }
      }
    };

    const initHlsPlayback = async (hlsUrl: string) => {
      if (cancelled || !videoRef.current) return;
      setDirectVideoSrc(undefined);

      // 1. Prioritize native HLS when genuinely available (Safari / iOS)
      const nativeHlsSupport =
        video.canPlayType('application/vnd.apple.mpegurl') ||
        video.canPlayType('application/x-mpegURL');

      if (nativeHlsSupport) {
        setEngine('native-hls');
        updateBuffering(true, `Carregando HLS nativo (${currentAttempt.label})...`);
        wireCommonVideoDiagnosticListeners();
        video.onerror = () => {
          const code = video.error?.code || 0;
          const mediaErr = code
            ? {
                code,
                label: MEDIA_ERROR_LABELS[code] || `CODE_${code}`,
                message: video.error?.message || '',
              }
            : null;
          patchDiagnostics((prev) => ({
            ...prev,
            errorEvent: { fired: true, timestampMs: Date.now() },
            mediaError: mediaErr,
          }));
          void failOrAdvanceAttempt('Erro ao reproduzir stream HLS nativo.', {
            mediaErr,
          });
        };
        setDirectVideoSrc(hlsUrl);
        return;
      }

      // 2. Use HLS.js when native HLS is not available and MSE is supported
      if (!Hls.isSupported()) {
        void initShaka(hlsUrl);
        return;
      }

      // Verify manifest is genuinely HLS (never an IPTV channel M3U list)
      if (hlsUrl.startsWith('/api/stream')) {
        try {
          const headCheck = await fetch(hlsUrl, { signal: abortController.signal });
          recordHttp({
            urlRedacted: redactUrlCredentials(hlsUrl),
            status: headCheck.status,
            contentType: headCheck.headers.get('content-type') || '',
          });
          if (!headCheck.ok) {
            const errCode = headCheck.headers.get('x-aura-error-code') || '';
            const upstreamStatus = Number(headCheck.headers.get('x-aura-upstream-status') || headCheck.status);
            const text = await headCheck.text().catch(() => '');
            void failOrAdvanceAttempt(
              text || `Manifesto HLS retornou HTTP ${upstreamStatus}`,
              {
                httpStatus: headCheck.status,
                skipAdvance:
                  errCode === 'm3u_playlist_not_hls' ||
                  errCode === 'origin_not_allowed' ||
                  errCode === 'ssrf_blocked',
              }
            );
            return;
          }
          const manifestText = await headCheck.text();
          if (classifyM3uContent(manifestText) === 'm3u_playlist') {
            void failOrAdvanceAttempt(
              'O link aponta para uma lista M3U de canais e não para um manifesto HLS (.m3u8).',
              { skipAdvance: true, httpStatus: 422 }
            );
            return;
          }
        } catch (err) {
          if (cancelled || (err as Error)?.name === 'AbortError') return;
        }
      }

      if (cancelled) return;
      setEngine('hls.js');
      updateBuffering(true, `Carregando HLS.js (${currentAttempt.label})...`);
      wireCommonVideoDiagnosticListeners();

      const customPrefix = streamProxyPrefix.trim();
      const needsCustomSegmentProxy = autoProxyHttpStreams && Boolean(customPrefix);

      const BaseLoader = Hls.DefaultConfig.loader;
      class ProxySegmentLoader extends BaseLoader {
        load(
          context: Parameters<InstanceType<typeof BaseLoader>['load']>[0],
          config: Parameters<InstanceType<typeof BaseLoader>['load']>[1],
          callbacks: Parameters<InstanceType<typeof BaseLoader>['load']>[2]
        ) {
          if (
            context.url &&
            /^http:\/\//i.test(context.url) &&
            !context.url.startsWith('/api/stream')
          ) {
            context.url = applyStreamProxyUrl(context.url, customPrefix);
          }
          super.load(context, config, callbacks);
        }
      }

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: isLive,
        manifestLoadingTimeOut: isProxyTarget ? 10000 : 6000,
        ...(needsCustomSegmentProxy ? { loader: ProxySegmentLoader } : {}),
      });
      hlsRef.current = hls;

      let mediaRecoveryAttempted = false;
      let networkRecoveryAttempted = false;

      hls.on(Hls.Events.MANIFEST_LOADED, (_ev, data) => {
        if (cancelled) return;
        const respCode = data.networkDetails instanceof XMLHttpRequest
          ? data.networkDetails.status
          : 200;
        recordHttp({
          urlRedacted: redactUrlCredentials(data.url || hlsUrl),
          status: respCode || 200,
          note: `HLS ${data.levels?.length || 0} qualidade(s)`,
        });
      });

      hls.on(Hls.Events.FRAG_LOADED, (_ev, data) => {
        if (cancelled) return;
        if (!firstFrameRecordedRef.current) {
          const statsStatus =
            data.frag?.stats?.loading?.start ? 200 : 200;
          recordHttp({
            urlRedacted: redactUrlCredentials(data.frag?.url || ''),
            status: statsStatus,
            note: `Seg #${data.frag?.sn ?? 0}`,
          });
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, markReady);

      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (cancelled) return;
        const httpCode = data.response?.code;
        patchDiagnostics((prev) => ({
          ...prev,
          hlsErrors: [
            ...prev.hlsErrors.slice(-7),
            {
              type: String(data.type),
              details: String(data.details),
              fatal: Boolean(data.fatal),
              httpCode,
              urlRedacted: redactUrlCredentials(data.url || hlsUrl),
              timestampMs: Date.now(),
            },
          ],
          ...(httpCode
            ? {
                httpStatuses: [
                  ...prev.httpStatuses.slice(-7),
                  {
                    urlRedacted: redactUrlCredentials(data.url || hlsUrl),
                    status: httpCode,
                    note: `HLS ${data.details}`,
                    timestampMs: Date.now(),
                  },
                ],
              }
            : {}),
        }));

        if (!data.fatal) return;

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryAttempted) {
          mediaRecoveryAttempted = true;
          hls.recoverMediaError();
          return;
        }

        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          !networkRecoveryAttempted &&
          (!httpCode || httpCode >= 500)
        ) {
          networkRecoveryAttempted = true;
          hls.startLoad();
          return;
        }

        const isStatusZeroCorsCandidate =
          data.type === Hls.ErrorTypes.NETWORK_ERROR && !httpCode;

        const reason = httpCode
          ? `Erro HLS HTTP ${httpCode} (${data.details})`
          : `Erro fatal HLS (${data.details || 'Falha de rede ou manifesto'})`;

        void failOrAdvanceAttempt(reason, {
          httpStatus: httpCode,
          isMixedOrCors: isStatusZeroCorsCandidate && !isProxyTarget,
        });
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
    };

    const initMpegTs = (tsUrl: string) => {
      if (cancelled || !videoRef.current) return;
      setDirectVideoSrc(undefined);
      if (!mpegts.isSupported()) {
        void initShaka(tsUrl);
        return;
      }

      try {
        setEngine('mpegts.js');
        updateBuffering(true, `Conectando transmissão MPEG-TS (${currentAttempt.label})...`);
        wireCommonVideoDiagnosticListeners();

        mpegts.LoggingControl?.applyConfig({
          enableAll: false,
          enableDebug: false,
          enableVerbose: false,
          enableInfo: false,
          enableWarn: false,
          enableError: false,
        });

        const tsPlayer = mpegts.createPlayer(
          {
            type: 'mpegts',
            isLive,
            url: tsUrl,
          },
          {
            enableWorker: false,
            isLive,
            stashInitialSize: 128,
            lazyLoad: !isLive,
            lazyLoadMaxDuration: 3 * 60,
            ...(isLive ? {} : { seekType: 'range' }),
          }
        );

        mpegtsRef.current = tsPlayer;
        tsPlayer.attachMediaElement(video);
        tsPlayer.on(mpegts.Events.MEDIA_INFO, markReady);
        tsPlayer.on(mpegts.Events.ERROR, (errType, errDetail, errInfo) => {
          const infoObj = errInfo as { code?: number; msg?: string } | undefined;
          const httpCode = infoObj?.code && infoObj.code >= 100 ? infoObj.code : undefined;
          if (httpCode) {
            recordHttp({
              urlRedacted: redactUrlCredentials(tsUrl),
              status: httpCode,
              note: String(errDetail || errType),
            });
          }
          window.setTimeout(() => {
            void failOrAdvanceAttempt(
              `Erro MPEG-TS (${String(errDetail || infoObj?.msg || 'Stream incompatível ou offline')})`,
              { httpStatus: httpCode }
            );
          }, 0);
        });
        tsPlayer.load();
      } catch {
        void failOrAdvanceAttempt('Falha ao inicializar motor MPEG-TS.');
      }
    };

    const initDirectNativeHtml5 = (mediaUrl: string, mediaType: DetectedMediaType) => {
      if (cancelled || !videoRef.current) return;

      // Never assume native support for AVI if browser explicitly says no
      if (mediaType === 'avi' && !codecCheck.canAttemptNative) {
        patchDiagnostics((prev) => ({
          ...prev,
          engine: 'native-html5',
        }));
        void failOrAdvanceAttempt(
          'Arquivos .avi não possuem suporte nativo nos navegadores web modernos. Use MP4 (H.264/AAC) ou WebM.',
          { skipAdvance: true }
        );
        return;
      }

      setEngine('native-html5');
      updateBuffering(true, `Carregando vídeo nativo (${currentAttempt.label})...`);
      wireCommonVideoDiagnosticListeners();

      video.onerror = () => {
        if (cancelled) return;
        const code = video.error?.code || 0;
        const label = MEDIA_ERROR_LABELS[code] || (code ? `CODE_${code}` : 'UNKNOWN');
        const message = video.error?.message || '';
        const mediaErr = { code, label, message };

        patchDiagnostics((prev) => ({
          ...prev,
          errorEvent: { fired: true, timestampMs: Date.now() },
          mediaError: mediaErr,
        }));

        if (code === 3) {
          void failOrAdvanceAttempt(
            `Erro de decodificação de codec/contêiner (${label}${message ? `: ${message}` : ''}).`,
            { mediaErr, skipAdvance: true }
          );
          return;
        }

        const unsupportedHint =
          mediaType === 'mkv' || mediaType === 'mov' || mediaType === 'avi'
            ? `Contêiner ${mediaType.toUpperCase()} ou codec incompatível com o navegador (${label}).`
            : `Falha ao carregar vídeo nativo (${label}${message ? `: ${message}` : ''}).`;

        void failOrAdvanceAttempt(unsupportedHint, { mediaErr });
      };

      // Native <video src={mediaUrl}> WITHOUT crossOrigin attribute so direct MP4/WebM ignores CORS
      setDirectVideoSrc(mediaUrl);
    };

    const start = async () => {
      let activeType = initialMediaType;

      // 1. Direct MP4 / WebM / MKV / MOV / AVI: NEVER route through HLS.js or Shaka Player!
      if (
        activeType === 'mp4' ||
        activeType === 'webm' ||
        activeType === 'mkv' ||
        activeType === 'avi' ||
        activeType === 'mov' ||
        activeType === 'audio'
      ) {
        armLoadTimeout();
        initDirectNativeHtml5(targetUrl, activeType);
        return;
      }

      // 2. If M3U URL, check server-side/head whether it is an M3U playlist or HLS manifest before loading HLS.js
      if (getCleanPath(url).endsWith('.m3u')) {
        try {
          const checkResp = await fetch(
            `/api/check-stream?url=${encodeURIComponent(unwrapTargetUrl(targetUrl))}&timeoutMs=4500`,
            { signal: abortController.signal }
          );
          if (cancelled) return;
          if (checkResp.ok) {
            const checkData = (await checkResp.json()) as {
              ok?: boolean;
              status?: number;
              contentType?: string;
              reason?: string;
              detectedEngine?: string;
            };
            recordHttp({
              urlRedacted: redactUrlCredentials(targetUrl),
              status: checkData.status ?? 0,
              contentType: checkData.contentType,
              note: checkData.reason,
            });
            if (checkData.ok === false) {
              void failOrAdvanceAttempt(
                checkData.reason || 'URL M3U não é um manifesto HLS reproduzível.',
                { skipAdvance: true, httpStatus: checkData.status }
              );
              return;
            }
            if (checkData.detectedEngine === 'hls') {
              activeType = 'hls';
            }
          }
        } catch (err) {
          if (cancelled || (err as Error)?.name === 'AbortError') return;
        }
      }

      // 3. Optional preflight for extensionless or live/mpegts URLs so exact media type & HTTP status are known
      if (
        enablePreflight &&
        /^https?:\/\//i.test(unwrapTargetUrl(targetUrl)) &&
        (activeType === 'unknown' || activeType === 'mpegts' || isLive)
      ) {
        try {
          const rawCheckUrl = unwrapTargetUrl(targetUrl);
          const checkResp = await fetch(
            `/api/check-stream?url=${encodeURIComponent(rawCheckUrl)}&timeoutMs=4500`,
            { signal: abortController.signal }
          );
          if (cancelled) return;
          if (checkResp.ok) {
            const checkData = (await checkResp.json()) as {
              ok?: boolean;
              status?: number;
              contentType?: string;
              reason?: string;
              detectedEngine?: 'hls' | 'mpegts' | 'shaka' | 'native';
            };
            recordHttp({
              urlRedacted: redactUrlCredentials(rawCheckUrl),
              status: checkData.status ?? 0,
              contentType: checkData.contentType,
              note: checkData.reason,
            });
            if (checkData.ok === false) {
              void failOrAdvanceAttempt(
                checkData.reason || 'Stream indisponível no servidor de origem.',
                { httpStatus: checkData.status }
              );
              return;
            }
            if (checkData.detectedEngine === 'hls') activeType = 'hls';
            else if (checkData.detectedEngine === 'shaka') activeType = 'dash';
            else if (checkData.detectedEngine === 'mpegts') activeType = 'mpegts';
            else if (checkData.detectedEngine === 'native') activeType = 'mp4';
          }
        } catch (err) {
          if (cancelled || (err as Error)?.name === 'AbortError') return;
        }
      }

      if (cancelled) return;
      armLoadTimeout();

      if (activeType === 'dash') {
        await initShaka(targetUrl);
      } else if (activeType === 'hls') {
        await initHlsPlayback(targetUrl);
      } else if (activeType === 'mpegts') {
        initMpegTs(targetUrl);
      } else {
        initDirectNativeHtml5(targetUrl, activeType);
      }
    };

    void start();

    return () => {
      cancelled = true;
      abortController.abort();
      destroyPlayers(true);
    };
  }, [
    url,
    attempts,
    attemptIndex,
    initialMediaType,
    isLive,
    enablePreflight,
    streamProxyPrefix,
    autoProxyHttpStreams,
    destroyPlayers,
    patchDiagnostics,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isReady) return;
    video.muted = isMuted;
    video.volume = Math.min(1, Math.max(0, volume / 100));
    if (isPlaying && video.paused) {
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err: unknown) => {
          const e = err as DOMException | Error;
          const name = e?.name || 'PlayError';
          const message = e?.message || 'Rejeição em video.play()';
          patchDiagnostics((prev) => ({
            ...prev,
            playRejection: { name, message, timestampMs: Date.now() },
          }));
          if (name === 'NotAllowedError') {
            setAutoplayBlocked(true);
            callbacksRef.current.onPlayStateChange?.(false);
          }
        });
      }
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isPlaying, isMuted, volume, isReady, patchDiagnostics]);

  const lastHttp = diagnostics.httpStatuses[diagnostics.httpStatuses.length - 1];
  const lastHlsErr = diagnostics.hlsErrors[diagnostics.hlsErrors.length - 1];

  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      <video
        ref={setVideoNode}
        src={directVideoSrc}
        aria-label={title}
        playsInline
        controls={nativeControls}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (!video) return;
          const dur =
            video.duration && Number.isFinite(video.duration)
              ? Math.floor(video.duration)
              : 0;
          callbacksRef.current.onTimeUpdate?.(
            Math.floor(video.currentTime),
            dur
          );
        }}
        onWaiting={() => {
          setIsBuffering(true);
          callbacksRef.current.onBufferingChange?.(true, 'Carregando...');
        }}
        onPlaying={() => {
          setIsBuffering(false);
          callbacksRef.current.onBufferingChange?.(false, '');
        }}
        onPause={() => {
          const video = videoRef.current;
          if (!video) return;
          const dur =
            video.duration && Number.isFinite(video.duration)
              ? Math.floor(video.duration)
              : 0;
          callbacksRef.current.onPause?.(Math.floor(video.currentTime), dur);
        }}
        onEnded={() => callbacksRef.current.onEnded?.()}
        className="h-full w-full object-contain"
      />

      {/* Manual playback recovery overlay when browser blocks autoplay */}
      {autoplayBlocked && !errorState && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
          <button
            type="button"
            onClick={() => void attemptManualPlay()}
            className="inline-flex items-center gap-2.5 rounded-xl bg-[#E50914] px-6 py-3.5 text-sm font-bold text-white shadow-2xl transition-transform hover:scale-105 hover:bg-[#c80812]"
          >
            <Play className="h-5 w-5 fill-current" />
            Iniciar reprodução manualmente
          </button>
        </div>
      )}

      {showOverlay && isBuffering && !errorState && !autoplayBlocked && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-white/10 bg-black/75 px-5 py-4 backdrop-blur-md">
            <Loader2 className="h-7 w-7 animate-spin text-[#E50914]" />
            <p className="text-xs font-medium text-white/85">
              {statusMessage || 'Carregando stream...'}
            </p>
          </div>
        </div>
      )}

      {showOverlay && errorState && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 px-4 text-center backdrop-blur-sm">
          <div className="max-w-md space-y-3 rounded-xl border border-white/15 bg-[#121417]/95 p-6 shadow-2xl">
            <AlertTriangle className="mx-auto h-8 w-8 text-amber-400" />
            <h3 className="font-display text-base font-bold text-white">
              Não foi possível reproduzir “{title}”
            </h3>
            <p className="text-xs leading-relaxed text-white/75">
              {errorState.reason}
            </p>
          </div>
        </div>
      )}

      {/* Temporary Real Diagnostics Panel */}
      {showDiagnostics && (
        <div
          data-testid="player-diagnostics-panel"
          className="absolute top-20 right-4 z-40 w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-white/15 bg-[#0B0C0E]/92 text-[11px] text-white/90 shadow-2xl backdrop-blur-md"
        >
          <button
            type="button"
            onClick={() => setDiagExpanded((e) => !e)}
            className="flex w-full items-center justify-between border-b border-white/10 px-3 py-2 font-semibold text-white"
          >
            <span className="inline-flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-[#E50914]" />
              Diagnóstico Real do Player
            </span>
            {diagExpanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-white/60" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-white/60" />
            )}
          </button>

          {diagExpanded && (
            <div className="max-h-[60vh] space-y-1.5 overflow-y-auto p-3 font-mono text-[10.5px] leading-relaxed">
              <div className="flex justify-between gap-2">
                <span className="text-white/50">Tipo da mídia:</span>
                <span className="font-semibold text-white">{diagnostics.mediaType}</span>
              </div>
              {diagnostics.codecSupportNote && (
                <div className="text-[10px] text-white/60">
                  Codec: {diagnostics.codecSupportNote}
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-white/50">Engine escolhida:</span>
                <span className="font-semibold text-emerald-400">
                  {diagnostics.engine}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-white/50">1º frame (TTFF):</span>
                <span className="font-semibold text-white tabular-nums">
                  {diagnostics.timeToFirstFrameMs !== null
                    ? `${diagnostics.timeToFirstFrameMs} ms`
                    : 'aguardando'}
                </span>
              </div>
              <div className="border-t border-white/10 pt-1">
                <p className="text-white/50">URL origem (credenciais ocultas):</p>
                <p className="break-all text-white/85">
                  {diagnostics.sourceUrlRedacted || '-'}
                </p>
                <p className="mt-1 text-white/50">URL final (credenciais ocultas):</p>
                <p className="break-all text-sky-300">
                  {diagnostics.finalUrlRedacted || '-'}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-1 border-t border-white/10 pt-1.5">
                <span className={diagnostics.loadedmetadata.fired ? 'text-emerald-400' : 'text-white/45'}>
                  loadedmetadata: {diagnostics.loadedmetadata.fired ? 'OK' : 'não'}
                </span>
                <span className={diagnostics.canplay.fired ? 'text-emerald-400' : 'text-white/45'}>
                  canplay: {diagnostics.canplay.fired ? 'OK' : 'não'}
                </span>
                <span className={diagnostics.playing.fired ? 'text-emerald-400' : 'text-white/45'}>
                  playing: {diagnostics.playing.fired ? 'OK' : 'não'}
                </span>
                <span className={diagnostics.stalled.count > 0 ? 'text-amber-400' : 'text-white/45'}>
                  stalled: {diagnostics.stalled.count}x
                </span>
                <span className={diagnostics.errorEvent.fired ? 'text-rose-400' : 'text-white/45'}>
                  error event: {diagnostics.errorEvent.fired ? 'SIM' : 'não'}
                </span>
                <span className="text-white/65">
                  resolução:{' '}
                  {diagnostics.loadedmetadata.width
                    ? `${diagnostics.loadedmetadata.width}x${diagnostics.loadedmetadata.height}`
                    : '-'}
                </span>
              </div>
              {diagnostics.mediaError && (
                <div className="rounded bg-rose-500/15 p-1.5 text-rose-300">
                  MediaError: code={diagnostics.mediaError.code} ({diagnostics.mediaError.label})
                  {diagnostics.mediaError.message ? ` — ${diagnostics.mediaError.message}` : ''}
                </div>
              )}
              {diagnostics.playRejection && (
                <div className="rounded bg-amber-500/15 p-1.5 text-amber-300">
                  video.play() rejeitado: {diagnostics.playRejection.name} —{' '}
                  {diagnostics.playRejection.message}
                </div>
              )}
              {lastHttp && (
                <div className="border-t border-white/10 pt-1 text-white/80">
                  Último HTTP: <span className="font-bold">{lastHttp.status}</span>{' '}
                  {lastHttp.contentType ? `(${lastHttp.contentType})` : ''}{' '}
                  {lastHttp.note ? `· ${lastHttp.note}` : ''}
                </div>
              )}
              {lastHlsErr && (
                <div className="rounded bg-rose-500/15 p-1.5 text-rose-300">
                  HLS.js: {lastHlsErr.type}/{lastHlsErr.details}{' '}
                  {lastHlsErr.httpCode ? `HTTP ${lastHlsErr.httpCode}` : ''}{' '}
                  {lastHlsErr.fatal ? '(FATAL)' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
