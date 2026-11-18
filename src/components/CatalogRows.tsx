import { useRef, ReactNode } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Play,
  Plus,
  SearchX,
  X,
} from 'lucide-react';
import { PLATFORM_LABELS, PLATFORMS } from '../data/catalog';
import {
  CatalogItem,
  ContinueWatchingEntry,
  PlatformId,
  PlaybackStartOptions,
} from '../types/streaming';
import { parseEpisodeTagFromLabel } from '../services/watchHistory';
import { MediaImage } from './MediaImage';

interface CarouselRowProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function CarouselRow({ title, subtitle, children }: CarouselRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollByAmount = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = Math.max(el.clientWidth * 0.78, 320);
    el.scrollBy({
      left: direction === 'left' ? -distance : distance,
      behavior: 'smooth',
    });
  };

  return (
    <section className="group/row relative space-y-3.5">
      <div className="mx-auto flex max-w-[1440px] items-baseline justify-between gap-4 px-4 sm:px-8 lg:px-12">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-lg font-bold tracking-tight text-white sm:text-xl">
            {title}
          </h2>
          {subtitle && (
            <span className="hidden text-xs font-medium text-white/50 sm:inline">
              {subtitle}
            </span>
          )}
        </div>
      </div>

      <div className="relative mx-auto max-w-[1440px]">
        <button
          type="button"
          onClick={() => scrollByAmount('left')}
          aria-label={`Rolar ${title} para a esquerda`}
          className="absolute top-1/2 left-2 z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#0B0C0E]/85 text-white opacity-0 backdrop-blur-md transition-opacity duration-200 hover:bg-[#181B20] group-hover/row:opacity-100 md:flex focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <div
          ref={scrollRef}
          className="no-scrollbar flex gap-4 overflow-x-auto scroll-smooth px-4 py-1 sm:px-8 lg:px-12"
        >
          {children}
        </div>

        <button
          type="button"
          onClick={() => scrollByAmount('right')}
          aria-label={`Rolar ${title} para a direita`}
          className="absolute top-1/2 right-2 z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#0B0C0E]/85 text-white opacity-0 backdrop-blur-md transition-opacity duration-200 hover:bg-[#181B20] group-hover/row:opacity-100 md:flex focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </section>
  );
}

/* 1. Top 10 Hoje */
interface Top10RowProps {
  items: CatalogItem[];
  onSelectItem: (item: CatalogItem) => void;
}

export function Top10Row({ items, onSelectItem }: Top10RowProps) {
  return (
    <CarouselRow title="Top 10 Hoje" subtitle="Mais assistidos na plataforma">
      {items.map((item, index) => {
        const rank = item.top10Rank ?? index + 1;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectItem(item)}
            className="group relative flex shrink-0 items-end pl-9 sm:pl-12 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-lg"
          >
            <span
              aria-hidden="true"
              className="top10-rank-number pointer-events-none absolute bottom-[-8px] left-0 z-10 text-[112px] sm:text-[138px] tabular-nums transition-all duration-200"
            >
              {rank}
            </span>

            <div className="relative aspect-[2/3] w-[144px] sm:w-[168px] overflow-hidden rounded-[8px] border border-white/10 bg-[#121417] shadow-xl">
              <MediaImage
                src={item.posterImage}
                alt={item.title}
                className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
              {item.qualityBadge && (
                <span className="absolute top-2.5 right-2.5 rounded-[4px] border border-white/20 bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-white/95 backdrop-blur-sm">
                  {item.qualityBadge}
                </span>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                <p className="line-clamp-1 text-xs font-semibold text-white">
                  {item.title}
                </p>
                <p className="text-[11px] text-white/65 tabular-nums">
                  {PLATFORM_LABELS[item.platform]} · {item.year}
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </CarouselRow>
  );
}

/* 2. Continuar Assistindo */
interface ContinueWatchingRowProps {
  entries: ContinueWatchingEntry[];
  catalog: CatalogItem[];
  onPlay: (item: CatalogItem, options?: PlaybackStartOptions) => void;
  onMoreInfo: (item: CatalogItem) => void;
  onRemove: (itemId: string) => void;
}

export function ContinueWatchingRow({
  entries,
  catalog,
  onPlay,
  onMoreInfo,
  onRemove,
}: ContinueWatchingRowProps) {
  const mapped = entries
    .filter((entry) => entry.progressPercent > 0 && entry.progressPercent <= 92)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((entry) => ({
      entry,
      item: catalog.find((c) => c.id === entry.itemId),
    }))
    .filter((pair): pair is { entry: ContinueWatchingEntry; item: CatalogItem } =>
      Boolean(pair.item)
    );

  if (mapped.length === 0) return null;

  return (
    <CarouselRow title="Continuar Assistindo">
      {mapped.map(({ entry, item }) => {
        const parsed = parseEpisodeTagFromLabel(entry.episodeLabel);
        const seasonNum = entry.season ?? parsed.season;
        const episodeNum = entry.episodeNumber ?? parsed.episodeNumber;
        const seriesTag =
          item.type === 'series' && seasonNum && episodeNum
            ? `T${seasonNum}:E${episodeNum}`
            : null;
        const subtitleText =
          item.type === 'series'
            ? seriesTag
              ? parsed.title
                ? `${seriesTag} · ${parsed.title}`
                : seriesTag
              : entry.episodeLabel
            : entry.remainingText || entry.episodeLabel;

        return (
          <div
            key={item.id}
            className="group relative w-[256px] sm:w-[292px] shrink-0 overflow-hidden rounded-[8px] border border-white/10 bg-[#121417] transition-transform duration-200 hover:border-white/25"
          >
            <div className="relative aspect-video w-full overflow-hidden">
              <MediaImage
                src={item.backdropImage || item.posterImage}
                alt={item.title}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0B0C0E] via-black/25 to-transparent" />

              <button
                type="button"
                onClick={() =>
                  onPlay(item, {
                    season: seasonNum,
                    episodeNumber: episodeNum,
                    episodeId: entry.episodeId,
                    episodeLabel: entry.episodeLabel,
                    streamUrl: entry.selectedSourceUrl,
                    preferredSourceId: entry.selectedSourceId,
                    preferredSourceLabel: entry.selectedSourceLabel,
                    preferredSourceUrl: entry.selectedSourceUrl,
                  })
                }
                aria-label={`Continuar ${item.title}`}
                className="absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white backdrop-blur-md transition-transform duration-200 group-hover:scale-110 group-hover:bg-[#E50914] group-hover:border-[#E50914]">
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMoreInfo(item);
                }}
                aria-label={`Detalhes de ${item.title}`}
                className="absolute top-2.5 right-11 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/65 text-white/80 opacity-0 backdrop-blur-md transition-opacity duration-150 hover:bg-white/20 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Info className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item.id);
                }}
                aria-label={`Remover ${item.title} de Continuar Assistindo`}
                title="Remover da lista"
                className="absolute top-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/65 text-white/75 opacity-80 backdrop-blur-md transition-all duration-150 hover:border-white/40 hover:bg-black/90 hover:text-white sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>

              {seriesTag && (
                <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-[4px] border border-white/15 bg-black/75 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white tabular-nums backdrop-blur-sm">
                  {seriesTag}
                </span>
              )}

              {/* Progress bar at the base */}
              <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                <div
                  className="h-full bg-[#E50914] transition-all duration-300"
                  style={{
                    width: `${Math.min(100, Math.max(4, entry.progressPercent))}%`,
                  }}
                />
              </div>
            </div>

            <div className="flex items-start justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {item.title}
                </p>
                <p className="truncate text-xs text-white/60 tabular-nums">
                  {subtitleText}
                </p>
              </div>
              {item.type === 'series' && entry.remainingText && (
                <span className="shrink-0 text-[11px] font-medium text-white/55 tabular-nums pt-0.5">
                  {entry.remainingText}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </CarouselRow>
  );
}

/* 3. Categorias com Pôsteres Verticais (2:3) */
interface PosterRowProps {
  title: string;
  items: CatalogItem[];
  onSelectItem: (item: CatalogItem) => void;
}

export function PosterRow({ title, items, onSelectItem }: PosterRowProps) {
  if (items.length === 0) return null;

  return (
    <CarouselRow title={title}>
      {items.map((item) => (
        <button
          key={`${title}-${item.id}`}
          type="button"
          onClick={() => onSelectItem(item)}
          className="group relative w-[156px] sm:w-[186px] shrink-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-[8px]"
        >
          <div className="relative aspect-[2/3] w-full overflow-hidden rounded-[8px] border border-white/10 bg-[#121417]">
            <MediaImage
              src={item.posterImage}
              alt={item.title}
              className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent opacity-80 transition-opacity duration-200 group-hover:opacity-100" />

            {item.qualityBadge && (
              <span className="absolute top-2.5 left-2.5 rounded-[4px] border border-white/20 bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-white/95 backdrop-blur-sm">
                {item.qualityBadge}
              </span>
            )}

            <div className="absolute inset-x-0 bottom-0 p-3">
              <p className="line-clamp-1 text-sm font-semibold text-white">
                {item.title}
              </p>
              <p className="mt-0.5 text-[11px] text-white/60 tabular-nums">
                {item.year} · {item.genres[0]}
              </p>
            </div>
          </div>
        </button>
      ))}
    </CarouselRow>
  );
}

/* 4. Cards Horizontais Largos (16:9) */
interface WidescreenRowProps {
  title: string;
  items: CatalogItem[];
  myListIds: string[];
  onPlay: (item: CatalogItem) => void;
  onMoreInfo: (item: CatalogItem) => void;
  onToggleMyList: (itemId: string) => void;
}

export function WidescreenRow({
  title,
  items,
  myListIds,
  onPlay,
  onMoreInfo,
  onToggleMyList,
}: WidescreenRowProps) {
  if (items.length === 0) return null;

  return (
    <CarouselRow title={title}>
      {items.map((item) => {
        const inList = myListIds.includes(item.id);
        return (
          <div
            key={`${title}-${item.id}`}
            onClick={() => onMoreInfo(item)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onMoreInfo(item);
              }
            }}
            className="group relative aspect-video w-[300px] sm:w-[388px] shrink-0 cursor-pointer overflow-hidden rounded-[8px] border border-white/10 bg-[#121417] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <MediaImage
              src={item.backdropImage}
              alt={item.title}
              className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0B0C0E] via-[#0B0C0E]/35 to-transparent" />

            {item.qualityBadge && (
              <span className="absolute top-3 right-3 rounded-[4px] border border-white/20 bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-white/95 backdrop-blur-sm">
                {item.qualityBadge}
              </span>
            )}

            <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2.5 p-4">
              <div>
                <p className="text-[11px] font-medium text-white/65 tabular-nums">
                  {PLATFORM_LABELS[item.platform]} · {item.year} ·{' '}
                  {item.genres[0]}
                </p>
                <h3 className="font-display text-lg font-bold tracking-tight text-white">
                  {item.title}
                </h3>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlay(item);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-xs font-bold text-[#0B0C0E] transition-colors hover:bg-white/90 whitespace-nowrap shrink-0"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Assistir
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleMyList(item.id);
                  }}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold backdrop-blur-md transition-colors whitespace-nowrap shrink-0 ${
                    inList
                      ? 'border-white/40 bg-white/20 text-white'
                      : 'border-white/20 bg-black/50 text-white/90 hover:bg-white/15'
                  }`}
                >
                  {inList ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Na Lista
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      Minha Lista
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </CarouselRow>
  );
}

/* 5. Navegue por Plataforma */
interface PlatformBrowseRowProps {
  selectedPlatform: PlatformId | null;
  onSelectPlatform: (platform: PlatformId | null) => void;
}

export function PlatformBrowseRow({
  selectedPlatform,
  onSelectPlatform,
}: PlatformBrowseRowProps) {
  return (
    <section className="mx-auto max-w-[1440px] space-y-4 px-4 sm:px-8 lg:px-12">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight text-white sm:text-xl">
            Navegue por Plataforma
          </h2>
          <p className="mt-0.5 text-xs text-white/55">
            Selecione um serviço para filtrar o catálogo integrado
          </p>
        </div>
        {selectedPlatform && (
          <button
            type="button"
            onClick={() => onSelectPlatform(null)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#121417] px-3 py-1.5 text-xs font-medium text-white/85 transition-colors hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
            Limpar filtro
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {PLATFORMS.map((platform) => {
          const isSelected = selectedPlatform === platform.id;
          return (
            <button
              key={platform.id}
              type="button"
              onClick={() =>
                onSelectPlatform(isSelected ? null : platform.id)
              }
              aria-pressed={isSelected}
              className={`group relative flex h-28 flex-col justify-between overflow-hidden rounded-[8px] border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                platform.bgClass
              } ${platform.borderClass} ${
                isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0B0C0E]' : ''
              }`}
            >
              <span
                className={`font-display text-xl font-extrabold tracking-tight ${platform.textClass}`}
              >
                {platform.name}
              </span>
              <span
                className={`line-clamp-2 text-[11px] font-medium leading-snug ${platform.accentClass}`}
              >
                {platform.tagline}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* Filtered Grid (Platform Filter or Search Results) */
interface FilteredCatalogGridProps {
  title: string;
  items: CatalogItem[];
  onSelectItem: (item: CatalogItem) => void;
  onPlay: (item: CatalogItem) => void;
  onClear: () => void;
}

export function FilteredCatalogGrid({
  title,
  items,
  onSelectItem,
  onPlay,
  onClear,
}: FilteredCatalogGridProps) {
  return (
    <section
      aria-live="polite"
      className="mx-auto max-w-[1440px] space-y-5 px-4 sm:px-8 lg:px-12"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
            {title}
          </h2>
          <span className="text-xs font-medium text-white/55 tabular-nums">
            {items.length}{' '}
            {items.length === 1 ? 'título encontrado' : 'títulos encontrados'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#121417] px-3.5 py-2 text-xs font-semibold text-white/85 transition-colors hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
          Limpar filtro
        </button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#121417] px-6 py-16 text-center">
          <SearchX className="mb-3 h-10 w-10 text-white/30" />
          <p className="font-display text-lg font-semibold text-white">
            Nenhum título encontrado
          </p>
          <p className="mt-1 max-w-md text-sm text-white/60">
            Tente outro termo de busca ou remova o filtro de plataforma para
            explorar todo o catálogo.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => onSelectItem(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectItem(item);
                }
              }}
              className="group relative cursor-pointer overflow-hidden rounded-[8px] border border-white/10 bg-[#121417] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <div className="relative aspect-[2/3] w-full overflow-hidden">
                <MediaImage
                  src={item.posterImage}
                  alt={item.title}
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
                {item.qualityBadge && (
                  <span className="absolute top-2.5 left-2.5 rounded-[4px] border border-white/20 bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-white">
                    {item.qualityBadge}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlay(item);
                  }}
                  aria-label={`Assistir ${item.title}`}
                  className="absolute right-2.5 bottom-14 flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0B0C0E] opacity-0 shadow-lg transition-all duration-150 group-hover:opacity-100 hover:scale-105"
                >
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                </button>
                <div className="absolute inset-x-0 bottom-0 p-3">
                  <p className="line-clamp-1 text-sm font-semibold text-white">
                    {item.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-white/65 tabular-nums">
                    {PLATFORM_LABELS[item.platform]} · {item.year}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
