import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { AlertTriangle, Loader2, Play } from 'lucide-react';
import { redactUrlCredentials } from '../services/streamOrigins';
import { SourceValidationState } from '../types/streaming';

import {
  DetectedMediaType,
  HybridEngineKind,
  detectMediaTypeFromUrl,
  evaluateNativeCodecSupport,
  classifyM3uContent,
  unwrapTargetUrl,
  getCleanPath,
  mapBackendFormatToMediaType,
  isLikelyDynamicVodUrl,
} from './player/MediaTypeDetector';
import {
  PlaybackAttempt,
  applyStreamProxyUrl,
  buildPlaybackAttempts,
  resolveVodSource,
} from './player/MediaSourceResolver';
import {
  PlayerDiagnostics,
  DiagnosticHttpEntry,
  DiagnosticHlsError,
  DiagnosticAttemptEntry,
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
  DiagnosticAttemptEntry,
};

export interface HybridPlayerError {
  reason: string;
  isMixedContentOrCors: boolean;
  httpStatus?: number;
  mediaErrorCode?: number;
  mediaErrorMessage?: string;
  validationState?: SourceValidationState;
}

export interface HybridPlayerValidationResult {
  validationState: SourceValidationState;
  resolvedUrl?: string;
  detectedFormat?: string;
  httpStatus?: number;
  reason?: string;
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
  onValidationResult?: (result: HybridPlayerValidationResult) => void;
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

interface ResolvedSessionState {
  sessionKey: string;
  resolvedUrl?: string;
  mediaType: DetectedMediaType;
  redirectCount: number;
  initialValidationState?: SourceValidationState;
  fatalPreflightError?: HybridPlayerError;
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
  enablePreflight = true,
  onVideoElement,
  onEngineChange,
  onDiagnosticsChange,
  onValidationResult,
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

  const sessionKey = useMemo(
    () =>
      `${url}|${isLive ? 1 : 0}|${forceProxy ? 1 : 0}|${
        autoProxyHttpStreams ? 1 : 0
      }|${streamProxyPrefix}`,
    [url, isLive, forceProxy, autoProxyHttpStreams, streamProxyPrefix]
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
  const [resolvedSession, setResolvedSession] =
    useState<ResolvedSessionState | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shakaRef = useRef<ShakaPlayerInstance | null>(null);
  const mpegtsRef = useRef<mpegts.Player | null>(null);
  const failTimeoutRef = useRef<number | null>(null);
  const playStartPerfRef = useRef<number>(performance.now());
  const firstFrameRecordedRef = useRef(false);
  const validationEmittedRef = useRef(false);
  const sessionGenRef = useRef(0);
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
    onValidationResult,
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
    onValidationResult,
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

  // Step 1: Resolve dynamic VOD / redirects BEFORE creating playback attempts
  useEffect(() => {
    sessionGenRef.current += 1;
    const myGen = sessionGenRef.current;

    destroyPlayers(true);
    setAttemptIndex(0);
    setErrorState(null);
    setAutoplayBlocked(false);
    setIsReady(false);
    setIsBuffering(Boolean(url));
    setDirectVideoSrc(undefined);
    firstFrameRecordedRef.current = false;
    validationEmittedRef.current = false;
    setDiagnostics(createInitialDiagnostics(url, initialMediaType));

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setResolvedSession({
        sessionKey,
        mediaType: initialMediaType,
        redirectCount: 0,
      });
      return;
    }

    const effectiveRaw = unwrapTargetUrl(trimmedUrl);
    const shouldResolveVod =
      /^https?:\/\//i.test(effectiveRaw) &&
      (enablePreflight ||
        isLikelyDynamicVodUrl(effectiveRaw) ||
        getCleanPath(effectiveRaw).endsWith('.m3u'));

    if (!shouldResolveVod || trimmedUrl.startsWith('/api/stream')) {
      setResolvedSession({
        sessionKey,
        mediaType: initialMediaType,
        redirectCount: 0,
      });
      return;
    }

    const controller = new AbortController();
    setStatusMessage('Resolvendo endereço e formato do stream...');
    callbacksRef.current.onBufferingChange?.(
      true,
      'Resolvendo endereço e formato do stream...'
    );

    const resolve = async () => {
      try {
        const res = await resolveVodSource(effectiveRaw, {
          timeoutMs: 5500,
          signal: controller.signal,
        });
        if (controller.signal.aborted || myGen !== sessionGenRef.current) return;

        const mappedFromRes = mapBackendFormatToMediaType(
          res.mediaType || res.detectedEngine,
          res.contentType,
          isLive
        );
        const resolvedType =
          mappedFromRes !== 'unknown'
            ? mappedFromRes
            : initialMediaType;

        patchDiagnostics((prev) => ({
          ...prev,
          mediaType: resolvedType,
          resolvedUrlRedacted:
            res.finalUrlRedacted || redactUrlCredentials(res.resolvedUrl || effectiveRaw),
          redirectCount: res.redirectCount || 0,
          validationResult: res.validationState || prev.validationResult,
          ...(res.status > 0 || res.reason
            ? {
                httpStatuses: [
                  ...prev.httpStatuses.slice(-7),
                  {
                    urlRedacted:
                      res.finalUrlRedacted || redactUrlCredentials(effectiveRaw),
                    status: res.status || res.validationState,
                    contentType: res.contentType,
                    note: res.reason,
                    timestampMs: Date.now(),
                  },
                ],
              }
            : {}),
        }));

        if (res.isM3uList || resolvedType === 'm3u_playlist') {
          setResolvedSession({
            sessionKey,
            resolvedUrl: res.resolvedUrl,
            mediaType: 'm3u_playlist',
            redirectCount: res.redirectCount,
            initialValidationState: 'offline',
            fatalPreflightError: {
              reason:
                res.reason ||
                'A URL aponta para uma lista M3U de canais e não para um vídeo/manifesto HLS.',
              isMixedContentOrCors: false,
              httpStatus: res.status || 422,
              validationState: 'offline',
            },
          });
          return;
        }

        const isSsrfBlocked =
          res.status === 403 && /ssrf|bloquead/i.test(res.reason || '');
        if (isSsrfBlocked) {
          setResolvedSession({
            sessionKey,
            resolvedUrl: effectiveRaw,
            mediaType: resolvedType,
            redirectCount: 0,
            initialValidationState: 'proxy_blocked',
            fatalPreflightError: {
              reason: res.reason || 'Acesso bloqueado por segurança (SSRF).',
              isMixedContentOrCors: false,
              httpStatus: 403,
              validationState: 'proxy_blocked',
            },
          });
          return;
        }

        // Preserve original url when resolvedUrl matches or is empty; otherwise pass resolvedUrl
        const nextResolvedUrl =
          res.resolvedUrl && res.resolvedUrl !== effectiveRaw
            ? res.resolvedUrl
            : undefined;

        setResolvedSession({
          sessionKey,
          resolvedUrl: nextResolvedUrl,
          mediaType: resolvedType,
          redirectCount: res.redirectCount || 0,
          initialValidationState: res.validationState,
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || myGen !== sessionGenRef.current) {
          return;
        }
        setResolvedSession({
          sessionKey,
          mediaType: initialMediaType,
          redirectCount: 0,
        });
      }
    };

    void resolve();

    return () => {
      controller.abort();
    };
  }, [
    url,
    sessionKey,
    initialMediaType,
    isLive,
    enablePreflight,
    destroyPlayers,
    patchDiagnostics,
  ]);

  const activeResolved =
    resolvedSession && resolvedSession.sessionKey === sessionKey
      ? resolvedSession
      : null;

  const activeMediaType = activeResolved?.mediaType ?? initialMediaType;

  const attempts = useMemo(
    () =>
      activeResolved
        ? buildPlaybackAttempts(
            url,
            activeMediaType,
            streamProxyPrefix,
            autoProxyHttpStreams,
            forceProxy,
            activeResolved.resolvedUrl
          )
        : [],
    [
      url,
      activeResolved,
      activeMediaType,
      streamProxyPrefix,
      autoProxyHttpStreams,
      forceProxy,
    ]
  );

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

  // Step 2: Execute active attempt using resolved metadata & engine selection
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeResolved) return;

    const myGen = sessionGenRef.current;
    destroyPlayers(false);
    setIsReady(false);
    setErrorState(null);
    setAutoplayBlocked(false);
    firstFrameRecordedRef.current = false;
    playStartPerfRef.current = performance.now();

    const emitValidationOnce = (result: HybridPlayerValidationResult) => {
      if (validationEmittedRef.current || myGen !== sessionGenRef.current) return;
      validationEmittedRef.current = true;
      patchDiagnostics((prev) => ({
        ...prev,
        validationResult: result.validationState,
        finalOutcome:
          result.validationState === 'playback_confirmed' ? 'playing' : 'failed',
      }));
      callbacksRef.current.onValidationResult?.(result);
    };

    if (activeResolved.fatalPreflightError) {
      const fatalErr = activeResolved.fatalPreflightError;
      setDirectVideoSrc(undefined);
      setIsBuffering(false);
      setErrorState(fatalErr);
      emitValidationOnce({
        validationState: fatalErr.validationState || 'offline',
        resolvedUrl: activeResolved.resolvedUrl,
        detectedFormat: activeMediaType,
        httpStatus: fatalErr.httpStatus,
        reason: fatalErr.reason,
      });
      callbacksRef.current.onBufferingChange?.(false, '');
      callbacksRef.current.onError?.(fatalErr);
      return;
    }

    if (!url || attempts.length === 0) {
      setDirectVideoSrc(undefined);
      const emptyErr: HybridPlayerError = {
        reason: 'Nenhuma URL de stream informada para reprodução.',
        isMixedContentOrCors: false,
        validationState: 'offline',
      };
      setIsBuffering(false);
      setErrorState(emptyErr);
      emitValidationOnce({
        validationState: 'offline',
        reason: emptyErr.reason,
      });
      callbacksRef.current.onBufferingChange?.(false, '');
      callbacksRef.current.onError?.(emptyErr);
      return;
    }

    const currentAttempt = attempts[attemptIndex] || attempts[attempts.length - 1];
    const targetUrl = currentAttempt.url;
    const isProxyTarget = currentAttempt.mode === 'proxy';
    const currentAttemptNumber = attemptIndex + 1;

    let cancelled = false;
    let readyFired = false;
    let seekApplied = false;
    let handledFailure = false;
    let currentEngine: HybridEngineKind = 'none';
    const abortController = new AbortController();

    const isStale = () => cancelled || myGen !== sessionGenRef.current;

    const codecCheck = evaluateNativeCodecSupport(video, activeMediaType);
    patchDiagnostics((prev) => ({
      ...prev,
      mediaType: activeMediaType,
      codecSupportNote: codecCheck.note,
      finalUrlRedacted: redactUrlCredentials(targetUrl),
      finalOutcome: 'loading',
      attemptsLog: [
        ...prev.attemptsLog.slice(-9),
        {
          attemptNumber: currentAttemptNumber,
          mode: currentAttempt.mode,
          label: currentAttempt.label,
          engine: 'none',
          urlRedacted: redactUrlCredentials(targetUrl),
          status: 'trying',
          timestampMs: Date.now(),
        },
      ],
    }));

    const updateCurrentAttemptLog = (
      patch: Partial<DiagnosticAttemptEntry>
    ) => {
      if (isStale()) return;
      patchDiagnostics((prev) => {
        const list = [...prev.attemptsLog];
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].attemptNumber === currentAttemptNumber) {
            list[i] = { ...list[i], ...patch };
            break;
          }
        }
        return { ...prev, attemptsLog: list };
      });
    };

    const updateBuffering = (buffering: boolean, msg = '') => {
      if (isStale()) return;
      setIsBuffering(buffering);
      setStatusMessage(msg);
      callbacksRef.current.onBufferingChange?.(buffering, msg);
    };

    const recordHttp = (entry: Omit<DiagnosticHttpEntry, 'timestampMs'>) => {
      if (isStale()) return;
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
      validationState?: SourceValidationState;
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
            const bodyText = !resp.ok
              ? (await resp.text().catch(() => '')).slice(0, 200)
              : '';

            recordHttp({
              urlRedacted: redactUrlCredentials(failedUrl),
              status: resp.status,
              contentType: upstreamCt || resp.headers.get('content-type') || '',
              note:
                errCode || (upstreamStatus ? `upstream=${upstreamStatus}` : undefined),
            });

            if (errCode === 'upstream_html') {
              return {
                reason: `O servidor de origem respondeu HTTP ${
                  upstreamStatus || resp.status
                } com página HTML (${
                  upstreamCt || 'text/html'
                }) em vez de vídeo (ex.: proteção anti-bot, link temporário expirado ou indisponível).`,
                isMixedContentOrCors: false,
                httpStatus: resp.status,
                validationState: 'html_challenge',
              };
            }
            if (errCode === 'm3u_playlist_not_hls') {
              return {
                reason:
                  'A URL aponta para uma lista M3U de canais e não para um stream de vídeo ou manifesto HLS.',
                isMixedContentOrCors: false,
                httpStatus: resp.status,
                validationState: 'offline',
              };
            }
            if (errCode === 'origin_not_allowed' || errCode === 'ssrf_blocked') {
              return {
                reason:
                  bodyText ||
                  `Proxy bloqueou a requisição (${errCode}, HTTP ${resp.status}).`,
                isMixedContentOrCors: false,
                httpStatus: resp.status,
                validationState: 'proxy_blocked',
              };
            }
            if (resp.status === 401 || resp.status === 403 || resp.status === 429) {
              return {
                reason:
                  bodyText ||
                  `Servidor de origem ou proxy recusou o acesso (HTTP ${
                    upstreamStatus || resp.status
                  }).`,
                isMixedContentOrCors: false,
                httpStatus: resp.status,
                validationState: 'proxy_blocked',
              };
            }
            if (resp.status >= 400) {
              return {
                reason:
                  bodyText ||
                  `Servidor de origem retornou HTTP ${upstreamStatus || resp.status}.`,
                isMixedContentOrCors: false,
                httpStatus: resp.status,
                validationState: resp.status >= 500 ? 'proxy_blocked' : 'offline',
              };
            }
          } else if (resp.ok) {
            const check = (await resp.json().catch(() => null)) as {
              ok?: boolean;
              status?: number;
              contentType?: string;
              reason?: string;
              validationState?: SourceValidationState;
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
                  validationState: check.validationState || 'offline',
                };
              }
              if (check.validationState === 'html_challenge') {
                return {
                  reason:
                    check.reason ||
                    `Servidor acessível, porém retornou proteção HTML (HTTP ${check.status}).`,
                  isMixedContentOrCors: false,
                  httpStatus: check.status,
                  validationState: 'html_challenge',
                };
              }
              if (
                check.validationState === 'media_available' ||
                check.validationState === 'server_reachable'
              ) {
                return {
                  reason:
                    'Servidor acessível, mas o navegador bloqueou a reprodução direta (CORS / codec incompatível).',
                  isMixedContentOrCors: true,
                  httpStatus: check.status,
                  validationState: 'cors_blocked',
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
          validationState: 'cors_blocked',
        };
      }

      return {
        reason: 'Não foi possível reproduzir este stream.',
        isMixedContentOrCors: false,
        validationState:
          activeResolved.initialValidationState === 'html_challenge'
            ? 'html_challenge'
            : isProxyTarget
              ? 'proxy_blocked'
              : 'offline',
      };
    };

    const failOrAdvanceAttempt = async (
      rawReason: string,
      opts?: {
        isMixedOrCors?: boolean;
        httpStatus?: number;
        skipAdvance?: boolean;
        mediaErr?: { code: number; label: string; message: string } | null;
        validationState?: SourceValidationState;
      }
    ) => {
      if (isStale() || handledFailure) return;
      handledFailure = true;
      if (failTimeoutRef.current) {
        window.clearTimeout(failTimeoutRef.current);
        failTimeoutRef.current = null;
      }

      const elapsedMs = Math.max(
        1,
        Math.round(performance.now() - playStartPerfRef.current)
      );

      const diagnosed =
        opts?.httpStatus || opts?.mediaErr?.code === 3 || opts?.validationState
          ? {
              reason: rawReason,
              isMixedContentOrCors: Boolean(opts?.isMixedOrCors),
              httpStatus: opts?.httpStatus,
              validationState: opts?.validationState,
            }
          : await diagnoseHttpResponseOnFailure(targetUrl);

      if (isStale()) return;

      const finalReason =
        diagnosed.reason !== 'Não foi possível reproduzir este stream.'
          ? diagnosed.reason
          : rawReason;

      updateCurrentAttemptLog({
        status: 'failed',
        engine: currentEngine,
        httpStatus: diagnosed.httpStatus,
        errorMessage: finalReason,
        durationMs: elapsedMs,
      });

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
          if (!isStale()) {
            destroyPlayers(true);
            setDirectVideoSrc(undefined);
            setAttemptIndex((idx) => idx + 1);
          }
        }, 0);
        return;
      }

      const resolvedValidationState: SourceValidationState =
        diagnosed.validationState ||
        (diagnosed.isMixedContentOrCors
          ? 'cors_blocked'
          : activeResolved.initialValidationState === 'html_challenge'
            ? 'html_challenge'
            : activeResolved.initialValidationState === 'media_available' ||
                activeResolved.initialValidationState === 'server_reachable'
              ? isProxyTarget
                ? 'proxy_blocked'
                : 'cors_blocked'
              : isProxyTarget && (diagnosed.httpStatus === 403 || !diagnosed.httpStatus)
                ? 'proxy_blocked'
                : 'offline');

      const finalError: HybridPlayerError = {
        reason: finalReason,
        isMixedContentOrCors:
          diagnosed.isMixedContentOrCors ||
          resolvedValidationState === 'cors_blocked',
        httpStatus: diagnosed.httpStatus,
        mediaErrorCode: opts?.mediaErr?.code,
        mediaErrorMessage: opts?.mediaErr?.message,
        validationState: resolvedValidationState,
      };

      updateBuffering(false, '');
      setErrorState(finalError);
      emitValidationOnce({
        validationState: resolvedValidationState,
        resolvedUrl: activeResolved.resolvedUrl,
        detectedFormat: activeMediaType,
        httpStatus: diagnosed.httpStatus,
        reason: finalReason,
      });

      window.setTimeout(() => {
        if (!isStale()) {
          destroyPlayers(true);
          setDirectVideoSrc(undefined);
          callbacksRef.current.onError?.(finalError);
        }
      }, 0);
    };

    const markFirstFrameIfNeeded = () => {
      if (isStale() || firstFrameRecordedRef.current) return;
      firstFrameRecordedRef.current = true;
      const elapsed = Math.max(
        1,
        Math.round(performance.now() - playStartPerfRef.current)
      );
      patchDiagnostics((prev) => ({
        ...prev,
        timeToFirstFrameMs: elapsed,
        finalOutcome: 'playing',
      }));
      updateCurrentAttemptLog({
        status: 'playing',
        engine: currentEngine,
        durationMs: elapsed,
      });
      emitValidationOnce({
        validationState: 'playback_confirmed',
        resolvedUrl: activeResolved.resolvedUrl,
        detectedFormat: activeMediaType,
        httpStatus: 200,
        reason: `Reprodução confirmada via ${currentEngine} (${elapsed} ms)`,
      });
    };

    const tryAutoPlayWithRecovery = () => {
      if (isStale() || !isPlayingRef.current) return;
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err: unknown) => {
          if (isStale()) return;
          const e = err as DOMException | Error;
          const name = e?.name || 'PlayError';
          const message = e?.message || 'Rejeição em video.play()';
          patchDiagnostics((prev) => ({
            ...prev,
            playRejection: { name, message, timestampMs: Date.now() },
          }));

          if (name === 'NotAllowedError') {
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
      if (isStale() || seekApplied || isLive) return;
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

    const markReady = () => {
      if (isStale()) return;
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

    const wireCommonVideoDiagnosticListeners = () => {
      video.onloadedmetadata = () => {
        if (isStale()) return;
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
        if (isStale()) return;
        applyInitialResumeSeek();
        markFirstFrameIfNeeded();
      };

      video.oncanplay = () => {
        if (isStale()) return;
        patchDiagnostics((prev) => ({
          ...prev,
          canplay: { fired: true, timestampMs: Date.now() },
        }));
        applyInitialResumeSeek();
        markReady();
      };

      video.onplaying = () => {
        if (isStale()) return;
        setAutoplayBlocked(false);
        markFirstFrameIfNeeded();
        patchDiagnostics((prev) => ({
          ...prev,
          playing: { fired: true, timestampMs: Date.now() },
        }));
      };

      video.onstalled = () => {
        if (isStale()) return;
        patchDiagnostics((prev) => ({
          ...prev,
          stalled: {
            count: prev.stalled.count + 1,
            lastTimestampMs: Date.now(),
          },
        }));
      };

      video.onresize = () => {
        if (isStale() || !video.videoWidth || !video.videoHeight) return;
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
      currentEngine = engine;
      updateCurrentAttemptLog({ engine });
      patchDiagnostics((prev) => ({ ...prev, engine }));
      callbacksRef.current.onEngineChange?.(engine);
    };

    const initShaka = async (dashUrl: string) => {
      if (isStale() || !videoRef.current) return;
      try {
        setDirectVideoSrc(undefined);
        setEngine('shaka');
        updateBuffering(true, `Carregando MPEG-DASH (${currentAttempt.label})...`);

        const shakaModule = await import('shaka-player');
        if (isStale() || !videoRef.current) return;

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
            | { code?: number; message?: string; severity?: number; data?: unknown[] }
            | undefined;
          const codeLabel = detail?.code ? `código ${detail.code}` : 'erro de rede';
          const isNetworkOrCors =
            detail?.code !== undefined &&
            detail.code >= 1000 &&
            detail.code < 2000;
          void failOrAdvanceAttempt(
            `Erro no Shaka Player (${codeLabel}${
              detail?.message ? `: ${detail.message}` : ''
            }).`,
            { isMixedOrCors: isNetworkOrCors && !isProxyTarget }
          );
        });

        await player.attach(videoRef.current);
        if (isStale()) {
          await player.destroy().catch(() => {});
          return;
        }

        wireCommonVideoDiagnosticListeners();
        await player.load(dashUrl);
        if (!isStale()) {
          markReady();
        }
      } catch (err) {
        if (!isStale()) {
          const msg =
            err instanceof Error
              ? err.message
              : 'Falha ao carregar manifesto no Shaka Player.';
          void failOrAdvanceAttempt(msg, { isMixedOrCors: !isProxyTarget });
        }
      }
    };

    const initHlsPlayback = async (hlsUrl: string) => {
      if (isStale() || !videoRef.current) return;
      setDirectVideoSrc(undefined);

      const nativeHlsSupport =
        video.canPlayType('application/vnd.apple.mpegurl') ||
        video.canPlayType('application/x-mpegURL');
      const isAppleSafari =
        typeof navigator !== 'undefined' &&
        /^((?!chrome|android).)*safari/i.test(navigator.userAgent || '');

      if (nativeHlsSupport && (!Hls.isSupported() || isAppleSafari)) {
        setEngine('native-hls');
        updateBuffering(true, `Carregando HLS nativo (${currentAttempt.label})...`);
        wireCommonVideoDiagnosticListeners();
        video.onerror = () => {
          if (isStale()) return;
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

      if (!Hls.isSupported()) {
        void initShaka(hlsUrl);
        return;
      }

      if (hlsUrl.startsWith('/api/stream')) {
        try {
          const headCheck = await fetch(hlsUrl, { signal: abortController.signal });
          if (isStale()) return;
          recordHttp({
            urlRedacted: redactUrlCredentials(hlsUrl),
            status: headCheck.status,
            contentType: headCheck.headers.get('content-type') || '',
          });
          if (!headCheck.ok) {
            const errCode = headCheck.headers.get('x-aura-error-code') || '';
            const upstreamStatus = Number(
              headCheck.headers.get('x-aura-upstream-status') || headCheck.status
            );
            const text = await headCheck.text().catch(() => '');
            void failOrAdvanceAttempt(
              text || `Manifesto HLS retornou HTTP ${upstreamStatus}`,
              {
                httpStatus: headCheck.status,
                validationState:
                  errCode === 'upstream_html'
                    ? 'html_challenge'
                    : errCode === 'origin_not_allowed' || errCode === 'ssrf_blocked'
                      ? 'proxy_blocked'
                      : errCode === 'm3u_playlist_not_hls'
                        ? 'offline'
                        : undefined,
                skipAdvance: errCode === 'm3u_playlist_not_hls',
              }
            );
            return;
          }
          const manifestText = await headCheck.text();
          if (classifyM3uContent(manifestText) === 'm3u_playlist') {
            void failOrAdvanceAttempt(
              'O link aponta para uma lista M3U de canais e não para um manifesto HLS (.m3u8).',
              { skipAdvance: true, httpStatus: 422, validationState: 'offline' }
            );
            return;
          }
        } catch (err) {
          if (isStale() || (err as Error)?.name === 'AbortError') return;
        }
      }

      if (isStale()) return;
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

      let mediaRecoveryCount = 0;
      let networkRecoveryCount = 0;

      hls.on(Hls.Events.MANIFEST_LOADED, (_ev, data) => {
        if (isStale()) return;
        const respCode =
          data.networkDetails instanceof XMLHttpRequest
            ? data.networkDetails.status
            : 200;
        recordHttp({
          urlRedacted: redactUrlCredentials(data.url || hlsUrl),
          status: respCode || 200,
          note: `HLS ${data.levels?.length || 0} qualidade(s)`,
        });
      });

      hls.on(Hls.Events.FRAG_LOADED, (_ev, data) => {
        if (isStale()) return;
        if (!firstFrameRecordedRef.current) {
          recordHttp({
            urlRedacted: redactUrlCredentials(data.frag?.url || ''),
            status: 200,
            note: `Seg #${data.frag?.sn ?? 0}`,
          });
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, markReady);

      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (isStale()) return;
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

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryCount < 2) {
          mediaRecoveryCount += 1;
          if (mediaRecoveryCount === 2) {
            hls.swapAudioCodec();
          }
          hls.recoverMediaError();
          return;
        }

        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          networkRecoveryCount < 1 &&
          (!httpCode || httpCode >= 500)
        ) {
          networkRecoveryCount += 1;
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
          validationState:
            isStatusZeroCorsCandidate && !isProxyTarget
              ? 'cors_blocked'
              : undefined,
        });
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
    };

    const initMpegTs = (tsUrl: string) => {
      if (isStale() || !videoRef.current) return;
      setDirectVideoSrc(undefined);
      if (!mpegts.isSupported()) {
        void initShaka(tsUrl);
        return;
      }

      try {
        setEngine('mpegts.js');
        updateBuffering(
          true,
          `Conectando transmissão MPEG-TS (${currentAttempt.label})...`
        );
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
          if (isStale()) return;
          const infoObj = errInfo as { code?: number; msg?: string } | undefined;
          const httpCode =
            infoObj?.code && infoObj.code >= 100 ? infoObj.code : undefined;
          if (httpCode) {
            recordHttp({
              urlRedacted: redactUrlCredentials(tsUrl),
              status: httpCode,
              note: String(errDetail || errType),
            });
          }
          window.setTimeout(() => {
            void failOrAdvanceAttempt(
              `Erro MPEG-TS (${String(
                errDetail || infoObj?.msg || 'Stream incompatível ou offline'
              )})`,
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
      if (isStale() || !videoRef.current) return;

      if (mediaType === 'avi' && !codecCheck.canAttemptNative) {
        setEngine('native-html5');
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
        if (isStale()) return;
        const code = video.error?.code || 0;
        const label =
          MEDIA_ERROR_LABELS[code] || (code ? `CODE_${code}` : 'UNKNOWN');
        const message = video.error?.message || '';
        const mediaErr = { code, label, message };

        patchDiagnostics((prev) => ({
          ...prev,
          errorEvent: { fired: true, timestampMs: Date.now() },
          mediaError: mediaErr,
        }));

        if (code === 3) {
          void failOrAdvanceAttempt(
            `Erro de decodificação de codec/contêiner (${label}${
              message ? `: ${message}` : ''
            }).`,
            { mediaErr, skipAdvance: true }
          );
          return;
        }

        const unsupportedHint =
          mediaType === 'mkv' || mediaType === 'mov' || mediaType === 'avi'
            ? `Contêiner ${mediaType.toUpperCase()} ou codec incompatível com o navegador (${label}).`
            : `Falha ao carregar vídeo nativo (${label}${
                message ? `: ${message}` : ''
              }).`;

        void failOrAdvanceAttempt(unsupportedHint, { mediaErr });
      };

      setDirectVideoSrc(mediaUrl);
    };

    const start = async () => {
      const activeType = activeMediaType;
      if (isStale()) return;
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
    activeResolved,
    attempts,
    attemptIndex,
    activeMediaType,
    isLive,
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

      {showDiagnostics && (
        <PlayerDiagnosticsPanel
          diagnostics={diagnostics}
          isOpen={diagExpanded}
          onToggle={() => setDiagExpanded((e) => !e)}
        />
      )}
    </div>
  );
}
