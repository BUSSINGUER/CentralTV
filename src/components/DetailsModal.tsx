import { useEffect, useMemo, useState } from 'react';
import { Check, Film, Play, Plus, Star, Tv, X } from 'lucide-react';
import { PLATFORM_LABELS } from '../data/catalog';
import { fetchAndCacheDetailsOnDemand } from '../services/pipeline';
import {
  findEpisodeHistoryRecord,
  getLatestItemHistory,
  getNextSeriesEpisode,
  parseEpisodeTagFromLabel,
} from '../services/watchHistory';
import {
  CatalogItem,
  ContinueWatchingEntry,
  MediaSource,
  PlaybackStartOptions,
  SeriesEpisode,
  WatchHistoryRecord,
} from '../types/streaming';
import { MediaImage } from './MediaImage';

interface DetailsModalProps {
  item: CatalogItem | null;
  allCatalog: CatalogItem[];
  isInMyList: boolean;
  tmdbApiKey?: string;
  youtubeApiKey?: string;
  watchHistory?: WatchHistoryRecord[];
  continueEntry?: ContinueWatchingEntry;
  onClose: () => void;
  onPlay: (item: CatalogItem, options?: PlaybackStartOptions) => void;
  onToggleMyList: (itemId: string) => void;
  onSelectSimilar: (item: CatalogItem) => void;
  onItemEnriched?: (item: CatalogItem) => void;
}

export function DetailsModal({
  item,
  allCatalog: _allCatalog,
  isInMyList,
  tmdbApiKey = '',
  youtubeApiKey = '',
  watchHistory = [],
  continueEntry,
  onClose,
  onPlay,
  onToggleMyList,
  onSelectSimilar: _onSelectSimilar,
  onItemEnriched,
}: DetailsModalProps) {
  const [resolvedTrailerId, setResolvedTrailerId] = useState(
    item?.youtubeTrailerId || ''
  );
  const [showTrailer, setShowTrailer] = useState(
    Boolean(item?.youtubeTrailerId)
  );

  const episodes: SeriesEpisode[] = item?.episodes || [];
  const seasons = useMemo(() => {
    const map = new Map<number, SeriesEpisode[]>();
    for (const ep of episodes) {
      const s = ep.season || 1;
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(ep);
    }
    return Array.from(map.keys()).sort((a, b) => a - b);
  }, [episodes]);

  const heroContinueState = useMemo(() => {
    if (!item) {
      return {
        buttonLabel: 'Assistir',
        progressPercent: 0,
        targetSeason: undefined as number | undefined,
        targetEpisode: undefined as SeriesEpisode | undefined,
        preferredSourceId: undefined as string | undefined,
        preferredSourceLabel: undefined as string | undefined,
        preferredSourceUrl: undefined as string | undefined,
        episodeLabel: undefined as string | undefined,
      };
    }

    const latestRec = getLatestItemHistory(watchHistory, item.id);

    if (item.type === 'series') {
      if (latestRec) {
        const s = latestRec.season || 1;
        const e = latestRec.episodeNumber || 1;
        if (
          !latestRec.completed &&
          latestRec.currentTime > 10 &&
          latestRec.progressPercent < 92
        ) {
          const matchedEp = episodes.find(
            (ep) =>
              (latestRec.episodeId && ep.id === latestRec.episodeId) ||
              ((ep.season || 1) === s && ep.episode === e)
          );
          return {
            buttonLabel: `Continuar T${s}:E${e}`,
            progressPercent: latestRec.progressPercent,
            targetSeason: s,
            targetEpisode: matchedEp,
            preferredSourceId: latestRec.selectedSourceId,
            preferredSourceLabel: latestRec.selectedSourceLabel,
            preferredSourceUrl: latestRec.selectedSourceUrl,
            episodeLabel:
              latestRec.episodeLabel ||
              (matchedEp ? `T${s}:E${e} · ${matchedEp.title}` : `T${s}:E${e}`),
          };
        }

        if (latestRec.completed) {
          const nextEp = getNextSeriesEpisode(
            item,
            s,
            e,
            latestRec.episodeId,
            latestRec.episodeLabel
          );
          if (nextEp) {
            return {
              buttonLabel: `Continuar T${nextEp.season}:E${nextEp.episode}`,
              progressPercent: 0,
              targetSeason: nextEp.season,
              targetEpisode: nextEp,
              preferredSourceId: latestRec.selectedSourceId,
              preferredSourceLabel: latestRec.selectedSourceLabel,
              preferredSourceUrl: latestRec.selectedSourceUrl,
              episodeLabel: `T${nextEp.season}:E${nextEp.episode} · ${nextEp.title}`,
            };
          }
        }
      }

      if (
        continueEntry &&
        continueEntry.progressPercent > 0 &&
        continueEntry.progressPercent <= 92
      ) {
        const parsed = parseEpisodeTagFromLabel(continueEntry.episodeLabel);
        const s = continueEntry.season ?? parsed.season ?? 1;
        const e = continueEntry.episodeNumber ?? parsed.episodeNumber ?? 1;
        const matchedEp = episodes.find(
          (ep) =>
            (continueEntry.episodeId && ep.id === continueEntry.episodeId) ||
            ((ep.season || 1) === s && ep.episode === e)
        );
        return {
          buttonLabel: `Continuar T${s}:E${e}`,
          progressPercent: continueEntry.progressPercent,
          targetSeason: s,
          targetEpisode: matchedEp,
          preferredSourceId: continueEntry.selectedSourceId,
          preferredSourceLabel: continueEntry.selectedSourceLabel,
          preferredSourceUrl: continueEntry.selectedSourceUrl,
          episodeLabel: continueEntry.episodeLabel,
        };
      }

      return {
        buttonLabel: 'Assistir',
        progressPercent: 0,
        targetSeason: seasons[0],
        targetEpisode: undefined,
        preferredSourceId: undefined,
        preferredSourceLabel: undefined,
        preferredSourceUrl: undefined,
        episodeLabel: undefined,
      };
    }

    // Movie
    if (
      latestRec &&
      !latestRec.completed &&
      latestRec.currentTime > 10 &&
      latestRec.progressPercent < 92
    ) {
      return {
        buttonLabel: 'Continuar',
        progressPercent: latestRec.progressPercent,
        targetSeason: undefined,
        targetEpisode: undefined,
        preferredSourceId: latestRec.selectedSourceId,
        preferredSourceLabel: latestRec.selectedSourceLabel,
        preferredSourceUrl: latestRec.selectedSourceUrl,
        episodeLabel: latestRec.episodeLabel,
      };
    }

    if (
      continueEntry &&
      continueEntry.progressPercent > 0 &&
      continueEntry.progressPercent <= 92
    ) {
      return {
        buttonLabel: 'Continuar',
        progressPercent: continueEntry.progressPercent,
        targetSeason: undefined,
        targetEpisode: undefined,
        preferredSourceId: continueEntry.selectedSourceId,
        preferredSourceLabel: continueEntry.selectedSourceLabel,
        preferredSourceUrl: continueEntry.selectedSourceUrl,
        episodeLabel: continueEntry.episodeLabel,
      };
    }

    return {
      buttonLabel: 'Assistir',
      progressPercent: 0,
      targetSeason: undefined,
      targetEpisode: undefined,
      preferredSourceId: undefined,
      preferredSourceLabel: undefined,
      preferredSourceUrl: undefined,
      episodeLabel: undefined,
    };
  }, [item, watchHistory, continueEntry, episodes, seasons]);

  const [activeSeason, setActiveSeason] = useState<number>(
    heroContinueState.targetSeason || seasons[0] || 1
  );

  useEffect(() => {
    if (
      heroContinueState.targetSeason &&
      seasons.includes(heroContinueState.targetSeason)
    ) {
      setActiveSeason(heroContinueState.targetSeason);
    } else if (seasons.length > 0 && !seasons.includes(activeSeason)) {
      setActiveSeason(seasons[0]);
    }
  }, [item?.id, seasons, heroContinueState.targetSeason]);

  const currentSeasonEpisodes = useMemo(() => {
    return episodes
      .filter((ep) => (ep.season || 1) === activeSeason)
      .sort((a, b) => a.episode - b.episode);
  }, [episodes, activeSeason]);

  useEffect(() => {
    const initialId = item?.youtubeTrailerId || '';
    setResolvedTrailerId(initialId);
    setShowTrailer(Boolean(initialId));

    if (
      !item ||
      (item.tmdbEnriched && item.youtubeEnriched) ||
      item.type === 'live' ||
      item.type === 'radio'
    ) {
      return;
    }

    let cancelled = false;
    void fetchAndCacheDetailsOnDemand(item, tmdbApiKey, youtubeApiKey).then((enriched) => {
      if (!cancelled) {
        if (enriched.youtubeTrailerId) {
          setResolvedTrailerId(enriched.youtubeTrailerId);
          setShowTrailer(true);
        }
        onItemEnriched?.(enriched);
      }
    }).catch((error) => console.warn('Falha ao atualizar a ficha do título.', error));

    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.tmdbEnriched, item?.youtubeEnriched, item?.youtubeTrailerId, tmdbApiKey, youtubeApiKey, onItemEnriched]);

  useEffect(() => {
    if (!item) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [item, onClose]);

  if (!item) return null;

  const hasTrailer = Boolean(resolvedTrailerId);
  const embedUrl = hasTrailer
    ? `https://www.youtube.com/embed/${resolvedTrailerId}?autoplay=1&mute=0&rel=0&modestbranding=1`
    : '';

  const sources: MediaSource[] = item.sources || [];
  const primarySource = sources[0];

  const handlePlayHero = () => {
    if (item.type === 'series') {
      const targetEp =
        heroContinueState.targetEpisode || currentSeasonEpisodes[0];
      if (targetEp) {
        const epSources =
          targetEp.sources && targetEp.sources.length > 0
            ? targetEp.sources
            : sources;
        onPlay(item, {
          season: targetEp.season || 1,
          episodeNumber: targetEp.episode,
          episodeId: targetEp.id,
          episodeTitle: targetEp.title,
          episodeLabel: `T${targetEp.season || 1}:E${targetEp.episode} · ${targetEp.title}`,
          streamUrl:
            heroContinueState.preferredSourceUrl ||
            epSources[0]?.url ||
            primarySource?.url,
          sources: epSources,
          preferredSourceId: heroContinueState.preferredSourceId,
          preferredSourceLabel: heroContinueState.preferredSourceLabel,
          preferredSourceUrl: heroContinueState.preferredSourceUrl,
        });
        return;
      }
    }

    onPlay(item, {
      episodeLabel: heroContinueState.episodeLabel || primarySource?.label,
      streamUrl: heroContinueState.preferredSourceUrl || primarySource?.url,
      sources,
      preferredSourceId: heroContinueState.preferredSourceId,
      preferredSourceLabel: heroContinueState.preferredSourceLabel,
      preferredSourceUrl: heroContinueState.preferredSourceUrl,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-md sm:p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-white/12 bg-[#121417] shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar detalhes"
          className="absolute top-4 right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white backdrop-blur-md transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Hero Superior (Modern Streaming Style) */}
        <div className="relative aspect-video w-full overflow-hidden bg-[#0B0C0E]">
          {showTrailer && hasTrailer ? (
            <iframe
              key={resolvedTrailerId}
              src={embedUrl}
              title={`Trailer oficial de ${item.title}`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              className="h-full w-full border-0"
            />
          ) : (
            <MediaImage
              src={item.backdropImage || item.posterImage}
              alt={item.title}
              className="h-full w-full object-cover"
            />
          )}

          {/* Gradients for contrast */}
          <div className="absolute inset-0 bg-gradient-to-t from-[#121417] via-black/20 to-black/60" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />

          {/* Hero Content Overlay */}
          <div className="absolute inset-x-0 bottom-0 p-6 sm:p-8 space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wide text-white/80 tabular-nums">
              <span className="text-[#E50914] uppercase">
                {PLATFORM_LABELS[item.platform]}
              </span>
              <span aria-hidden="true">·</span>
              <span>{item.year}</span>
              <span aria-hidden="true">·</span>
              <span className="rounded-[4px] border border-white/25 bg-white/10 px-1.5 py-0.5 text-[11px] font-bold text-white">
                {item.ageRating}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {item.type === 'series'
                  ? `${seasons.length} ${seasons.length === 1 ? 'Temporada' : 'Temporadas'}`
                  : item.duration}
              </span>
              {typeof item.voteAverage === 'number' && item.voteAverage > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-amber-300">
                    <Star className="h-3.5 w-3.5 fill-current" />
                    {item.voteAverage.toFixed(1)}
                  </span>
                </>
              )}
              {item.genres.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{item.genres.join(' · ')}</span>
                </>
              )}
            </div>

            <h2
              id="modal-title"
              className="font-display text-3xl font-extrabold tracking-tight text-white sm:text-4xl"
            >
              {item.title}
            </h2>

            <p className="line-clamp-3 text-sm leading-relaxed text-white/85 sm:text-base max-w-2xl">
              {item.synopsis}
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handlePlayHero}
                className="relative inline-flex h-11 items-center gap-2 overflow-hidden rounded-lg bg-white px-7 text-sm font-bold text-[#0B0C0E] transition-transform duration-150 hover:scale-[1.02] hover:bg-white/90 shadow-lg"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>{heroContinueState.buttonLabel}</span>
                {heroContinueState.progressPercent > 0 && (
                  <span className="absolute inset-x-0 bottom-0 h-1 bg-black/15">
                    <span
                      className="block h-full bg-[#E50914] transition-all duration-300"
                      style={{
                        width: `${Math.min(100, heroContinueState.progressPercent)}%`,
                      }}
                    />
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => onToggleMyList(item.id)}
                className={`inline-flex h-11 items-center gap-2 rounded-lg border px-5 text-sm font-semibold transition-colors backdrop-blur-md ${
                  isInMyList
                    ? 'border-white/40 bg-white/20 text-white'
                    : 'border-white/20 bg-black/50 text-white/90 hover:bg-white/15'
                }`}
              >
                {isInMyList ? (
                  <>
                    <Check className="h-4 w-4" />
                    Na Minha Lista
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Minha Lista
                  </>
                )}
              </button>

              {hasTrailer && (
                <button
                  type="button"
                  onClick={() => setShowTrailer((prev) => !prev)}
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/20 bg-black/50 px-5 text-sm font-semibold text-white/90 backdrop-blur-md transition-colors hover:bg-white/15"
                >
                  <Film className="h-4 w-4" />
                  {showTrailer ? 'Ocultar Trailer' : 'Trailer'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Details Body: Episodes Section for Series */}
        <div className="p-6 sm:p-8 space-y-6">
          {item.type === 'series' && episodes.length > 0 && (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="flex items-center gap-2 font-display text-lg font-bold text-white">
                  <Tv className="h-5 w-5 text-[#E50914]" />
                  Episódios
                </h3>

                {seasons.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {seasons.map((sNum) => (
                      <button
                        key={sNum}
                        type="button"
                        onClick={() => setActiveSeason(sNum)}
                        className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                          activeSeason === sNum
                            ? 'bg-[#E50914] text-white'
                            : 'bg-[#181B20] text-white/70 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        Temporada {sNum}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-3">
                {currentSeasonEpisodes.map((ep) => {
                  const epSources =
                    ep.sources && ep.sources.length > 0 ? ep.sources : sources;
                  const defaultEpSource = epSources[0] || primarySource;
                  const epRec = findEpisodeHistoryRecord(
                    watchHistory,
                    item.id,
                    ep
                  );
                  const epProgressPct = epRec?.completed
                    ? 100
                    : epRec?.progressPercent ?? 0;

                  return (
                    <button
                      key={ep.id}
                      type="button"
                      onClick={() =>
                        onPlay(item, {
                          season: ep.season || 1,
                          episodeNumber: ep.episode,
                          episodeId: ep.id,
                          episodeTitle: ep.title,
                          episodeLabel: `T${ep.season || 1}:E${ep.episode} · ${ep.title}`,
                          streamUrl:
                            epRec?.selectedSourceUrl || defaultEpSource?.url,
                          sources: epSources,
                          preferredSourceId: epRec?.selectedSourceId,
                          preferredSourceLabel: epRec?.selectedSourceLabel,
                          preferredSourceUrl: epRec?.selectedSourceUrl,
                        })
                      }
                      className="group flex flex-col sm:flex-row items-stretch sm:items-center gap-4 rounded-xl border border-white/10 bg-[#181B20] p-3 text-left transition-all hover:border-white/30 hover:bg-[#1c2026]"
                    >
                      {/* 16:9 Thumbnail with play on hover + progress bar */}
                      <div className="relative aspect-video w-full sm:w-44 shrink-0 overflow-hidden rounded-lg bg-black/60">
                        <MediaImage
                          src={item.backdropImage || item.posterImage}
                          alt={ep.title}
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#0B0C0E] shadow-lg">
                            <Play className="h-4 w-4 fill-current ml-0.5" />
                          </div>
                        </div>

                        {epRec?.completed && (
                          <span className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-[4px] bg-emerald-600/95 px-1.5 py-0.5 text-[10px] font-bold text-white shadow">
                            <Check className="h-2.5 w-2.5" />
                            Visto
                          </span>
                        )}

                        {epProgressPct > 0 && (
                          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                            <div
                              className={`h-full transition-all duration-300 ${
                                epRec?.completed
                                  ? 'bg-emerald-500'
                                  : 'bg-[#E50914]'
                              }`}
                              style={{
                                width: `${Math.min(100, Math.max(4, epProgressPct))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>

                      {/* Episode Info */}
                      <div className="flex flex-1 flex-col justify-center min-w-0 py-1">
                        <div className="flex items-start justify-between gap-3">
                          <p className="font-display text-sm font-bold text-white group-hover:text-[#E50914] transition-colors tabular-nums">
                            {ep.episode}. {ep.title}
                          </p>
                          <span className="text-xs font-semibold text-white/50 shrink-0 tabular-nums">
                            {ep.duration || '45 min'}
                          </span>
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-white/65">
                          {ep.synopsis || item.synopsis}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
