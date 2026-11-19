import { ChevronDown, ChevronUp } from 'lucide-react';
import { redactUrlCredentials } from '../../services/streamOrigins';
import { SourceValidationState } from '../../types/streaming';
import { DetectedMediaType, HybridEngineKind } from './MediaTypeDetector';

export interface DiagnosticHttpEntry {
  urlRedacted: string;
  status: number | string;
  contentType?: string;
  note?: string;
  timestampMs: number;
}

export interface DiagnosticHlsError {
  type: string;
  details: string;
  fatal: boolean;
  httpCode?: number;
  urlRedacted?: string;
  timestampMs: number;
}

export interface DiagnosticAttemptEntry {
  attemptNumber: number;
  mode: 'original' | 'proxy' | 'resolved';
  label: string;
  engine: HybridEngineKind;
  urlRedacted: string;
  status: 'trying' | 'playing' | 'failed';
  httpStatus?: number;
  errorMessage?: string;
  durationMs?: number;
  timestampMs: number;
}

export interface PlayerDiagnostics {
  mediaType: DetectedMediaType;
  codecSupportNote: string;
  engine: HybridEngineKind;
  sourceUrlRedacted: string;
  resolvedUrlRedacted: string;
  finalUrlRedacted: string;
  redirectCount: number;
  validationResult?: SourceValidationState;
  finalOutcome: 'loading' | 'playing' | 'failed';
  loadedmetadata: {
    fired: boolean;
    timestampMs?: number;
    width?: number;
    height?: number;
    duration?: number;
  };
  canplay: { fired: boolean; timestampMs?: number };
  playing: { fired: boolean; timestampMs?: number };
  stalled: { count: number; lastTimestampMs?: number };
  errorEvent: { fired: boolean; timestampMs?: number };
  mediaError: { code: number; label: string; message: string } | null;
  playRejection: { name: string; message: string; timestampMs: number } | null;
  httpStatuses: DiagnosticHttpEntry[];
  hlsErrors: DiagnosticHlsError[];
  attemptsLog: DiagnosticAttemptEntry[];
  timeToFirstFrameMs: number | null;
}

export const MEDIA_ERROR_LABELS: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

const VALIDATION_STATE_LABELS: Record<SourceValidationState, string> = {
  unverified: 'Não verificado',
  server_reachable: 'Servidor acessível',
  media_available: 'Mídia disponível',
  playback_confirmed: 'Reprodução confirmada',
  cors_blocked: 'Bloqueio CORS / Mixed Content',
  proxy_blocked: 'Proxy / Origem bloqueada',
  html_challenge: 'Proteção HTML upstream',
  offline: 'Offline / Indisponível',
};

export function createInitialDiagnostics(
  url: string,
  mediaType: DetectedMediaType,
  codecSupportNote = ''
): PlayerDiagnostics {
  const redacted = redactUrlCredentials(url);
  return {
    mediaType,
    codecSupportNote,
    engine: 'none',
    sourceUrlRedacted: redacted,
    resolvedUrlRedacted: redacted,
    finalUrlRedacted: redacted,
    redirectCount: 0,
    validationResult: 'unverified',
    finalOutcome: 'loading',
    loadedmetadata: { fired: false },
    canplay: { fired: false },
    playing: { fired: false },
    stalled: { count: 0 },
    errorEvent: { fired: false },
    mediaError: null,
    playRejection: null,
    httpStatuses: [],
    hlsErrors: [],
    attemptsLog: [],
    timeToFirstFrameMs: null,
  };
}

interface DiagnosticsPanelProps {
  diagnostics: PlayerDiagnostics;
  isOpen: boolean;
  onToggle: () => void;
}

export function PlayerDiagnosticsPanel({
  diagnostics,
  isOpen,
  onToggle,
}: DiagnosticsPanelProps) {
  const lastHttp = diagnostics.httpStatuses[diagnostics.httpStatuses.length - 1];
  const lastHlsErr = diagnostics.hlsErrors[diagnostics.hlsErrors.length - 1];
  const validationLabel = diagnostics.validationResult
    ? VALIDATION_STATE_LABELS[diagnostics.validationResult]
    : 'Não verificado';

  return (
    <div
      data-testid="player-diagnostics-panel"
      className="absolute top-20 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-white/15 bg-[#0B0C0E]/92 text-xs text-white shadow-2xl backdrop-blur-md"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between border-b border-white/10 bg-white/5 px-3 py-2 font-semibold text-white hover:bg-white/10"
      >
        <span>Diagnóstico Real do Player</span>
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-white/70" />
        ) : (
          <ChevronDown className="h-4 w-4 text-white/70" />
        )}
      </button>

      {isOpen && (
        <div className="max-h-[65vh] space-y-2 overflow-y-auto p-3 font-mono text-[10.5px] leading-relaxed">
          <div className="grid grid-cols-2 gap-1.5 border-b border-white/10 pb-2">
            <div>
              <span className="text-white/50">Tipo da mídia:</span>{' '}
              <span className="font-bold text-amber-300">{diagnostics.mediaType}</span>
            </div>
            <div>
              <span className="text-white/50">Engine:</span>{' '}
              <span className="font-bold text-emerald-300">{diagnostics.engine}</span>
            </div>
            <div>
              <span className="text-white/50">Resultado:</span>{' '}
              <span
                className={`font-bold ${
                  diagnostics.finalOutcome === 'playing'
                    ? 'text-emerald-400'
                    : diagnostics.finalOutcome === 'failed'
                      ? 'text-rose-400'
                      : 'text-sky-300'
                }`}
              >
                {diagnostics.finalOutcome}
              </span>
            </div>
            <div>
              <span className="text-white/50">TTFF:</span>{' '}
              <span className="tabular-nums">
                {diagnostics.timeToFirstFrameMs !== null
                  ? `${diagnostics.timeToFirstFrameMs} ms`
                  : 'aguardando'}
              </span>
            </div>
            <div className="col-span-2 text-white/75">
              <span className="text-white/50">Validação:</span> {validationLabel}
              {diagnostics.redirectCount > 0
                ? ` · ${diagnostics.redirectCount} redirect(s)`
                : ''}
            </div>
            {diagnostics.codecSupportNote && (
              <div className="col-span-2 text-[10px] text-white/60">
                Codec: {diagnostics.codecSupportNote}
              </div>
            )}
          </div>

          <div className="space-y-1 border-b border-white/10 pb-2">
            <p className="text-white/50">URL origem (credenciais ocultas):</p>
            <p className="break-all text-white/80">
              {diagnostics.sourceUrlRedacted || '-'}
            </p>
            {diagnostics.resolvedUrlRedacted &&
              diagnostics.resolvedUrlRedacted !== diagnostics.sourceUrlRedacted && (
                <>
                  <p className="mt-1 text-white/50">URL resolvida (redirects):</p>
                  <p className="break-all text-amber-200/90">
                    {diagnostics.resolvedUrlRedacted}
                  </p>
                </>
              )}
            <p className="mt-1 text-white/50">URL tentativa atual:</p>
            <p className="break-all text-sky-300">
              {diagnostics.finalUrlRedacted || '-'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1 border-b border-white/10 pb-2 text-[10px]">
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
              {diagnostics.loadedmetadata.width && diagnostics.loadedmetadata.height
                ? `${diagnostics.loadedmetadata.width}x${diagnostics.loadedmetadata.height}`
                : '-'}
            </span>
          </div>

          {diagnostics.attemptsLog.length > 0 && (
            <div className="space-y-1 border-b border-white/10 pb-2">
              <p className="text-white/50">
                Tentativas ({diagnostics.attemptsLog.length}):
              </p>
              <div className="space-y-1">
                {diagnostics.attemptsLog.slice(-5).map((att) => (
                  <div
                    key={`${att.attemptNumber}-${att.timestampMs}`}
                    className="rounded bg-white/5 px-2 py-1 text-[10px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-white/90">
                        #{att.attemptNumber} [{att.mode}] {att.engine}
                      </span>
                      <span
                        className={
                          att.status === 'playing'
                            ? 'text-emerald-400'
                            : att.status === 'failed'
                              ? 'text-rose-400'
                              : 'text-amber-300'
                        }
                      >
                        {att.status}
                        {att.httpStatus ? ` (${att.httpStatus})` : ''}
                        {att.durationMs ? ` · ${att.durationMs}ms` : ''}
                      </span>
                    </div>
                    {att.errorMessage && (
                      <p className="mt-0.5 text-rose-200/85 line-clamp-2">
                        {att.errorMessage}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

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
            <div className="text-white/80">
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
  );
}
