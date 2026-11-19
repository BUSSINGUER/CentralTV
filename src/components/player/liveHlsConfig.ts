import Hls, { type HlsConfig } from 'hls.js';
import type { LiveLatencyProfile } from '../../types/streaming';

export const LIVE_LATENCY_STORAGE_KEY = 'centraltv-live-hls-latency';
export const LIVE_FIRST_FRAME_TIMEOUT_MS = 12_000;
export const LIVE_FROZEN_TIMEOUT_MS = 25_000;
export const LIVE_WATCHDOG_INTERVAL_MS = 2_000;

export const LIVE_LATENCY_PROFILES: Array<{
  id: LiveLatencyProfile;
  label: string;
  shortDesc: string;
}> = [
  {
    id: 'realtime',
    label: 'Tempo Real',
    shortDesc: '~1–2 segmentos da borda (menor atraso)',
  },
  {
    id: 'balanced',
    label: 'Equilibrado',
    shortDesc: '~3 segmentos, recuperação até 1.03x (padrão)',
  },
  {
    id: 'stable',
    label: 'Estável',
    shortDesc: '~5–6 segmentos, buffer reforçado',
  },
];

export const PLAYLIST_FATAL_HLS_DETAILS = new Set<string>([
  Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
  Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
  Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
  Hls.ErrorDetails.LEVEL_LOAD_ERROR,
  Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT,
  Hls.ErrorDetails.LEVEL_EMPTY_ERROR,
]);

export function isFatalPlaylistHlsError(details: string): boolean {
  return PLAYLIST_FATAL_HLS_DETAILS.has(details);
}

export function getSavedLiveLatencyProfile(): LiveLatencyProfile {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem(LIVE_LATENCY_STORAGE_KEY);
      if (saved === 'realtime' || saved === 'balanced' || saved === 'stable') {
        return saved;
      }
    }
  } catch {
    // Ignore storage read restrictions
  }
  return 'balanced';
}

export function saveLiveLatencyProfile(profile: LiveLatencyProfile): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(LIVE_LATENCY_STORAGE_KEY, profile);
    }
  } catch {
    // Ignore storage write restrictions
  }
}

/**
 * Computes HLS.js live synchronization and buffer settings adapted to the
 * playlist's actual segment targetduration (without assuming absolute latency).
 */
export function buildLiveHlsConfig(
  profile: LiveLatencyProfile,
  segmentTargetDurationSec?: number,
  options?: { isProxyTarget?: boolean }
): Partial<HlsConfig> {
  const hasSegDur =
    typeof segmentTargetDurationSec === 'number' &&
    Number.isFinite(segmentTargetDurationSec) &&
    segmentTargetDurationSec > 0;

  // Clamp parsed targetduration reasonably (1s..15s) to adapt buffer sizes proportionally
  const segSec = hasSegDur
    ? Math.min(15, Math.max(1, segmentTargetDurationSec!))
    : 5;

  const baseLoading: Partial<HlsConfig> = {
    enableWorker: true,
    // Keep lowLatencyMode false for standard HLS playlists (avoids stall loops when no #EXT-X-PART)
    lowLatencyMode: false,
    startFragPrefetch: true,
    manifestLoadingTimeOut: options?.isProxyTarget ? 12_000 : 8_000,
    manifestLoadingMaxRetry: 1,
    levelLoadingTimeOut: options?.isProxyTarget ? 12_000 : 9_000,
    levelLoadingMaxRetry: 2,
    fragLoadingTimeOut: 15_000,
    fragLoadingMaxRetry: 3,
  };

  if (profile === 'realtime') {
    const maxBuf = Math.min(20, Math.max(6, Math.round(segSec * 2.5)));
    const maxMaxBuf = Math.min(32, Math.max(12, Math.round(segSec * 4)));
    return {
      ...baseLoading,
      liveSyncDurationCount: 1.5,
      liveMaxLatencyDurationCount: 3.5,
      maxLiveSyncPlaybackRate: 1.04,
      liveSyncOnStallIncrease: 1.5,
      maxBufferLength: maxBuf,
      maxMaxBufferLength: maxMaxBuf,
      backBufferLength: Math.min(20, Math.max(8, Math.round(segSec * 2))),
    };
  }

  if (profile === 'stable') {
    const maxBuf = Math.min(72, Math.max(24, Math.round(segSec * 6)));
    const maxMaxBuf = Math.min(120, Math.max(40, Math.round(segSec * 9)));
    return {
      ...baseLoading,
      liveSyncDurationCount: 5.5,
      liveMaxLatencyDurationCount: 10.0,
      maxLiveSyncPlaybackRate: 1.01,
      liveSyncOnStallIncrease: 2.0,
      maxBufferLength: maxBuf,
      maxMaxBufferLength: maxMaxBuf,
      backBufferLength: Math.min(90, Math.max(30, Math.round(segSec * 6))),
    };
  }

  // 'balanced' (default)
  const maxBuf = Math.min(36, Math.max(12, Math.round(segSec * 4)));
  const maxMaxBuf = Math.min(60, Math.max(20, Math.round(segSec * 6)));
  return {
    ...baseLoading,
    liveSyncDurationCount: 3.0,
    liveMaxLatencyDurationCount: 5.5,
    maxLiveSyncPlaybackRate: 1.03,
    liveSyncOnStallIncrease: 1.5,
    maxBufferLength: maxBuf,
    maxMaxBufferLength: maxMaxBuf,
    backBufferLength: Math.min(45, Math.max(15, Math.round(segSec * 4))),
  };
}

/**
 * Applies live latency profile changes directly to an active Hls instance
 * without tearing down playback. Returns `true` only if a full engine
 * reinitialization is strictly required.
 */
export function applyLiveLatencyProfileToHls(
  hls: Pick<Hls, 'config'>,
  profile: LiveLatencyProfile,
  segmentTargetDurationSec?: number
): boolean {
  const next = buildLiveHlsConfig(profile, segmentTargetDurationSec);
  const currentLowLatency = Boolean(hls.config.lowLatencyMode);
  const nextLowLatency = Boolean(next.lowLatencyMode);

  if (currentLowLatency !== nextLowLatency) {
    return true;
  }

  hls.config.liveSyncDurationCount = next.liveSyncDurationCount!;
  hls.config.liveMaxLatencyDurationCount = next.liveMaxLatencyDurationCount!;
  hls.config.maxLiveSyncPlaybackRate = next.maxLiveSyncPlaybackRate!;
  hls.config.liveSyncOnStallIncrease = next.liveSyncOnStallIncrease!;
  hls.config.maxBufferLength = next.maxBufferLength!;
  hls.config.maxMaxBufferLength = next.maxMaxBufferLength!;
  hls.config.backBufferLength = next.backBufferLength!;
  hls.config.startFragPrefetch = Boolean(next.startFragPrefetch);
  return false;
}
