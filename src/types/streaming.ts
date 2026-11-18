export type PlatformId =
  | 'netflix'
  | 'disney'
  | 'hbo'
  | 'hulu'
  | 'prime'
  | 'apple';

export type MediaKind = 'movie' | 'series' | 'live' | 'radio';

export type PublishStatus = 'pendente' | 'aprovado' | 'offline' | 'publicado';

export type NavSection =
  | 'home'
  | 'movies'
  | 'series'
  | 'live'
  | 'radio'
  | 'profile'
  | 'login'
  | 'admin';

export type MediaFormatBadge = 'IMAX' | '4K' | 'DOLBY';

export interface MediaSource {
  id: string;
  label: string;
  qualityTag?: string;
  resolutionTag?: string;
  languageTag?: string;
  originalName?: string;
  url: string;
  listId?: string;
  groupTitle?: string;
  tvgId?: string;
  status: 'pending' | 'online' | 'offline';
  latencyMs?: number;
  reason?: string;
  lastCheckedAt?: number;
}

export interface SeriesEpisode {
  id: string;
  season: number;
  episode: number;
  title: string;
  duration?: string;
  synopsis?: string;
  sources: MediaSource[];
}

export interface CatalogItem {
  id: string;
  title: string;
  stylizedSubtitle?: string;
  type: MediaKind;
  mediaKind?: MediaKind;
  year: number;
  genres: string[];
  ageRating: 'L' | '10' | '12' | '14' | '16' | '18';
  duration: string;
  durationSeconds: number;
  platform: PlatformId;
  qualityBadge?: MediaFormatBadge;
  synopsis: string;
  cast: string[];
  director: string;
  youtubeTrailerId: string;
  posterImage: string;
  backdropImage: string;
  accentColor?: string;
  featuredInHero?: boolean;
  top10Rank?: number;
  categories: string[];
  // Etapa 02 & 03: M3U + Pipeline + EPG + IndexedDB fields
  normalizedKey?: string;
  originalTitle?: string;
  tvgId?: string;
  tvgName?: string;
  groupTitle?: string;
  tvgLogo?: string;
  voteAverage?: number;
  tmdbId?: number;
  sources?: MediaSource[];
  episodes?: SeriesEpisode[];
  status?: PublishStatus;
  healthChecked?: boolean;
  tmdbEnriched?: boolean;
  youtubeEnriched?: boolean;
  lastError?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface EpgProgram {
  id: string;
  channelId: string;
  channelName?: string;
  title: string;
  description?: string;
  startMs: number;
  stopMs: number;
}

export interface ContinueWatchingEntry {
  itemId: string;
  type?: 'movie' | 'series';
  season?: number;
  episodeNumber?: number;
  episodeId?: string;
  episodeLabel: string;
  currentTime?: number;
  duration?: number;
  progressPercent: number;
  remainingText: string;
  selectedSourceId?: string;
  selectedSourceLabel?: string;
  selectedSourceUrl?: string;
  updatedAt?: number;
}

export interface WatchHistoryRecord {
  id: string;
  itemId: string;
  type: 'movie' | 'series';
  season?: number;
  episodeNumber?: number;
  episodeId?: string;
  episodeTitle?: string;
  episodeLabel: string;
  currentTime: number;
  duration: number;
  progressPercent: number;
  completed: boolean;
  selectedSourceId?: string;
  selectedSourceLabel?: string;
  selectedSourceUrl?: string;
  updatedAt: number;
  dismissedFromContinue?: boolean;
}

export interface PlaybackStartOptions {
  season?: number;
  episodeNumber?: number;
  episodeId?: string;
  episodeTitle?: string;
  episodeLabel?: string;
  streamUrl?: string;
  sources?: MediaSource[];
  preferredSourceId?: string;
  preferredSourceLabel?: string;
  preferredSourceUrl?: string;
}

export interface PlatformBrand {
  id: PlatformId;
  name: string;
  tagline: string;
  bgClass: string;
  textClass: string;
  accentClass: string;
  borderClass: string;
}

export interface LiveChannel {
  id: string;
  number: string;
  name: string;
  category: string;
  currentProgram: string;
  nextProgram: string;
  progressPercent: number;
  backdropImage: string;
  logoImage?: string;
  tvgId?: string;
  streamUrl?: string;
}

export interface RadioStation {
  id: string;
  frequency: string;
  name: string;
  genre: string;
  currentTrack: string;
  artist: string;
  accentHex: string;
  logoImage?: string;
  streamUrl?: string;
}

export interface AppSettings {
  key: 'config';
  tmdbApiKey: string;
  youtubeApiKey: string;
  streamProxyPrefix: string;
  autoProxyHttpStreams?: boolean;
  epgUrl: string;
  epgLastUpdated?: number;
  batchSize: number;
  probeTimeoutMs: number;
  userName: string;
  userEmail: string;
  isLoggedIn: boolean;
}

export interface UserLibraryState {
  key: 'state';
  myListIds: string[];
  continueWatching: ContinueWatchingEntry[];
  dismissedContinueIds?: string[];
}

export interface XtreamCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

export interface M3uListRecord {
  id: string;
  name: string;
  sourceType: 'file' | 'url' | 'json' | 'xtream' | 'sample';
  sourceLocation?: string;
  xtreamCredentials?: XtreamCredentials;
  importedAt: number;
  totalEntries: number;
  newItemsCreated: number;
  mergedSourcesCount: number;
  ignoredDuplicatesCount: number;
}
