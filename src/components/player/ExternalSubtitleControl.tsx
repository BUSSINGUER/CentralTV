import { useEffect, useState } from 'react';
import { Captions, X } from 'lucide-react';

export function ExternalSubtitleControl({ video }: { video: HTMLVideoElement }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) return;
    const track = document.createElement('track');
    const url = URL.createObjectURL(new Blob([file], { type: 'text/vtt' }));
    track.kind = 'subtitles';
    track.label = 'Legenda externa';
    track.src = url;
    const onError = () => setError('Não foi possível ler a legenda WebVTT.');
    track.addEventListener('error', onError);
    video.append(track);
    track.track.mode = 'showing';
    return () => {
      track.removeEventListener('error', onError);
      track.track.mode = 'disabled';
      track.remove();
      URL.revokeObjectURL(url);
    };
  }, [file, video]);

  return (
    <div className="relative flex items-center">
      <label className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-white/15 bg-black/60 focus-within:outline-2 focus-within:outline-white">
        <Captions aria-hidden="true" className="h-5 w-5" />
        <input className="sr-only" type="file" accept=".vtt,text/vtt" aria-label="Adicionar legenda externa WebVTT"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            if (!selected) return;
            if (!/\.vtt$/i.test(selected.name) || selected.size > 2 * 1024 * 1024) {
              setError('Selecione um arquivo .vtt de até 2 MB.');
              return;
            }
            setError('');
            setFile(selected);
          }} />
      </label>
      {file && (
        <button className="flex h-11 w-11 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-white"
          type="button" aria-label="Remover legenda externa" onClick={() => { setFile(null); setError(''); }}>
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      )}
      {error && <p role="alert" className="absolute right-0 bottom-12 w-44 rounded bg-[#121417] p-2 text-xs text-white">{error}</p>}
    </div>
  );
}
