import { useEffect, useState } from 'react';
import Hls from 'hls.js';

export function HlsTrackControls({ hls }: { hls: Hls }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const update = () => refresh((count) => count + 1);
    const events = [
      Hls.Events.MANIFEST_PARSED, Hls.Events.LEVELS_UPDATED,
      Hls.Events.AUDIO_TRACKS_UPDATED, Hls.Events.AUDIO_TRACK_SWITCHED,
      Hls.Events.SUBTITLE_TRACKS_UPDATED, Hls.Events.SUBTITLE_TRACK_SWITCH,
    ] as const;
    for (const event of events) hls.on(event, update);
    update();
    return () => { for (const event of events) hls.off(event, update); };
  }, [hls]);

  if (hls.levels.length < 2 && hls.audioTracks.length < 2 && !hls.subtitleTracks.length) {
    return null;
  }
  const selectClass = 'w-full rounded border border-white/20 bg-[#121417] p-2 text-white focus-visible:outline-2 focus-visible:outline-white';
  return (
    <details className="relative text-xs text-white">
      <summary className="flex h-11 cursor-pointer list-none items-center rounded-lg border border-white/15 bg-black/60 px-2 focus-visible:outline-2 focus-visible:outline-white">
        Faixas
      </summary>
      <div className="absolute right-0 bottom-12 grid max-h-[55vh] w-48 gap-2 overflow-auto rounded-lg border border-white/15 bg-[#121417] p-3">
        {hls.levels.length > 1 && (
          <label>Qualidade
            <select className={selectClass} value={hls.manualLevel}
              onChange={(event) => { hls.nextLevel = Number(event.target.value); refresh((count) => count + 1); }}>
              <option value={-1}>Automática</option>
              {hls.levels.map((level, index) => (
                <option key={index} value={index}>
                  {level.height ? `${level.height}p · ` : ''}{Math.round(level.bitrate / 1000)} kbps
                </option>
              ))}
            </select>
          </label>
        )}
        {hls.audioTracks.length > 1 && (
          <label>Áudio
            <select className={selectClass} value={hls.audioTrack}
              onChange={(event) => { hls.audioTrack = Number(event.target.value); refresh((count) => count + 1); }}>
              {hls.audioTracks.map((track, index) => (
                <option key={index} value={index}>{track.name || track.lang || `Faixa ${index + 1}`}</option>
              ))}
            </select>
          </label>
        )}
        {hls.subtitleTracks.length > 0 && (
          <label>Legendas
            <select className={selectClass} value={hls.subtitleDisplay ? hls.subtitleTrack : -1}
              onChange={(event) => {
                const index = Number(event.target.value);
                hls.subtitleDisplay = index >= 0;
                hls.subtitleTrack = index;
                refresh((count) => count + 1);
              }}>
              <option value={-1}>Desligadas</option>
              {hls.subtitleTracks.map((track, index) => (
                <option key={index} value={index}>{track.name || track.lang || `Legenda ${index + 1}`}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    </details>
  );
}
