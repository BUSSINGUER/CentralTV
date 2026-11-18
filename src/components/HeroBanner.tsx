import { useEffect, useRef, useState } from 'react';
import { Info, Play, Volume2, VolumeX } from 'lucide-react';
import { PLATFORM_LABELS } from '../data/catalog';
import { fetchAndCacheTrailerOnDemand } from '../services/pipeline';
import { CatalogItem } from '../types/streaming';
import { MediaImage } from './MediaImage';

interface HeroBannerProps {
  items: CatalogItem[];
  activeIndex: number;
  onSelectIndex: (index: number) => void;
  isMuted: boolean;
  onToggleMute: () => void;
  youtubeApiKey?: string;
  onPlay: (item: CatalogItem) => void;
  onMoreInfo: (item: CatalogItem) => void;
  onTrailerResolved?: (itemId: string, trailerId: string) => void;
}

export function HeroBanner({
  items,
  activeIndex,
  onSelectIndex,
  isMuted,
  onToggleMute,
  youtubeApiKey = '',
  onPlay,
  onMoreInfo,
  onTrailerResolved,
}: HeroBannerProps) {
  const current = items[activeIndex] ?? items[0];
  const [trailerReady, setTrailerReady] = useState(false);
  const [resolvedTrailerId, setResolvedTrailerId] = useState(
    current?.youtubeTrailerId || ''
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const initialId = current?.youtubeTrailerId || '';
    setResolvedTrailerId(initialId);
    setTrailerReady(false);

    if (current && !initialId && current.type !== 'live' && current.type !== 'radio') {
      let cancelled = false;
      void fetchAndCacheTrailerOnDemand(current, youtubeApiKey).then(
        (foundId) => {
          if (!cancelled && foundId) {
            setResolvedTrailerId(foundId);
            onTrailerResolved?.(current.id, foundId);
          }
        }
      );
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setTimeout(() => {
      setTrailerReady(true);
    }, 1100);
    return () => window.clearTimeout(timer);
  }, [current?.id, current?.youtubeTrailerId, youtubeApiKey, onTrailerResolved]);

  useEffect(() => {
    if (!resolvedTrailerId) return;
    setTrailerReady(false);
    const timer = window.setTimeout(() => {
      setTrailerReady(true);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [resolvedTrailerId]);

  useEffect(() => {
    if (!iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      JSON.stringify({
        event: 'command',
        func: isMuted ? 'mute' : 'unMute',
        args: [],
      }),
      '*'
    );
  }, [isMuted]);

  useEffect(() => {
    if (items.length <= 1) return;
    const interval = window.setInterval(() => {
      onSelectIndex((activeIndex + 1) % items.length);
    }, 16000);
    return () => window.clearInterval(interval);
  }, [activeIndex, items.length, onSelectIndex]);

  if (!current) return null;

  const hasTrailer = Boolean(resolvedTrailerId);
  const embedUrl = hasTrailer
    ? `https://www.youtube.com/embed/${resolvedTrailerId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${resolvedTrailerId}&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&enablejsapi=1`
    : '';

  return (
    <section
      aria-label="Destaque principal"
      className="relative h-[75vh] min-h-[540px] max-h-[820px] w-full overflow-hidden bg-[#0B0C0E]"
    >
      {/* Layer 1: High-resolution Backdrop Fallback */}
      <MediaImage
        key={`backdrop-${current.id}`}
        src={current.backdropImage || current.posterImage}
        alt={current.title}
        className="absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-500"
      />

      {/* Layer 2: Auto-playing YouTube Trailer (muted by default, responsive cover) */}
      {hasTrailer && (
        <div
          className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700 ${
            trailerReady ? 'opacity-70' : 'opacity-0'
          }`}
        >
          <iframe
            ref={iframeRef}
            key={`yt-${current.id}`}
            src={embedUrl}
            title={`Trailer de ${current.title}`}
            allow="autoplay; encrypted-media; picture-in-picture"
            className="absolute top-1/2 left-1/2 h-[56.25vw] min-h-[120%] w-[177.78vh] min-w-[120%] -translate-x-1/2 -translate-y-1/2 border-0"
          />
        </div>
      )}

      {/* Measured Contrast Scrims */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0B0C0E] via-[#0B0C0E]/45 to-[#0B0C0E]/30" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#0B0C0E]/92 via-[#0B0C0E]/50 to-transparent" />

      {/* Foreground Content */}
      <div className="relative z-10 mx-auto flex h-full max-w-[1440px] flex-col justify-end px-4 pb-12 sm:px-8 sm:pb-14 lg:px-12">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          {/* Left Typography & CTAs */}
          <div className="max-w-2xl space-y-4">
            {current.stylizedSubtitle && (
              <p className="text-xs font-semibold tracking-[0.18em] text-[#E50914] uppercase">
                {current.stylizedSubtitle}
              </p>
            )}

            <h1 className="font-display text-4xl font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl [text-wrap:balance]">
              {current.title}
            </h1>

            {/* Clean Unboxed Metadata */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm font-medium text-white/80 tabular-nums">
              <span>{current.year}</span>
              <span aria-hidden="true" className="text-white/40">
                ·
              </span>
              <span>{current.genres.slice(0, 2).join(' / ')}</span>
              <span aria-hidden="true" className="text-white/40">
                ·
              </span>
              <span className="inline-flex items-center justify-center rounded-[4px] border border-white/25 bg-white/10 px-1.5 py-0.5 text-xs font-bold text-white">
                {current.ageRating}
              </span>
              <span aria-hidden="true" className="text-white/40">
                ·
              </span>
              <span className="text-white">
                {PLATFORM_LABELS[current.platform]}
              </span>
              {current.qualityBadge && (
                <>
                  <span aria-hidden="true" className="text-white/40">
                    ·
                  </span>
                  <span className="rounded-[4px] border border-white/20 px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-white/90">
                    {current.qualityBadge}
                  </span>
                </>
              )}
            </div>

            <p className="line-clamp-2 max-w-xl text-sm leading-relaxed text-white/75 sm:text-base">
              {current.synopsis}
            </p>

            {/* Primary & Secondary Action Buttons */}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => onPlay(current)}
                className="inline-flex h-11 items-center gap-2.5 rounded-lg bg-white px-6 text-sm font-bold text-[#0B0C0E] shadow-lg transition-transform duration-150 hover:scale-[1.02] hover:bg-white/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white whitespace-nowrap shrink-0"
              >
                <Play className="h-4 w-4 fill-current" />
                Assistir
              </button>

              <button
                type="button"
                onClick={() => onMoreInfo(current)}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/15 bg-white/12 px-5 text-sm font-semibold text-white backdrop-blur-md transition-colors duration-150 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 whitespace-nowrap shrink-0"
              >
                <Info className="h-4 w-4" />
                Mais informações
              </button>

              <button
                type="button"
                onClick={onToggleMute}
                aria-label={isMuted ? 'Ativar som do trailer' : 'Silenciar trailer'}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-white/15 bg-[#121417]/65 text-white/85 backdrop-blur-md transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                {isMuted ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4 text-[#E50914]" />
                )}
              </button>
            </div>
          </div>

          {/* Bottom-Right Pagination Dots (5 Highlights) */}
          <div className="flex items-center gap-2 self-end md:pb-1">
            {items.map((slide, idx) => {
              const active = idx === activeIndex;
              return (
                <button
                  key={slide.id}
                  type="button"
                  onClick={() => onSelectIndex(idx)}
                  aria-label={`Destaque ${idx + 1}: ${slide.title}`}
                  aria-current={active ? 'true' : undefined}
                  className={`h-2.5 rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                    active
                      ? 'w-7 bg-white'
                      : 'w-2.5 bg-white/35 hover:bg-white/65'
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
