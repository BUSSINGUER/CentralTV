import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const works = pgTable(
  'works',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // 'movie' | 'series' | 'live' | 'radio'
    tmdbId: integer('tmdb_id'),
    provisionalKey: text('provisional_key').notNull(),
    title: text('title').notNull(),
    originalTitle: text('original_title'),
    stylizedSubtitle: text('stylized_subtitle'),
    year: integer('year'),
    tvgId: text('tvg_id'),
    tvgName: text('tvg_name'),
    groupTitle: text('group_title'),
    status: text('status').notNull().default('pendente'),
    archived: boolean('archived').notNull().default(false),
    healthChecked: boolean('health_checked').notNull().default(false),
    featuredInHero: boolean('featured_in_hero').notNull().default(false),
    top10Rank: integer('top10_rank'),
    categoriesJson: text('categories_json').notNull().default('["populares"]'),
    lastError: text('last_error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('works_type_status_archived_idx').on(
      table.type,
      table.status,
      table.archived
    ),
    index('works_tmdb_type_idx').on(table.tmdbId, table.type),
    index('works_provisional_key_idx').on(table.provisionalKey),
  ]
);

export const workMetadata = pgTable('work_metadata', {
  workId: text('work_id')
    .primaryKey()
    .references(() => works.id, { onDelete: 'cascade' }),
  synopsis: text('synopsis').notNull().default(''),
  genresJson: text('genres_json').notNull().default('[]'),
  castJson: text('cast_json').notNull().default('[]'),
  director: text('director').notNull().default(''),
  ageRating: text('age_rating').notNull().default('14'),
  duration: text('duration').notNull().default(''),
  durationSeconds: integer('duration_seconds').notNull().default(7200),
  platform: text('platform').notNull().default('netflix'),
  qualityBadge: text('quality_badge'),
  voteAverage: real('vote_average'),
  posterImage: text('poster_image').notNull().default(''),
  backdropImage: text('backdrop_image').notNull().default(''),
  tvgLogo: text('tvg_logo'),
  accentColor: text('accent_color'),
  youtubeTrailerId: text('youtube_trailer_id').notNull().default(''),
  tmdbEnriched: boolean('tmdb_enriched').notNull().default(false),
  youtubeEnriched: boolean('youtube_enriched').notNull().default(false),
  enrichedAt: bigint('enriched_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const seasons = pgTable(
  'seasons',
  {
    id: text('id').primaryKey(),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number').notNull(),
    title: text('title'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('seasons_work_season_uidx').on(table.workId, table.seasonNumber),
  ]
);

export const episodes = pgTable(
  'episodes',
  {
    id: text('id').primaryKey(),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number').notNull(),
    episodeNumber: integer('episode_number').notNull(),
    externalEpisodeId: text('external_episode_id').notNull(),
    title: text('title').notNull(),
    duration: text('duration'),
    synopsis: text('synopsis'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('episodes_work_season_ep_uidx').on(
      table.workId,
      table.seasonNumber,
      table.episodeNumber
    ),
  ]
);

export const servers = pgTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull().unique(),
  serverType: text('server_type').notNull().default('m3u'),
  username: text('username'),
  password: text('password'),
  lastSyncAt: bigint('last_sync_at', { mode: 'number' }),
  lastSyncStatus: text('last_sync_status').notNull().default('untested'),
  itemCount: integer('item_count').notNull().default(0),
  syncReason: text('sync_reason'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const lists = pgTable('lists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull(), // 'file' | 'url' | 'json' | 'xtream' | 'sample'
  sourceLocation: text('source_location'),
  serverId: text('server_id').references(() => servers.id, {
    onDelete: 'set null',
  }),
  xtreamServerUrl: text('xtream_server_url'),
  xtreamUsername: text('xtream_username'),
  xtreamPassword: text('xtream_password'),
  importedAt: bigint('imported_at', { mode: 'number' }).notNull(),
  totalEntries: integer('total_entries').notNull().default(0),
  newItemsCreated: integer('new_items_created').notNull().default(0),
  mergedSourcesCount: integer('merged_sources_count').notNull().default(0),
  ignoredDuplicatesCount: integer('ignored_duplicates_count')
    .notNull()
    .default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const sources = pgTable(
  'sources',
  {
    id: text('id').primaryKey(),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    episodeId: text('episode_id').references(() => episodes.id, {
      onDelete: 'cascade',
    }),
    listId: text('list_id').references(() => lists.id, {
      onDelete: 'cascade',
    }),
    serverId: text('server_id').references(() => servers.id, {
      onDelete: 'set null',
    }),
    label: text('label').notNull(),
    qualityTag: text('quality_tag'),
    resolutionTag: text('resolution_tag'),
    languageTag: text('language_tag'),
    originalName: text('original_name'),
    url: text('url').notNull(),
    resolvedUrl: text('resolved_url'),
    detectedFormat: text('detected_format'),
    groupTitle: text('group_title'),
    tvgId: text('tvg_id'),
    priorityOrder: integer('priority_order').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('sources_work_idx').on(table.workId),
    index('sources_episode_idx').on(table.episodeId),
    index('sources_list_idx').on(table.listId),
  ]
);

export const sourceAvailability = pgTable('source_availability', {
  sourceId: text('source_id')
    .primaryKey()
    .references(() => sources.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  validationState: text('validation_state').notNull().default('unverified'),
  httpStatus: integer('http_status'),
  latencyMs: integer('latency_ms'),
  reason: text('reason'),
  lastCheckedAt: bigint('last_checked_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const userFavorites = pgTable(
  'user_favorites',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('user_favorites_uid_work_uidx').on(table.userUid, table.workId),
  ]
);

export const watchHistory = pgTable(
  'watch_history',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    historyKey: text('history_key').notNull(),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    episodeId: text('episode_id').references(() => episodes.id, {
      onDelete: 'set null',
    }),
    type: text('type').notNull(),
    season: integer('season'),
    episodeNumber: integer('episode_number'),
    episodeExternalId: text('episode_external_id'),
    episodeTitle: text('episode_title'),
    episodeLabel: text('episode_label').notNull(),
    currentTime: integer('current_time').notNull().default(0),
    duration: integer('duration').notNull().default(0),
    progressPercent: integer('progress_percent').notNull().default(0),
    completed: boolean('completed').notNull().default(false),
    selectedSourceId: text('selected_source_id'),
    selectedSourceLabel: text('selected_source_label'),
    selectedSourceUrl: text('selected_source_url'),
    dismissedFromContinue: boolean('dismissed_from_continue')
      .notNull()
      .default(false),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('watch_history_uid_key_uidx').on(table.userUid, table.historyKey),
    index('watch_history_uid_updated_idx').on(table.userUid, table.updatedAt),
  ]
);

export const migrationBackups = pgTable(
  'migration_backups',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    source: text('source').notNull().default('indexeddb_auto'),
    status: text('status').notNull().default('completed'),
    snapshotJson: text('snapshot_json').notNull(),
    summaryJson: text('summary_json').notNull(),
    createdWorkIdsJson: text('created_work_ids_json').notNull().default('[]'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    rolledBackAt: bigint('rolled_back_at', { mode: 'number' }),
  },
  (table) => [index('migration_backups_uid_idx').on(table.userUid)]
);

export const processingTasks = pgTable(
  'processing_tasks',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    scope: text('scope').notNull(), // 'all_pending' | 'list'
    listId: text('list_id'),
    listName: text('list_name'),
    status: text('status').notNull().default('queued'), // 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
    dedupeKey: text('dedupe_key').notNull(),
    targetWorkIdsJson: text('target_work_ids_json').notNull().default('[]'),
    cursorIndex: integer('cursor_index').notNull().default(0),
    totalItems: integer('total_items').notNull().default(0),
    processedItems: integer('processed_items').notNull().default(0),
    approvedCount: integer('approved_count').notNull().default(0),
    pendingBlockedCount: integer('pending_blocked_count').notNull().default(0),
    offlineCount: integer('offline_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    currentWorkId: text('current_work_id'),
    currentTitle: text('current_title').notNull().default(''),
    currentStage: text('current_stage').notNull().default('health'),
    lastNote: text('last_note'),
    settingsJson: text('settings_json').notNull().default('{}'),
    errorMessage: text('error_message'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    startedAt: bigint('started_at', { mode: 'number' }),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    finishedAt: bigint('finished_at', { mode: 'number' }),
  },
  (table) => [
    index('processing_tasks_status_created_idx').on(table.status, table.createdAt),
    index('processing_tasks_uid_created_idx').on(table.userUid, table.createdAt),
    index('processing_tasks_dedupe_idx').on(table.dedupeKey),
  ]
);

export const worksRelations = relations(works, ({ one, many }) => ({
  metadata: one(workMetadata, {
    fields: [works.id],
    references: [workMetadata.workId],
  }),
  seasons: many(seasons),
  episodes: many(episodes),
  sources: many(sources),
  favorites: many(userFavorites),
  watchHistory: many(watchHistory),
}));

export const workMetadataRelations = relations(workMetadata, ({ one }) => ({
  work: one(works, {
    fields: [workMetadata.workId],
    references: [works.id],
  }),
}));

export const seasonsRelations = relations(seasons, ({ one, many }) => ({
  work: one(works, {
    fields: [seasons.workId],
    references: [works.id],
  }),
  episodes: many(episodes),
}));

export const episodesRelations = relations(episodes, ({ one, many }) => ({
  work: one(works, {
    fields: [episodes.workId],
    references: [works.id],
  }),
  season: one(seasons, {
    fields: [episodes.seasonId],
    references: [seasons.id],
  }),
  sources: many(sources),
}));

export const serversRelations = relations(servers, ({ many }) => ({
  lists: many(lists),
  sources: many(sources),
}));

export const listsRelations = relations(lists, ({ one, many }) => ({
  server: one(servers, {
    fields: [lists.serverId],
    references: [servers.id],
  }),
  sources: many(sources),
}));

export const sourcesRelations = relations(sources, ({ one }) => ({
  work: one(works, {
    fields: [sources.workId],
    references: [works.id],
  }),
  episode: one(episodes, {
    fields: [sources.episodeId],
    references: [episodes.id],
  }),
  list: one(lists, {
    fields: [sources.listId],
    references: [lists.id],
  }),
  server: one(servers, {
    fields: [sources.serverId],
    references: [servers.id],
  }),
  availability: one(sourceAvailability, {
    fields: [sources.id],
    references: [sourceAvailability.sourceId],
  }),
}));

export const sourceAvailabilityRelations = relations(
  sourceAvailability,
  ({ one }) => ({
    source: one(sources, {
      fields: [sourceAvailability.sourceId],
      references: [sources.id],
    }),
  })
);

export const usersRelations = relations(users, ({ many }) => ({
  favorites: many(userFavorites),
  watchHistory: many(watchHistory),
  migrationBackups: many(migrationBackups),
  processingTasks: many(processingTasks),
}));

export const processingTasksRelations = relations(processingTasks, ({ one }) => ({
  user: one(users, {
    fields: [processingTasks.userUid],
    references: [users.uid],
  }),
}));

export const userFavoritesRelations = relations(userFavorites, ({ one }) => ({
  user: one(users, {
    fields: [userFavorites.userUid],
    references: [users.uid],
  }),
  work: one(works, {
    fields: [userFavorites.workId],
    references: [works.id],
  }),
}));

export const watchHistoryRelations = relations(watchHistory, ({ one }) => ({
  user: one(users, {
    fields: [watchHistory.userUid],
    references: [users.uid],
  }),
  work: one(works, {
    fields: [watchHistory.workId],
    references: [works.id],
  }),
  episode: one(episodes, {
    fields: [watchHistory.episodeId],
    references: [episodes.id],
  }),
}));
