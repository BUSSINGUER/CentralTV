import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminPanel, AdminTab } from './components/AdminPanel';
import {
  ContinueWatchingRow,
  FilteredCatalogGrid,
  PlatformBrowseRow,
  PosterRow,
  Top10Row,
  WidescreenRow,
} from './components/CatalogRows';
import { DetailsModal } from './components/DetailsModal';
import { HeroBanner } from './components/HeroBanner';
import { Navbar } from './components/Navbar';
import {
  CatalogGridView,
  LiveTvView,
  LoginView,
  ProfileView,
  RadioView,
} from './components/SecondaryViews';
import { VideoPlayer } from './components/VideoPlayer';
import {
  INITIAL_CATALOG,
  INITIAL_CONTINUE_WATCHING,
  PLATFORM_LABELS,
} from './data/catalog';
import {
  db,
  DEFAULT_SETTINGS,
  getAllEpgPrograms,
  getSettings,
  getUserLibrary,
  saveSettings,
  saveUserLibrary,
} from './db/database';
import { useAuth } from './contexts/AuthContext';
import {
  authorizeStreamOrigins,
  extractUrlsFromCatalogItems,
} from './services/streamOrigins';
import {
  runIndexedDbMigrationToServer,
  syncFavoritesToServer,
} from './services/persistenceSync';
import {
  SaveWatchProgressPayload,
  deriveContinueWatchingEntries,
  dismissFromContinueWatching,
  getAllWatchHistory,
  getResumePointFromHistory,
  parseEpisodeTagFromLabel,
  saveWatchProgress,
} from './services/watchHistory';
import {
  AppSettings,
  CatalogItem,
  ContinueWatchingEntry,
  EpgProgram,
  MediaSource,
  NavSection,
  PlatformId,
  PlaybackStartOptions,
  SeriesEpisode,
  WatchHistoryRecord,
} from './types/streaming';

export default function App() {
  const { user, signOutGoogle } = useAuth();
  const [publishedDbItems, setPublishedDbItems] = useState<CatalogItem[]>([]);
  const [epgPrograms, setEpgPrograms] = useState<EpgProgram[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [legacyContinueWatching, setLegacyContinueWatching] = useState<
    ContinueWatchingEntry[]
  >(INITIAL_CONTINUE_WATCHING);
  const [dismissedContinueIds, setDismissedContinueIds] = useState<string[]>(
    []
  );
  const [watchHistory, setWatchHistory] = useState<WatchHistoryRecord[]>([]);
  const [myListIds, setMyListIds] = useState<string[]>([
    'duna-horizonte',
    'neblina-do-norte',
  ]);

  const [activeSection, setActiveSection] = useState<NavSection>('home');
  const [adminInitialTab, setAdminInitialTab] = useState<AdminTab>('queue');
  const [heroIndex, setHeroIndex] = useState(0);
  const [isHeroMuted, setIsHeroMuted] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId | null>(
    null
  );

  const [modalItem, setModalItem] = useState<CatalogItem | null>(null);
  const [playerState, setPlayerState] = useState<{
    item: CatalogItem;
    season?: number;
    episodeNumber?: number;
    episodeId?: string;
    episodeTitle?: string;
    episodeLabel?: string;
    initialProgressPercent?: number;
    initialTimeSeconds?: number;
    streamUrl?: string;
    sources?: MediaSource[];
    preferredSourceId?: string;
    preferredSourceLabel?: string;
    preferredSourceUrl?: string;
  } | null>(null);

  const platformResultsRef = useRef<HTMLDivElement>(null);
  const migratedUidRef = useRef<string | null>(null);

  const loadPublishedCatalog = useCallback(async () => {
    const published = (
      await db.mediaItems.where('status').equals('publicado').toArray()
    ).filter((item) => !item.archived);
    setPublishedDbItems(published);
    void authorizeStreamOrigins(extractUrlsFromCatalogItems(published));
  }, []);

  const loadEpg = useCallback(async () => {
    const progs = await getAllEpgPrograms();
    setEpgPrograms(progs);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [loadedSettings, loadedLibrary, publishedRaw, epg, history] =
        await Promise.all([
          getSettings(),
          getUserLibrary(),
          db.mediaItems.where('status').equals('publicado').toArray(),
          getAllEpgPrograms(),
          getAllWatchHistory(),
        ]);
      if (!mounted) return;
      const published = publishedRaw.filter((item) => !item.archived);
      setSettings(loadedSettings);
      setMyListIds(loadedLibrary.myListIds);
      setLegacyContinueWatching(loadedLibrary.continueWatching);
      setDismissedContinueIds(loadedLibrary.dismissedContinueIds || []);
      setWatchHistory(history);
      setPublishedDbItems(published);
      setEpgPrograms(epg);
      void authorizeStreamOrigins(extractUrlsFromCatalogItems(published));
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      migratedUidRef.current = null;
      return;
    }
    if (migratedUidRef.current === user.uid) return;
    migratedUidRef.current = user.uid;

    let active = true;
    (async () => {
      const nextSettings = await saveSettings({
        isLoggedIn: true,
        userName:
          user.displayName ||
          user.email?.split('@')[0] ||
          settings.userName,
        userEmail: user.email || settings.userEmail,
      });
      if (active) setSettings(nextSettings);

      try {
        await runIndexedDbMigrationToServer('indexeddb_auto');
        const [loadedLibrary, publishedRaw, history] = await Promise.all([
          getUserLibrary(),
          db.mediaItems.where('status').equals('publicado').toArray(),
          getAllWatchHistory(),
        ]);
        if (!active) return;
        const published = publishedRaw.filter((item) => !item.archived);
        setMyListIds(loadedLibrary.myListIds);
        setWatchHistory(history);
        setPublishedDbItems(published);
      } catch {
        // Keep IndexedDB local cache intact on transient network failure
      }
    })();

    return () => {
      active = false;
    };
  }, [user]);

  const continueWatching = useMemo(
    () =>
      deriveContinueWatchingEntries(
        watchHistory,
        legacyContinueWatching,
        dismissedContinueIds
      ),
    [watchHistory, legacyContinueWatching, dismissedContinueIds]
  );

  const vodDbItems = useMemo(
    () =>
      publishedDbItems.filter(
        (i) => i.type === 'movie' || i.type === 'series'
      ),
    [publishedDbItems]
  );

  const usingRealVod = vodDbItems.length > 0;
  const usingRealPublished = usingRealVod;

  // Strict total isolation:
  // Home & Search -> movie | series ONLY (never live or radio)
  // Movies tab -> type === 'movie' ONLY
  // Series tab -> type === 'series' ONLY
  // Live TV tab -> type === 'live' ONLY
  // Radio tab -> type === 'radio' ONLY
  const publishedMovies = useMemo(() => {
    if (!usingRealVod) {
      return INITIAL_CATALOG.filter((i) => i.type === 'movie');
    }
    return vodDbItems.filter((i) => i.type === 'movie');
  }, [usingRealVod, vodDbItems]);

  const publishedSeries = useMemo(() => {
    if (!usingRealVod) {
      return INITIAL_CATALOG.filter((i) => i.type === 'series');
    }
    return vodDbItems.filter((i) => i.type === 'series');
  }, [usingRealVod, vodDbItems]);

  const publishedVodCatalog = useMemo(() => {
    if (!usingRealVod) return INITIAL_CATALOG;
    return vodDbItems;
  }, [usingRealVod, vodDbItems]);

  const publishedLiveItems = useMemo(
    () => publishedDbItems.filter((i) => i.type === 'live'),
    [publishedDbItems]
  );

  const publishedRadioItems = useMemo(
    () => publishedDbItems.filter((i) => i.type === 'radio'),
    [publishedDbItems]
  );

  const heroItems = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog.filter((item) => item.featuredInHero).slice(0, 5);
    }
    return publishedVodCatalog.slice(0, 5);
  }, [usingRealVod, publishedVodCatalog]);

  const top10Items = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog
        .filter((item) => typeof item.top10Rank === 'number')
        .sort((a, b) => (a.top10Rank ?? 99) - (b.top10Rank ?? 99))
        .slice(0, 10);
    }
    return [...publishedVodCatalog]
      .sort((a, b) => (b.voteAverage ?? 0) - (a.voteAverage ?? 0))
      .slice(0, 10)
      .map((item, idx) => ({ ...item, top10Rank: idx + 1 }));
  }, [usingRealVod, publishedVodCatalog]);

  const oscarItems = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog.filter((i) => i.categories.includes('oscar'));
    }
    return publishedMovies.filter((i) => (i.voteAverage ?? 0) >= 7).length > 0
      ? publishedMovies.filter((i) => (i.voteAverage ?? 0) >= 7)
      : publishedMovies;
  }, [usingRealVod, publishedVodCatalog, publishedMovies]);

  const acclaimedSeries = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog.filter((i) =>
        i.categories.includes('series-aclamadas')
      );
    }
    return publishedSeries;
  }, [usingRealVod, publishedVodCatalog, publishedSeries]);

  const recommendedWide = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog.filter((i) =>
        i.categories.includes('recomendados')
      );
    }
    return publishedVodCatalog.slice(0, 8);
  }, [usingRealVod, publishedVodCatalog]);

  const becauseWatched = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog.filter((i) =>
        i.categories.includes('porque-assistiu')
      );
    }
    return publishedVodCatalog.slice(0, 10);
  }, [usingRealVod, publishedVodCatalog]);

  const scifiWide = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog.filter((i) => i.categories.includes('scifi'));
    }
    const scifi = publishedVodCatalog.filter((i) =>
      i.genres.some((g) => g.toLowerCase().includes('fic'))
    );
    return scifi.length > 0 ? scifi : publishedVodCatalog.slice(0, 6);
  }, [usingRealVod, publishedVodCatalog]);

  const popularMovies = useMemo(() => {
    if (!usingRealVod) {
      return publishedVodCatalog.filter((i) =>
        i.categories.includes('populares')
      );
    }
    return publishedMovies;
  }, [usingRealVod, publishedVodCatalog, publishedMovies]);

  const allSearchableCatalog = useMemo(
    () => publishedVodCatalog,
    [publishedVodCatalog]
  );

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return allSearchableCatalog.filter(
      (item) =>
        item.type !== 'live' &&
        item.type !== 'radio' &&
        (item.title.toLowerCase().includes(q) ||
          item.genres.some((g) => g.toLowerCase().includes(q)) ||
          item.cast.some((c) => c.toLowerCase().includes(q)) ||
          PLATFORM_LABELS[item.platform].toLowerCase().includes(q))
    );
  }, [allSearchableCatalog, searchQuery]);

  const platformResults = useMemo(() => {
    if (!selectedPlatform) return [];
    return publishedVodCatalog.filter(
      (item) => item.platform === selectedPlatform
    );
  }, [publishedVodCatalog, selectedPlatform]);

  const myListItems = useMemo(
    () => allSearchableCatalog.filter((item) => myListIds.includes(item.id)),
    [allSearchableCatalog, myListIds]
  );

  const handleToggleMyList = (itemId: string) => {
    setMyListIds((prev) => {
      const next = prev.includes(itemId)
        ? prev.filter((id) => id !== itemId)
        : [...prev, itemId];
      void saveUserLibrary({ myListIds: next });
      void syncFavoritesToServer(next);
      return next;
    });
  };

  const handleOpenPlayer = useCallback(
    (
      item: CatalogItem,
      optionsOrLabel?: string | PlaybackStartOptions,
      legacyStreamUrl?: string,
      legacySources?: MediaSource[]
    ) => {
      const opts: PlaybackStartOptions =
        typeof optionsOrLabel === 'string'
          ? {
              episodeLabel: optionsOrLabel,
              streamUrl: legacyStreamUrl,
              sources: legacySources,
            }
          : optionsOrLabel || {};

      const existingContinue = continueWatching.find(
        (c) => c.itemId === item.id
      );

      let season = opts.season;
      let episodeNumber = opts.episodeNumber;
      let episodeId = opts.episodeId;
      let episodeTitle = opts.episodeTitle;
      let episodeLabel = opts.episodeLabel ?? existingContinue?.episodeLabel;
      let sources = opts.sources;
      let streamUrl = opts.streamUrl;

      if (item.type === 'series' && item.episodes && item.episodes.length > 0) {
        const parsed = parseEpisodeTagFromLabel(episodeLabel);
        const targetSeason = season ?? parsed.season;
        const targetEpNum = episodeNumber ?? parsed.episodeNumber;
        const matchedEp =
          item.episodes.find(
            (ep) =>
              (episodeId && ep.id === episodeId) ||
              (targetSeason &&
                targetEpNum &&
                (ep.season || 1) === targetSeason &&
                ep.episode === targetEpNum)
          ) || item.episodes[0];

        if (matchedEp) {
          season = matchedEp.season || 1;
          episodeNumber = matchedEp.episode;
          episodeId = matchedEp.id;
          episodeTitle = matchedEp.title;
          episodeLabel = `T${season}:E${episodeNumber} · ${matchedEp.title}`;
          if (!sources || sources.length === 0) {
            sources =
              matchedEp.sources && matchedEp.sources.length > 0
                ? matchedEp.sources
                : item.sources;
          }
          if (!streamUrl && sources && sources.length > 0) {
            streamUrl = sources[0].url;
          }
        }
      }

      const resume =
        item.type === 'live' || item.type === 'radio'
          ? null
          : getResumePointFromHistory(watchHistory, item, {
              season,
              episodeNumber,
              episodeId,
              episodeLabel,
            });

      const fallbackPct =
        !resume &&
        item.type !== 'live' &&
        item.type !== 'radio' &&
        existingContinue &&
        existingContinue.progressPercent < 92 &&
        (!season ||
          !episodeNumber ||
          (existingContinue.season === season &&
            existingContinue.episodeNumber === episodeNumber))
          ? existingContinue.progressPercent
          : 0;

      setModalItem(null);
      setPlayerState({
        item,
        season,
        episodeNumber,
        episodeId,
        episodeTitle,
        episodeLabel,
        initialTimeSeconds: resume?.currentTime ?? 0,
        initialProgressPercent: resume?.progressPercent ?? fallbackPct,
        streamUrl: streamUrl || resume?.selectedSourceUrl,
        sources,
        preferredSourceId: opts.preferredSourceId ?? resume?.selectedSourceId,
        preferredSourceLabel:
          opts.preferredSourceLabel ?? resume?.selectedSourceLabel,
        preferredSourceUrl:
          opts.preferredSourceUrl ?? resume?.selectedSourceUrl,
      });
    },
    [continueWatching, watchHistory]
  );

  const persistPlaybackProgress = useCallback(
    async (payload: SaveWatchProgressPayload) => {
      const saved = await saveWatchProgress(payload);
      setWatchHistory((prev) => {
        const filtered = prev.filter((r) => r.id !== saved.id);
        return [saved, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
      });
      setDismissedContinueIds((prev) =>
        prev.filter((id) => id !== saved.itemId)
      );
    },
    []
  );

  const handleRemoveContinueWatching = useCallback((itemId: string) => {
    setWatchHistory((prev) =>
      prev.map((r) =>
        r.itemId === itemId ? { ...r, dismissedFromContinue: true } : r
      )
    );
    setLegacyContinueWatching((prev) =>
      prev.filter((c) => c.itemId !== itemId)
    );
    setDismissedContinueIds((prev) =>
      prev.includes(itemId) ? prev : [...prev, itemId]
    );
    void dismissFromContinueWatching(itemId);
  }, []);

  const handleSelectNextEpisode = useCallback(
    (episode: SeriesEpisode, preferredSource?: MediaSource) => {
      if (!playerState) return;
      const item = playerState.item;
      const epSources =
        episode.sources && episode.sources.length > 0
          ? episode.sources
          : item.sources;

      handleOpenPlayer(item, {
        season: episode.season || 1,
        episodeNumber: episode.episode,
        episodeId: episode.id,
        episodeTitle: episode.title,
        episodeLabel: `T${episode.season || 1}:E${episode.episode} · ${episode.title}`,
        sources: epSources,
        preferredSourceId: preferredSource?.id,
        preferredSourceLabel: preferredSource?.label,
        preferredSourceUrl: preferredSource?.url,
      });
    },
    [playerState, handleOpenPlayer]
  );

  const handleClosePlayer = useCallback(() => {
    setPlayerState(null);
  }, []);

  const handleSelectPlatform = (platform: PlatformId | null) => {
    setSelectedPlatform(platform);
    if (platform) {
      window.setTimeout(() => {
        platformResultsRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 60);
    }
  };

  const handleNavigate = (section: NavSection) => {
    if (section === 'admin') {
      setAdminInitialTab('queue');
    }
    setActiveSection(section);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleItemEnriched = useCallback(
    (enriched: CatalogItem) => {
      setPublishedDbItems((prev) =>
        prev.map((item) =>
          item.id === enriched.id ? enriched : item
        )
      );
      setModalItem((current) =>
        current?.id === enriched.id ? enriched : current
      );
    },
    []
  );

  return (
    <div className="min-h-screen bg-[#0B0C0E] text-[#F4F5F7]">
      <Navbar
        activeSection={activeSection}
        onNavigate={handleNavigate}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isHeroMuted={isHeroMuted}
        onToggleHeroMute={() => setIsHeroMuted((m) => !m)}
        isLoggedIn={settings.isLoggedIn}
      />

      {activeSection === 'home' && (
        <main className="pb-20">
          {searchQuery.trim() ? (
            <div className="pt-28">
              <FilteredCatalogGrid
                title={`Resultados para “${searchQuery.trim()}”`}
                items={searchResults}
                onSelectItem={setModalItem}
                onPlay={handleOpenPlayer}
                onClear={() => setSearchQuery('')}
              />
            </div>
          ) : (
            <>
              <HeroBanner
                items={heroItems}
                activeIndex={heroIndex}
                onSelectIndex={setHeroIndex}
                isMuted={isHeroMuted}
                onToggleMute={() => setIsHeroMuted((m) => !m)}
                onPlay={handleOpenPlayer}
                onMoreInfo={setModalItem}
              />

              <div className="-mt-6 relative z-20 space-y-12">
                <ContinueWatchingRow
                  entries={continueWatching}
                  catalog={allSearchableCatalog}
                  onPlay={handleOpenPlayer}
                  onMoreInfo={setModalItem}
                  onRemove={handleRemoveContinueWatching}
                />

                <Top10Row items={top10Items} onSelectItem={setModalItem} />

                <PosterRow
                  title="Vencedores e Indicados ao Oscar"
                  items={oscarItems}
                  onSelectItem={setModalItem}
                />

                <PosterRow
                  title="Séries Aclamadas"
                  items={acclaimedSeries}
                  onSelectItem={setModalItem}
                />

                <WidescreenRow
                  title="Achamos que você vai gostar"
                  items={recommendedWide}
                  myListIds={myListIds}
                  onPlay={handleOpenPlayer}
                  onMoreInfo={setModalItem}
                  onToggleMyList={handleToggleMyList}
                />

                <PosterRow
                  title={
                    usingRealPublished
                      ? 'Adicionados Recentemente'
                      : 'Porque você assistiu Duna: Horizonte Infinito'
                  }
                  items={becauseWatched}
                  onSelectItem={setModalItem}
                />

                <WidescreenRow
                  title="Ficção Científica"
                  items={scifiWide}
                  myListIds={myListIds}
                  onPlay={handleOpenPlayer}
                  onMoreInfo={setModalItem}
                  onToggleMyList={handleToggleMyList}
                />

                <PosterRow
                  title="Filmes Populares"
                  items={popularMovies}
                  onSelectItem={setModalItem}
                />

                <PlatformBrowseRow
                  selectedPlatform={selectedPlatform}
                  onSelectPlatform={handleSelectPlatform}
                />

                {selectedPlatform && (
                  <div ref={platformResultsRef} className="pt-2 scroll-mt-24">
                    <FilteredCatalogGrid
                      title={`Catálogo ${PLATFORM_LABELS[selectedPlatform]}`}
                      items={platformResults}
                      onSelectItem={setModalItem}
                      onPlay={handleOpenPlayer}
                      onClear={() => setSelectedPlatform(null)}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      )}

      {activeSection === 'movies' && (
        <CatalogGridView
          title="Filmes"
          subtitle="Longas-metragens selecionados em 4K e IMAX de todas as plataformas"
          items={publishedMovies}
          onSelectItem={setModalItem}
          onPlay={handleOpenPlayer}
        />
      )}

      {activeSection === 'series' && (
        <CatalogGridView
          title="Séries"
          subtitle="Temporadas completas e estreias semanais em alta definição"
          items={publishedSeries}
          onSelectItem={setModalItem}
          onPlay={handleOpenPlayer}
        />
      )}

      {activeSection === 'live' && (
        <LiveTvView
          publishedLiveItems={publishedLiveItems}
          epgPrograms={epgPrograms}
          onPlayItem={(item) => handleOpenPlayer(item)}
          onBackHome={() => handleNavigate('home')}
        />
      )}

      {activeSection === 'radio' && (
        <RadioView
          publishedRadioItems={publishedRadioItems}
          onBackHome={() => handleNavigate('home')}
        />
      )}

      {activeSection === 'profile' && (
        <ProfileView
          userName={user?.displayName || settings.userName}
          userEmail={user?.email || settings.userEmail}
          myListItems={myListItems}
          onSelectItem={setModalItem}
          onNavigate={handleNavigate}
          onLogout={() => {
            void signOutGoogle();
            void saveSettings({ isLoggedIn: false }).then(setSettings);
            handleNavigate('login');
          }}
        />
      )}

      {activeSection === 'login' && (
        <LoginView
          onLoginSuccess={(name, email) => {
            void saveSettings({
              isLoggedIn: true,
              userName: name,
              userEmail: email,
            }).then(setSettings);
            handleNavigate('home');
          }}
          onCancel={() => handleNavigate('home')}
        />
      )}

      {activeSection === 'admin' && (
        <AdminPanel
          settings={settings}
          initialTab={adminInitialTab}
          onSettingsUpdated={setSettings}
          onSelectItem={setModalItem}
          onBackHome={() => handleNavigate('home')}
          onCatalogChanged={() => {
            void loadPublishedCatalog();
          }}
          onEpgChanged={() => {
            void loadEpg();
          }}
        />
      )}

      <footer className="border-t border-white/8 bg-[#0B0C0E]">
        <div className="mx-auto flex max-w-[1440px] flex-col items-start justify-between gap-4 px-4 py-8 text-xs text-white/45 sm:flex-row sm:items-center sm:px-8 lg:px-12">
          <div className="flex items-center gap-2.5">
            <span className="font-display font-bold text-white/80">
              Aura Stream
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {usingRealPublished
                ? `${publishedDbItems.length} títulos publicados`
                : 'Curadoria multiplataforma em Dark Mode'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <button
              type="button"
              onClick={() => handleNavigate('movies')}
              className="hover:text-white/80"
            >
              Filmes
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('series')}
              className="hover:text-white/80"
            >
              Séries
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('live')}
              className="hover:text-white/80"
            >
              TV ao Vivo
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('admin')}
              className="hover:text-white/80"
            >
              Admin
            </button>
          </div>
        </div>
      </footer>

      <DetailsModal
        item={modalItem}
        allCatalog={allSearchableCatalog}
        isInMyList={modalItem ? myListIds.includes(modalItem.id) : false}
        tmdbApiKey={settings.tmdbApiKey}
        youtubeApiKey={settings.youtubeApiKey}
        watchHistory={watchHistory}
        continueEntry={
          modalItem
            ? continueWatching.find((c) => c.itemId === modalItem.id)
            : undefined
        }
        onClose={() => setModalItem(null)}
        onPlay={handleOpenPlayer}
        onToggleMyList={handleToggleMyList}
        onSelectSimilar={(sim) => setModalItem(sim)}
        onItemEnriched={handleItemEnriched}
      />

      <VideoPlayer
        item={playerState?.item ?? null}
        season={playerState?.season}
        episodeNumber={playerState?.episodeNumber}
        episodeId={playerState?.episodeId}
        episodeTitle={playerState?.episodeTitle}
        episodeLabel={playerState?.episodeLabel}
        initialProgressPercent={playerState?.initialProgressPercent}
        initialTimeSeconds={playerState?.initialTimeSeconds}
        streamUrl={playerState?.streamUrl}
        sources={playerState?.sources}
        preferredSourceId={playerState?.preferredSourceId}
        preferredSourceLabel={playerState?.preferredSourceLabel}
        preferredSourceUrl={playerState?.preferredSourceUrl}
        streamProxyPrefix={settings.streamProxyPrefix}
        autoProxyHttpStreams={settings.autoProxyHttpStreams ?? true}
        onOpenAdminSettings={() => {
          setAdminInitialTab('settings');
          setActiveSection('admin');
        }}
        onProgressUpdate={(payload) => {
          void persistPlaybackProgress(payload);
        }}
        onSelectEpisode={handleSelectNextEpisode}
        onClose={handleClosePlayer}
      />
    </div>
  );
}
