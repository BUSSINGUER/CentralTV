import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { redactUrlCredentials } from '../../services/streamOrigins';
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

export interface PlayerDiagnostics {
  mediaType: DetectedMediaType;
  codecSupportNote: string;
  engine: HybridEngineKind;
  sourceUrlRedacted: string;
  finalUrlRedacted: string;
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
  timeToFirstFrameMs: number | null;
}

export const MEDIA_ERROR_LABELS: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

export function createInitialDiagnostics(
  url: string,
  mediaType: DetectedMediaType,
  codecSupportNote = ''
): PlayerDiagnostics {
  return {
    mediaType,
    codecSupportNote,
    engine: 'none',
    sourceUrlRedacted: redactUrlCredentials(url),
    finalUrlRedacted: redactUrlCredentials(url),
    loadedmetadata: { fired: false },
    canplay: { fired: false },
    playing: { fired: false },
    stalled: { count: 0 },
    errorEvent: { fired: false },
    mediaError: null,
    playRejection: null,
    httpStatuses: [],
    hlsErrors: [],
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

  return (
    <div
      data-testid="player-diagnostics-panel"
      className="absolute top-20 right-5 z-40 w-96 overflow-hidden rounded-xl border border-white/15 bg-black/85 text-xs text-white shadow-2xl backdrop-blur-md"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between border-b border-white/10 px-3 py-2 font-semibold text-white bg-white/5 hover:bg-white/10"
      >
        <span>Diagnóstico Real do Player</span>
        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {isOpen && (
        <div className="max-h-80 space-y-2 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
          <div className="grid grid-cols-2 gap-1 border-b border-white/10 pb-2">
            <div>
              <span className="text-white/50">Tipo da mídia:</span>{' '}
              <span className="font-bold text-amber-300">{diagnostics.mediaType}</span>
            </div>
            <div>
              <span className="text-white/50">Engine:</span>{' '}
              <span className="font-bold text-emerald-300">{diagnostics.engine}</span>
            </div>
            <div className="col-span-2 text-white/70">{diagnostics.codecSupportNote}</div>
            <div>
              <span className="text-white/50">TTFF (1º frame):</span>{' '}
              {diagnostics.timeToFirstFrameMs ? `${diagnostics.timeToFirstFrameMs} ms` : 'aguardando'}
            </div>
            <div>
              <span className="text-white/50">Resolução:</span>{' '}
              {diagnostics.loadedmetadata.width && diagnostics.loadedmetadata.height
                ? `${diagnostics.loadedmetadata.width}x${diagnostics.loadedmetadata.height}`
                : '-'}
            </div>
          </div>

          <div className="space-y-1 border-b border-white/10 pb-2">
            <p className="text-white/50">URL origem (anonimizada):</p>
            <p className="break-all text-white/80">{diagnostics.sourceUrlRedacted}</p>
            <p className="text-white/50">URL final (anonimizada):</p>
            <p className="break-all text-white/80">{diagnostics.finalUrlRedacted}</p>
          </div>

          <div className="grid grid-cols-2 gap-1 border-b border-white/10 pb-2 text-[10px]">
            <div>loadedmetadata: {diagnostics.loadedmetadata.fired ? 'OK' : 'não'}</div>
            <div>canplay: {diagnostics.canplay.fired ? 'OK' : 'não'}</div>
            <div>playing: {diagnostics.playing.fired ? 'OK' : 'não'}</div>
            <div>stalled: {diagnostics.stalled.count}x</div>
            <div>error event: {diagnostics.errorEvent.fired ? 'SIM' : 'não'}</div>
            <div>
              MediaError:{' '}
              {diagnostics.mediaError
                ? `code=${diagnostics.mediaError.code} (${diagnostics.mediaError.label})`
                : 'nenhum'}
            </div>
          </div>

          {diagnostics.playRejection && (
            <div className="rounded bg-rose-500/20 p-1.5 text-rose-200">
              play() rejection: {diagnostics.playRejection.name} — {diagnostics.playRejection.message}
            </div>
          )}

          <div>
            <span className="text-white/50">Último HTTP:</span>{' '}
            {lastHttp ? `${lastHttp.status} (${lastHttp.contentType || 'binário'}) · ${lastHttp.note || 'OK'}` : 'nenhum'}
          </div>
        </div>
      )}
    </div>
  );
}
