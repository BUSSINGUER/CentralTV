import crypto from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  CatalogItem,
  MediaFormatBadge,
  MediaKind,
  MediaSource,
  M3uListRecord,
  PlatformId,
  PublishStatus,
  SeriesEpisode,
  SourceValidationState,
  WatchHistoryRecord,
} from '../types/streaming.ts';
import {
  buildProvisionalKey,
  cleanTitleAndExtractYear,
  extractServerOrigin,
  getCandidateProvisionalKeys,
  sortAndRelabelSourcesList,
} from '../utils/identity.ts';
import { pgDb, executeWithDbRetry } from './index.ts';
import {
  episodes,
  lists,
  migrationBackups,
  seasons,
  servers,
  sourceAvailability,
  sources,
  userFavorites,
  watchHistory,
  workMetadata,
  works,
} from './schema.ts';

type DbExecutor = typeof pgDb | Parameters<Parameters<typeof pgDb.transaction>[0]>[0];

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function buildDeterministicServerId(baseUrl: string): string {
  const digest = crypto
    .createHash('sha1')
    .update(baseUrl.toLowerCase())
    .digest('hex')
    .slice(0, 12);
  return `srv-${digest}`;
}

async function ensureServer(
  tx: DbExecutor,
  rawUrl: string | null | undefined,
  serverType: 'm3u' | 'xtream' | 'json' | 'cdn',
  now: number,
  createdServerIds?: string[]
): Promise<string | null> {
  const origin = extractServerOrigin(rawUrl);
  if (!origin) return null;

  const existing = await tx
    .select()
    .from(servers)
    .where(eq(servers.baseUrl, origin.baseUrl))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  const id = buildDeterministicServerId(origin.baseUrl);
  await tx
    .insert(servers)
    .values({
      id,
      name: origin.name,
      baseUrl: origin.baseUrl,
      serverType,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: servers.baseUrl });

  const reread = await tx
    .select()
    .from(servers)
    .where(eq(servers.baseUrl, origin.baseUrl))
    .limit(1);

  if (reread.length > 0) {
    if (createdServerIds && reread[0].id === id) {
      createdServerIds.push(id);
    }
    return reread[0].id;
  }
  return null;
}

function extractValidYear(
  item: Pick<CatalogItem, 'year' | 'normalizedKey' | 'tmdbEnriched' | 'originalTitle' | 'title'>
): number | null {
  if (item.tmdbEnriched) {
    return typeof item.year === 'number' && item.year >= 1900 && item.year <= 2035
      ? item.year
      : null;
  }
  if (item.normalizedKey && item.normalizedKey.endsWith('::unyeared')) {
    return null;
  }
  if (item.originalTitle) {
    const origYear = cleanTitleAndExtractYear(item.originalTitle).year;
    if (typeof origYear === 'number' && origYear >= 1900 && origYear <= 2035) {
      return origYear;
    }
    return null;
  }
  if (typeof item.year === 'number' && item.year >= 1900 && item.year <= 2035) {
    return item.year;
  }
  return null;
}

/**
 * Resolves an incoming item to an existing canonical work in PostgreSQL without merging unrelated works.
 * Order:
 * 1. Exact (tmdbId, type) match
 * 2. Strict provisional match: (type + normalizedTitle + exact year) — including archived works
 * 3. Exact ID match if same type
 */
async function resolveCanonicalWork(
  tx: DbExecutor,
  incoming: CatalogItem
): Promise<typeof works.$inferSelect | null> {
  const type = incoming.type;

  if (typeof incoming.tmdbId === 'number' && incoming.tmdbId > 0) {
    const byTmdb = await tx
      .select()
      .from(works)
      .where(and(eq(works.tmdbId, incoming.tmdbId), eq(works.type, type)))
      .limit(1);
    if (byTmdb.length > 0) {
      return byTmdb[0];
    }
  }

  const validYear = extractValidYear(incoming);
  const candidateKeys = getCandidateProvisionalKeys({
    type,
    title: incoming.title,
    originalTitle: incoming.originalTitle,
    year: validYear,
  });

  if (candidateKeys.length > 0) {
    const candidates = await tx
      .select()
      .from(works)
      .where(
        and(
          eq(works.type, type),
          inArray(works.provisionalKey, candidateKeys)
        )
      );

    for (const candidate of candidates) {
      if (type === 'live' || type === 'radio') {
        if (
          incoming.tvgId &&
          candidate.tvgId &&
          incoming.tvgId.trim().toLowerCase() !==
            candidate.tvgId.trim().toLowerCase()
        ) {
          continue;
        }
        return candidate;
      }

      // VOD strict check: never merge works with mismatched years or if TMDB IDs conflict
      if (
        typeof incoming.tmdbId === 'number' &&
        typeof candidate.tmdbId === 'number' &&
        incoming.tmdbId !== candidate.tmdbId
      ) {
        continue;
      }
      const candYear = candidate.year ?? null;
      const incYear = validYear ?? null;
      if (candYear === incYear) {
        return candidate;
      }
    }
  }

  if (incoming.id) {
    const byId = await tx
      .select()
      .from(works)
      .where(eq(works.id, incoming.id))
      .limit(1);
    if (byId.length > 0 && byId[0].type === type) {
      if (
        typeof incoming.tmdbId === 'number' &&
        typeof byId[0].tmdbId === 'number' &&
        incoming.tmdbId !== byId[0].tmdbId
      ) {
        return null;
      }
      return byId[0];
    }
  }

  return null;
}

function hydrateCatalogItem(
  w: typeof works.$inferSelect,
  meta: typeof workMetadata.$inferSelect | undefined,
  itemSources: Array<{
    source: typeof sources.$inferSelect;
    availability?: typeof sourceAvailability.$inferSelect;
  }>,
  itemEpisodes: Array<{
    episode: typeof episodes.$inferSelect;
    sources: Array<{
      source: typeof sources.$inferSelect;
      availability?: typeof sourceAvailability.$inferSelect;
    }>;
  }>
): CatalogItem {
  const toMediaSource = (row: {
    source: typeof sources.$inferSelect;
    availability?: typeof sourceAvailability.$inferSelect;
  }): MediaSource => ({
    id: row.source.id,
    label: row.source.label,
    qualityTag: row.source.qualityTag ?? undefined,
    resolutionTag: row.source.resolutionTag ?? undefined,
    languageTag: row.source.languageTag ?? undefined,
    originalName: row.source.originalName ?? undefined,
    url: row.source.url,
    resolvedUrl: row.source.resolvedUrl ?? undefined,
    detectedFormat: row.source.detectedFormat ?? undefined,
    listId: row.source.listId ?? undefined,
    groupTitle: row.source.groupTitle ?? undefined,
    tvgId: row.source.tvgId ?? undefined,
    status: (row.availability?.status as MediaSource['status']) || 'pending',
    validationState:
      (row.availability?.validationState as SourceValidationState) ||
      'unverified',
    httpStatus: row.availability?.httpStatus ?? undefined,
    latencyMs: row.availability?.latencyMs ?? undefined,
    reason: row.availability?.reason ?? undefined,
    lastCheckedAt: row.availability?.lastCheckedAt ?? undefined,
  });

  const sortedSources = sortAndRelabelSourcesList(itemSources.map(toMediaSource));

  const hydratedEpisodes: SeriesEpisode[] | undefined =
    w.type === 'series'
      ? itemEpisodes
          .sort((a, b) =>
            a.episode.seasonNumber !== b.episode.seasonNumber
              ? a.episode.seasonNumber - b.episode.seasonNumber
              : a.episode.episodeNumber - b.episode.episodeNumber
          )
          .map((epRow) => ({
            id: epRow.episode.externalEpisodeId,
            season: epRow.episode.seasonNumber,
            episode: epRow.episode.episodeNumber,
            title: epRow.episode.title,
            duration: epRow.episode.duration ?? undefined,
            synopsis: epRow.episode.synopsis ?? undefined,
            sources: sortAndRelabelSourcesList(
              epRow.sources.map(toMediaSource)
            ),
          }))
      : undefined;

  return {
    id: w.id,
    title: w.title,
    stylizedSubtitle: w.stylizedSubtitle ?? undefined,
    type: w.type as MediaKind,
    mediaKind: w.type as MediaKind,
    year: w.year ?? new Date().getFullYear(),
    genres: safeJsonParse<string[]>(meta?.genresJson, [w.type.toUpperCase()]),
    ageRating: (meta?.ageRating as CatalogItem['ageRating']) || '14',
    duration: meta?.duration || (w.type === 'series' ? '1 Temporada' : '2h 00min'),
    durationSeconds: meta?.durationSeconds ?? (w.type === 'series' ? 3000 : 7200),
    platform: (meta?.platform as PlatformId) || 'netflix',
    qualityBadge: (meta?.qualityBadge as MediaFormatBadge) || undefined,
    synopsis: meta?.synopsis || '',
    cast: safeJsonParse<string[]>(meta?.castJson, []),
    director: meta?.director || '',
    youtubeTrailerId: meta?.youtubeTrailerId || '',
    posterImage: meta?.posterImage || '',
    backdropImage: meta?.backdropImage || '',
    accentColor: meta?.accentColor ?? undefined,
    featuredInHero: w.featuredInHero,
    top10Rank: w.top10Rank ?? undefined,
    categories: safeJsonParse<string[]>(w.categoriesJson, ['populares']),
    normalizedKey: w.provisionalKey,
    originalTitle: w.originalTitle ?? undefined,
    tvgId: w.tvgId ?? undefined,
    tvgName: w.tvgName ?? undefined,
    groupTitle: w.groupTitle ?? undefined,
    tvgLogo: meta?.tvgLogo ?? undefined,
    voteAverage: meta?.voteAverage ?? undefined,
    tmdbId: w.tmdbId ?? undefined,
    sources: sortedSources,
    episodes: hydratedEpisodes,
    status: w.status as PublishStatus,
    healthChecked: w.healthChecked,
    tmdbEnriched: meta?.tmdbEnriched ?? false,
    youtubeEnriched: meta?.youtubeEnriched ?? false,
    lastError: w.lastError ?? undefined,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    archived: w.archived,
  };
}

export async function listWorksFromPostgres(options?: {
  includeArchived?: boolean;
  status?: PublishStatus;
}): Promise<CatalogItem[]> {
  try {
    const workRows = await pgDb
      .select()
      .from(works)
      .orderBy(desc(works.createdAt));

    const filteredWorks = workRows.filter((w) => {
      if (!options?.includeArchived && w.archived) return false;
      if (options?.status && w.status !== options.status) return false;
      return true;
    });

    if (filteredWorks.length === 0) return [];

    const workIds = filteredWorks.map((w) => w.id);

    const [metaRows, epRows, srcRows] = await Promise.all([
      pgDb
        .select()
        .from(workMetadata)
        .where(inArray(workMetadata.workId, workIds)),
      pgDb
        .select()
        .from(episodes)
        .where(inArray(episodes.workId, workIds)),
      pgDb
        .select()
        .from(sources)
        .where(inArray(sources.workId, workIds)),
    ]);

    const srcIds = srcRows.map((s) => s.id);
    const availRows =
      srcIds.length > 0
        ? await pgDb
            .select()
            .from(sourceAvailability)
            .where(inArray(sourceAvailability.sourceId, srcIds))
        : [];

    const metaByWork = new Map(metaRows.map((m) => [m.workId, m]));
    const availBySrc = new Map(availRows.map((a) => [a.sourceId, a]));

    const workSourcesMap = new Map<
      string,
      Array<{
        source: typeof sources.$inferSelect;
        availability?: typeof sourceAvailability.$inferSelect;
      }>
    >();
    const epSourcesMap = new Map<
      string,
      Array<{
        source: typeof sources.$inferSelect;
        availability?: typeof sourceAvailability.$inferSelect;
      }>
    >();

    for (const s of srcRows) {
      const bundle = { source: s, availability: availBySrc.get(s.id) };
      if (s.episodeId) {
        const list = epSourcesMap.get(s.episodeId) || [];
        list.push(bundle);
        epSourcesMap.set(s.episodeId, list);
      } else {
        const list = workSourcesMap.get(s.workId) || [];
        list.push(bundle);
        workSourcesMap.set(s.workId, list);
      }
    }

    const epByWork = new Map<
      string,
      Array<{
        episode: typeof episodes.$inferSelect;
        sources: Array<{
          source: typeof sources.$inferSelect;
          availability?: typeof sourceAvailability.$inferSelect;
        }>;
      }>
    >();

    for (const ep of epRows) {
      const list = epByWork.get(ep.workId) || [];
      list.push({
        episode: ep,
        sources: epSourcesMap.get(ep.id) || [],
      });
      epByWork.set(ep.workId, list);
    }

    return filteredWorks.map((w) =>
      hydrateCatalogItem(
        w,
        metaByWork.get(w.id),
        workSourcesMap.get(w.id) || [],
        epByWork.get(w.id) || []
      )
    );
  } catch (error) {
    console.error('Failed to query works from PostgreSQL:', error);
    throw new Error('Falha ao carregar acervo persistente.', { cause: error });
  }
}

export async function listListsFromPostgres(): Promise<M3uListRecord[]> {
  try {
    const rows = await pgDb
      .select()
      .from(lists)
      .orderBy(desc(lists.importedAt));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sourceType: r.sourceType as M3uListRecord['sourceType'],
      sourceLocation: r.sourceLocation ?? undefined,
      xtreamCredentials:
        r.xtreamServerUrl && r.xtreamUsername && r.xtreamPassword
          ? {
              serverUrl: r.xtreamServerUrl,
              username: r.xtreamUsername,
              password: r.xtreamPassword,
            }
          : undefined,
      importedAt: r.importedAt,
      totalEntries: r.totalEntries,
      newItemsCreated: r.newItemsCreated,
      mergedSourcesCount: r.mergedSourcesCount,
      ignoredDuplicatesCount: r.ignoredDuplicatesCount,
    }));
  } catch (error) {
    console.error('Failed to load lists from PostgreSQL:', error);
    throw new Error('Falha ao carregar listas cadastradas.', { cause: error });
  }
}

export async function upsertListRecordToPostgres(
  tx: DbExecutor,
  record: M3uListRecord,
  now = Date.now(),
  createdListIds?: string[],
  createdServerIds?: string[]
): Promise<void> {
  const originHint =
    record.xtreamCredentials?.serverUrl || record.sourceLocation || null;
  const serverType =
    record.sourceType === 'xtream'
      ? 'xtream'
      : record.sourceType === 'json'
        ? 'json'
        : 'm3u';
  const serverId = originHint
    ? await ensureServer(tx, originHint, serverType, now, createdServerIds)
    : null;

  const existing = await tx
    .select()
    .from(lists)
    .where(eq(lists.id, record.id))
    .limit(1);

  if (existing.length === 0) {
    await tx.insert(lists).values({
      id: record.id,
      name: record.name,
      sourceType: record.sourceType,
      sourceLocation: record.sourceLocation ?? null,
      serverId,
      xtreamServerUrl: record.xtreamCredentials?.serverUrl ?? null,
      xtreamUsername: record.xtreamCredentials?.username ?? null,
      xtreamPassword: record.xtreamCredentials?.password ?? null,
      importedAt: record.importedAt || now,
      totalEntries: record.totalEntries || 0,
      newItemsCreated: record.newItemsCreated || 0,
      mergedSourcesCount: record.mergedSourcesCount || 0,
      ignoredDuplicatesCount: record.ignoredDuplicatesCount || 0,
      updatedAt: now,
    });
    createdListIds?.push(record.id);
  } else {
    await tx
      .update(lists)
      .set({
        name: record.name,
        sourceType: record.sourceType,
        sourceLocation: record.sourceLocation ?? existing[0].sourceLocation,
        serverId: serverId ?? existing[0].serverId,
        importedAt: record.importedAt || existing[0].importedAt,
        totalEntries: record.totalEntries,
        newItemsCreated: record.newItemsCreated,
        mergedSourcesCount: record.mergedSourcesCount,
        ignoredDuplicatesCount: record.ignoredDuplicatesCount,
        updatedAt: now,
      })
      .where(eq(lists.id, record.id));
  }
}

async function upsertSourceRow(
  tx: DbExecutor,
  params: {
    workId: string;
    episodeId: string | null;
    src: MediaSource;
    priorityOrder: number;
    now: number;
    preserveExistingAvailability: boolean;
    createdSourceIds?: string[];
    createdServerIds?: string[];
  }
): Promise<void> {
  const {
    workId,
    episodeId,
    src,
    priorityOrder,
    now,
    preserveExistingAvailability,
    createdSourceIds,
    createdServerIds,
  } = params;

  const serverId = await ensureServer(
    tx,
    src.url,
    'cdn',
    now,
    createdServerIds
  );

  let validListId: string | null = null;
  if (src.listId) {
    const listFound = await tx
      .select({ id: lists.id })
      .from(lists)
      .where(eq(lists.id, src.listId))
      .limit(1);
    if (listFound.length > 0) {
      validListId = listFound[0].id;
    }
  }

  const existingByWorkUrl = await tx
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.workId, workId),
        eq(sources.url, src.url)
      )
    );

  const exactMatch =
    existingByWorkUrl.find(
      (s) =>
        (s.episodeId ?? null) === episodeId &&
        (s.listId ?? null) === validListId
    ) ||
    existingByWorkUrl.find(
      (s) => (s.episodeId ?? null) === episodeId && s.listId === null
    );

  let sourceId = exactMatch?.id || '';
  if (!sourceId) {
    if (src.id) {
      const idTaken = await tx
        .select({ id: sources.id, workId: sources.workId })
        .from(sources)
        .where(eq(sources.id, src.id))
        .limit(1);
      sourceId =
        idTaken.length === 0 || idTaken[0].workId === workId
          ? src.id
          : `src-${crypto.randomUUID().slice(0, 12)}`;
    } else {
      sourceId = `src-${crypto.randomUUID().slice(0, 12)}`;
    }
  }

  if (!exactMatch) {
    await tx
      .insert(sources)
      .values({
        id: sourceId,
        workId,
        episodeId,
        listId: validListId,
        serverId,
        label: src.label,
        qualityTag: src.qualityTag ?? null,
        resolutionTag: src.resolutionTag ?? null,
        languageTag: src.languageTag ?? null,
        originalName: src.originalName ?? null,
        url: src.url,
        resolvedUrl: src.resolvedUrl ?? null,
        detectedFormat: src.detectedFormat ?? null,
        groupTitle: src.groupTitle ?? null,
        tvgId: src.tvgId ?? null,
        priorityOrder,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          listId: validListId,
          serverId,
          label: src.label,
          qualityTag: src.qualityTag ?? null,
          resolutionTag: src.resolutionTag ?? null,
          languageTag: src.languageTag ?? null,
          resolvedUrl: src.resolvedUrl ?? null,
          detectedFormat: src.detectedFormat ?? null,
          priorityOrder,
          updatedAt: now,
        },
      });
    createdSourceIds?.push(sourceId);
  } else {
    await tx
      .update(sources)
      .set({
        listId: validListId ?? exactMatch.listId,
        serverId: serverId ?? exactMatch.serverId,
        label: src.label,
        qualityTag: src.qualityTag ?? exactMatch.qualityTag,
        resolutionTag: src.resolutionTag ?? exactMatch.resolutionTag,
        languageTag: src.languageTag ?? exactMatch.languageTag,
        resolvedUrl: src.resolvedUrl ?? exactMatch.resolvedUrl,
        detectedFormat: src.detectedFormat ?? exactMatch.detectedFormat,
        priorityOrder,
        updatedAt: now,
      })
      .where(eq(sources.id, sourceId));
  }

  const existingAvail = await tx
    .select()
    .from(sourceAvailability)
    .where(eq(sourceAvailability.sourceId, sourceId))
    .limit(1);

  if (existingAvail.length === 0) {
    await tx.insert(sourceAvailability).values({
      sourceId,
      status: src.status || 'pending',
      validationState: src.validationState || 'unverified',
      httpStatus: src.httpStatus ?? null,
      latencyMs: src.latencyMs ?? null,
      reason: src.reason ?? null,
      lastCheckedAt: src.lastCheckedAt ?? null,
      updatedAt: now,
    });
  } else if (!preserveExistingAvailability) {
    await tx
      .update(sourceAvailability)
      .set({
        status: src.status || existingAvail[0].status,
        validationState:
          src.validationState || existingAvail[0].validationState,
        httpStatus: src.httpStatus ?? existingAvail[0].httpStatus,
        latencyMs: src.latencyMs ?? existingAvail[0].latencyMs,
        reason: src.reason ?? existingAvail[0].reason,
        lastCheckedAt: src.lastCheckedAt ?? existingAvail[0].lastCheckedAt,
        updatedAt: now,
      })
      .where(eq(sourceAvailability.sourceId, sourceId));
  }
}

export interface UpsertWorkResult {
  workId: string;
  created: boolean;
  reactivated: boolean;
}

export async function upsertWorkInsideTx(
  tx: DbExecutor,
  incoming: CatalogItem,
  options: {
    mergeWithoutOverwrite: boolean;
    preserveAvailability: boolean;
    now: number;
    createdWorkIds?: string[];
    createdSeasonIds?: string[];
    createdEpisodeIds?: string[];
    createdSourceIds?: string[];
    createdServerIds?: string[];
  }
): Promise<UpsertWorkResult> {
  const {
    mergeWithoutOverwrite,
    preserveAvailability,
    now,
    createdWorkIds,
    createdSeasonIds,
    createdEpisodeIds,
    createdSourceIds,
    createdServerIds,
  } = options;

  const existingWork = await resolveCanonicalWork(tx, incoming);
  const validYear = extractValidYear(incoming);
  const provisionalKey =
    incoming.normalizedKey && !incoming.normalizedKey.includes('::tmdb::')
      ? incoming.normalizedKey
      : buildProvisionalKey({
          type: incoming.type,
          title: incoming.originalTitle || incoming.title,
          originalTitle: incoming.originalTitle,
          year: validYear,
        });

  if (!existingWork) {
    const workId = incoming.id || `work-${crypto.randomUUID().slice(0, 12)}`;
    const hasIncomingSources =
      (incoming.sources?.length ?? 0) > 0 ||
      (incoming.episodes?.some((ep) => (ep.sources?.length ?? 0) > 0) ?? false);

    await tx.insert(works).values({
      id: workId,
      type: incoming.type,
      tmdbId: incoming.tmdbId ?? null,
      provisionalKey,
      title: incoming.title,
      originalTitle: incoming.originalTitle ?? null,
      stylizedSubtitle: incoming.stylizedSubtitle ?? null,
      year: validYear,
      tvgId: incoming.tvgId ?? null,
      tvgName: incoming.tvgName ?? null,
      groupTitle: incoming.groupTitle ?? null,
      status: incoming.status || 'pendente',
      archived: incoming.archived ?? !hasIncomingSources,
      healthChecked: Boolean(incoming.healthChecked),
      featuredInHero: Boolean(incoming.featuredInHero),
      top10Rank: incoming.top10Rank ?? null,
      categoriesJson: JSON.stringify(incoming.categories || ['populares']),
      lastError: incoming.lastError ?? null,
      createdAt: incoming.createdAt || now,
      updatedAt: incoming.updatedAt || now,
    });
    createdWorkIds?.push(workId);

    await tx.insert(workMetadata).values({
      workId,
      synopsis: incoming.synopsis || '',
      genresJson: JSON.stringify(incoming.genres || []),
      castJson: JSON.stringify(incoming.cast || []),
      director: incoming.director || '',
      ageRating: incoming.ageRating || '14',
      duration: incoming.duration || '',
      durationSeconds: incoming.durationSeconds || 7200,
      platform: incoming.platform || 'netflix',
      qualityBadge: incoming.qualityBadge ?? null,
      voteAverage: incoming.voteAverage ?? null,
      posterImage: incoming.posterImage || '',
      backdropImage: incoming.backdropImage || '',
      tvgLogo: incoming.tvgLogo ?? null,
      accentColor: incoming.accentColor ?? null,
      youtubeTrailerId: incoming.youtubeTrailerId || '',
      tmdbEnriched: Boolean(incoming.tmdbEnriched),
      youtubeEnriched: Boolean(incoming.youtubeEnriched),
      enrichedAt: incoming.tmdbEnriched ? now : null,
      updatedAt: incoming.updatedAt || now,
    });

    const sortedRootSources = sortAndRelabelSourcesList(incoming.sources || []);
    for (let i = 0; i < sortedRootSources.length; i++) {
      await upsertSourceRow(tx, {
        workId,
        episodeId: null,
        src: sortedRootSources[i],
        priorityOrder: i,
        now,
        preserveExistingAvailability: false,
        createdSourceIds,
        createdServerIds,
      });
    }

    if (incoming.type === 'series' && incoming.episodes) {
      for (const ep of incoming.episodes) {
        const sNum = ep.season || 1;
        const seasonId = `${workId}::S${sNum}`;
        await tx
          .insert(seasons)
          .values({
            id: seasonId,
            workId,
            seasonNumber: sNum,
            title: `Temporada ${sNum}`,
            createdAt: now,
          })
          .onConflictDoNothing({ target: [seasons.workId, seasons.seasonNumber] });
        createdSeasonIds?.push(seasonId);

        const epDbId = `${workId}::S${sNum}::E${ep.episode}`;
        await tx
          .insert(episodes)
          .values({
            id: epDbId,
            workId,
            seasonId,
            seasonNumber: sNum,
            episodeNumber: ep.episode,
            externalEpisodeId: ep.id || `s${sNum}e${ep.episode}`,
            title: ep.title,
            duration: ep.duration ?? null,
            synopsis: ep.synopsis ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [episodes.workId, episodes.seasonNumber, episodes.episodeNumber],
          });
        createdEpisodeIds?.push(epDbId);

        const sortedEpSources = sortAndRelabelSourcesList(ep.sources || []);
        for (let j = 0; j < sortedEpSources.length; j++) {
          await upsertSourceRow(tx, {
            workId,
            episodeId: epDbId,
            src: sortedEpSources[j],
            priorityOrder: j,
            now,
            preserveExistingAvailability: false,
            createdSourceIds,
            createdServerIds,
          });
        }
      }
    }

    return { workId, created: true, reactivated: false };
  }

  // Existing canonical work found -> preserve its stable ID!
  const workId = existingWork.id;
  const wasArchived = existingWork.archived;

  const existingMetaRows = await tx
    .select()
    .from(workMetadata)
    .where(eq(workMetadata.workId, workId))
    .limit(1);
  const existingMeta = existingMetaRows[0];

  const hasIncomingSources =
    (incoming.sources?.length ?? 0) > 0 ||
    (incoming.episodes?.some((ep) => (ep.sources?.length ?? 0) > 0) ?? false);

  const shouldOverwriteFields = !mergeWithoutOverwrite;

  const nextStatus: PublishStatus =
    existingWork.status === 'publicado'
      ? 'publicado'
      : incoming.status === 'publicado'
        ? 'publicado'
        : existingWork.status === 'aprovado' && incoming.status === 'pendente'
          ? 'aprovado'
          : shouldOverwriteFields
            ? incoming.status || (existingWork.status as PublishStatus)
            : (existingWork.status as PublishStatus);

  const nextTmdbId = existingWork.tmdbId ?? incoming.tmdbId ?? null;

  const keepExistingTmdb =
    Boolean(existingMeta?.tmdbEnriched) &&
    (mergeWithoutOverwrite || !incoming.tmdbEnriched);

  await tx
    .update(works)
    .set({
      tmdbId: nextTmdbId,
      title: keepExistingTmdb
        ? existingWork.title
        : shouldOverwriteFields || !existingMeta?.tmdbEnriched
          ? incoming.title || existingWork.title
          : existingWork.title,
      year: existingWork.year ?? validYear,
      tvgId: existingWork.tvgId ?? incoming.tvgId ?? null,
      tvgName: existingWork.tvgName ?? incoming.tvgName ?? null,
      status: nextStatus,
      archived: hasIncomingSources ? false : existingWork.archived,
      healthChecked: existingWork.healthChecked || Boolean(incoming.healthChecked),
      lastError: shouldOverwriteFields
        ? incoming.lastError ?? null
        : existingWork.lastError,
      updatedAt: now,
    })
    .where(eq(works.id, workId));

  if (existingMeta) {
    await tx
      .update(workMetadata)
      .set({
        synopsis: keepExistingTmdb
          ? existingMeta.synopsis
          : incoming.synopsis || existingMeta.synopsis,
        genresJson: keepExistingTmdb
          ? existingMeta.genresJson
          : incoming.genres?.length
            ? JSON.stringify(incoming.genres)
            : existingMeta.genresJson,
        castJson: keepExistingTmdb
          ? existingMeta.castJson
          : incoming.cast?.length
            ? JSON.stringify(incoming.cast)
            : existingMeta.castJson,
        director: keepExistingTmdb
          ? existingMeta.director
          : incoming.director || existingMeta.director,
        duration: keepExistingTmdb
          ? existingMeta.duration
          : incoming.duration || existingMeta.duration,
        durationSeconds: keepExistingTmdb
          ? existingMeta.durationSeconds
          : incoming.durationSeconds || existingMeta.durationSeconds,
        platform: shouldOverwriteFields
          ? incoming.platform || existingMeta.platform
          : existingMeta.platform,
        qualityBadge:
          incoming.qualityBadge === '4K'
            ? '4K'
            : existingMeta.qualityBadge ?? incoming.qualityBadge ?? null,
        voteAverage: keepExistingTmdb
          ? existingMeta.voteAverage
          : incoming.voteAverage ?? existingMeta.voteAverage,
        posterImage: keepExistingTmdb
          ? existingMeta.posterImage
          : incoming.posterImage || existingMeta.posterImage,
        backdropImage: keepExistingTmdb
          ? existingMeta.backdropImage
          : incoming.backdropImage || existingMeta.backdropImage,
        tvgLogo: existingMeta.tvgLogo ?? incoming.tvgLogo ?? null,
        youtubeTrailerId:
          existingMeta.youtubeTrailerId || incoming.youtubeTrailerId || '',
        tmdbEnriched:
          existingMeta.tmdbEnriched || Boolean(incoming.tmdbEnriched),
        youtubeEnriched:
          existingMeta.youtubeEnriched ||
          Boolean(incoming.youtubeEnriched) ||
          Boolean(existingMeta.youtubeTrailerId || incoming.youtubeTrailerId),
        updatedAt: now,
      })
      .where(eq(workMetadata.workId, workId));
  }

  const sortedRootSources = sortAndRelabelSourcesList(incoming.sources || []);
  for (let i = 0; i < sortedRootSources.length; i++) {
    await upsertSourceRow(tx, {
      workId,
      episodeId: null,
      src: sortedRootSources[i],
      priorityOrder: i,
      now,
      preserveExistingAvailability: preserveAvailability,
      createdSourceIds,
      createdServerIds,
    });
  }

  if (incoming.type === 'series' && incoming.episodes) {
    for (const ep of incoming.episodes) {
      const sNum = ep.season || 1;
      const existingSeasons = await tx
        .select()
        .from(seasons)
        .where(and(eq(seasons.workId, workId), eq(seasons.seasonNumber, sNum)))
        .limit(1);

      let seasonId = existingSeasons[0]?.id;
      if (!seasonId) {
        seasonId = `${workId}::S${sNum}`;
        await tx.insert(seasons).values({
          id: seasonId,
          workId,
          seasonNumber: sNum,
          title: `Temporada ${sNum}`,
          createdAt: now,
        });
        createdSeasonIds?.push(seasonId);
      }

      const existingEps = await tx
        .select()
        .from(episodes)
        .where(
          and(
            eq(episodes.workId, workId),
            eq(episodes.seasonNumber, sNum),
            eq(episodes.episodeNumber, ep.episode)
          )
        )
        .limit(1);

      let epDbId = existingEps[0]?.id;
      if (!epDbId) {
        epDbId = `${workId}::S${sNum}::E${ep.episode}`;
        await tx.insert(episodes).values({
          id: epDbId,
          workId,
          seasonId,
          seasonNumber: sNum,
          episodeNumber: ep.episode,
          externalEpisodeId: ep.id || `s${sNum}e${ep.episode}`,
          title: ep.title,
          duration: ep.duration ?? null,
          synopsis: ep.synopsis ?? null,
          createdAt: now,
          updatedAt: now,
        });
        createdEpisodeIds?.push(epDbId);
      }

      const sortedEpSources = sortAndRelabelSourcesList(ep.sources || []);
      for (let j = 0; j < sortedEpSources.length; j++) {
        await upsertSourceRow(tx, {
          workId,
          episodeId: epDbId,
          src: sortedEpSources[j],
          priorityOrder: j,
          now,
          preserveExistingAvailability: preserveAvailability,
          createdSourceIds,
          createdServerIds,
        });
      }
    }
  }

  return {
    workId,
    created: false,
    reactivated: wasArchived && hasIncomingSources,
  };
}

export async function syncCatalogBatchToPostgres(params: {
  items: CatalogItem[];
  list?: M3uListRecord;
  mergeWithoutOverwrite?: boolean;
}): Promise<{
  idMap: Record<string, string>;
  createdCount: number;
  mergedCount: number;
  reactivatedCount: number;
}> {
  const now = Date.now();
  const idMap: Record<string, string> = {};
  let createdCount = 0;
  let mergedCount = 0;
  let reactivatedCount = 0;

  try {
    await executeWithDbRetry(() =>
      pgDb.transaction(async (tx) => {
        if (params.list) {
          await upsertListRecordToPostgres(tx, params.list, now);
        }

        for (const item of params.items) {
          const res = await upsertWorkInsideTx(tx, item, {
            mergeWithoutOverwrite: Boolean(params.mergeWithoutOverwrite),
            preserveAvailability: Boolean(params.mergeWithoutOverwrite),
            now,
          });
          if (item.id) {
            idMap[item.id] = res.workId;
          }
          if (res.created) createdCount += 1;
          else mergedCount += 1;
          if (res.reactivated) reactivatedCount += 1;
        }
      })
    );

    return { idMap, createdCount, mergedCount, reactivatedCount };
  } catch (error) {
    console.error('Failed to sync catalog batch to PostgreSQL:', error);
    throw new Error('Falha ao persistir alterações do catálogo.', {
      cause: error,
    });
  }
}

/**
 * Decoupled list deletion:
 * - Removes ONLY sources linked to `listId` and the `lists` row itself.
 * - Preserves `works`, `work_metadata`, `seasons`, `episodes`, `user_favorites`, and `watch_history`.
 * - Works that drop to 0 remaining sources are marked `archived = true` (reactivated automatically on re-import).
 */
export async function deleteListDecoupledFromPostgres(listId: string): Promise<{
  removedSources: number;
  updatedWorks: number;
  archivedWorks: number;
  archivedWorkIds: string[];
}> {
  const now = Date.now();

  try {
    return await executeWithDbRetry(() =>
      pgDb.transaction(async (tx) => {
      const listSources = await tx
        .select({
          id: sources.id,
          workId: sources.workId,
        })
        .from(sources)
        .where(eq(sources.listId, listId));

      const affectedWorkIds = Array.from(
        new Set(listSources.map((s) => s.workId))
      );

      if (listSources.length > 0) {
        await tx.delete(sources).where(eq(sources.listId, listId));
      }
      await tx.delete(lists).where(eq(lists.id, listId));

      let updatedWorks = 0;
      let archivedWorks = 0;
      const archivedWorkIds: string[] = [];

      for (const workId of affectedWorkIds) {
        const remaining = await tx
          .select()
          .from(sources)
          .where(eq(sources.workId, workId));

        if (remaining.length === 0) {
          await tx
            .update(works)
            .set({ archived: true, updatedAt: now })
            .where(eq(works.id, workId));
          archivedWorks += 1;
          archivedWorkIds.push(workId);
        } else {
          const has4k = remaining.some(
            (s) =>
              s.resolutionTag === '4K' ||
              (s.qualityTag || '').toUpperCase().includes('4K')
          );
          await tx
            .update(works)
            .set({ archived: false, updatedAt: now })
            .where(eq(works.id, workId));

          if (!has4k) {
            const meta = await tx
              .select({ qualityBadge: workMetadata.qualityBadge })
              .from(workMetadata)
              .where(eq(workMetadata.workId, workId))
              .limit(1);
            if (meta[0]?.qualityBadge === '4K') {
              await tx
                .update(workMetadata)
                .set({ qualityBadge: null, updatedAt: now })
                .where(eq(workMetadata.workId, workId));
            }
          }
          updatedWorks += 1;
        }
      }

      return {
        removedSources: listSources.length,
        updatedWorks,
        archivedWorks,
        archivedWorkIds,
      };
    })
  );
  } catch (error) {
    console.error('Failed to delete list in decoupled mode:', error);
    throw new Error('Falha ao excluir lista sem perder fichas do acervo.', {
      cause: error,
    });
  }
}

export async function getUserFavoritesFromPostgres(
  userUid: string
): Promise<string[]> {
  try {
    const rows = await pgDb
      .select({ workId: userFavorites.workId })
      .from(userFavorites)
      .where(eq(userFavorites.userUid, userUid));
    return rows.map((r) => r.workId);
  } catch (error) {
    console.error('Failed to fetch user favorites:', error);
    throw new Error('Falha ao carregar Minha Lista.', { cause: error });
  }
}

export async function setUserFavoritesInPostgres(
  userUid: string,
  workIds: string[]
): Promise<string[]> {
  const now = Date.now();
  const uniqueIds = Array.from(new Set(workIds.filter(Boolean)));
  try {
    await pgDb.transaction(async (tx) => {
      await tx.delete(userFavorites).where(eq(userFavorites.userUid, userUid));
      if (uniqueIds.length > 0) {
        const validWorks = await tx
          .select({ id: works.id })
          .from(works)
          .where(inArray(works.id, uniqueIds));
        const validIds = validWorks.map((w) => w.id);
        if (validIds.length > 0) {
          await tx
            .insert(userFavorites)
            .values(
              validIds.map((workId) => ({
                id: `${userUid}::${workId}`,
                userUid,
                workId,
                createdAt: now,
              }))
            )
            .onConflictDoNothing({
              target: [userFavorites.userUid, userFavorites.workId],
            });
        }
      }
    });
    return getUserFavoritesFromPostgres(userUid);
  } catch (error) {
    console.error('Failed to update user favorites:', error);
    throw new Error('Falha ao atualizar Minha Lista.', { cause: error });
  }
}

export async function getUserWatchHistoryFromPostgres(
  userUid: string
): Promise<WatchHistoryRecord[]> {
  try {
    const rows = await pgDb
      .select()
      .from(watchHistory)
      .where(eq(watchHistory.userUid, userUid))
      .orderBy(desc(watchHistory.updatedAt));

    return rows.map((r) => ({
      id: r.historyKey,
      itemId: r.workId,
      type: r.type as 'movie' | 'series',
      season: r.season ?? undefined,
      episodeNumber: r.episodeNumber ?? undefined,
      episodeId: r.episodeExternalId ?? undefined,
      episodeTitle: r.episodeTitle ?? undefined,
      episodeLabel: r.episodeLabel,
      currentTime: r.currentTime,
      duration: r.duration,
      progressPercent: r.progressPercent,
      completed: r.completed,
      selectedSourceId: r.selectedSourceId ?? undefined,
      selectedSourceLabel: r.selectedSourceLabel ?? undefined,
      selectedSourceUrl: r.selectedSourceUrl ?? undefined,
      updatedAt: r.updatedAt,
      dismissedFromContinue: r.dismissedFromContinue,
    }));
  } catch (error) {
    console.error('Failed to fetch user watch history:', error);
    throw new Error('Falha ao carregar histórico de reprodução.', {
      cause: error,
    });
  }
}

export async function upsertUserWatchHistoryInPostgres(
  userUid: string,
  record: WatchHistoryRecord
): Promise<void> {
  try {
    const workExists = await pgDb
      .select({ id: works.id })
      .from(works)
      .where(eq(works.id, record.itemId))
      .limit(1);

    if (workExists.length === 0) {
      return;
    }

    let dbEpisodeId: string | null = null;
    if (
      record.type === 'series' &&
      typeof record.season === 'number' &&
      typeof record.episodeNumber === 'number'
    ) {
      const epRow = await pgDb
        .select({ id: episodes.id })
        .from(episodes)
        .where(
          and(
            eq(episodes.workId, record.itemId),
            eq(episodes.seasonNumber, record.season),
            eq(episodes.episodeNumber, record.episodeNumber)
          )
        )
        .limit(1);
      dbEpisodeId = epRow[0]?.id ?? null;
    }

    const rowId = `${userUid}::${record.id}`;
    await pgDb
      .insert(watchHistory)
      .values({
        id: rowId,
        userUid,
        historyKey: record.id,
        workId: record.itemId,
        episodeId: dbEpisodeId,
        type: record.type,
        season: record.season ?? null,
        episodeNumber: record.episodeNumber ?? null,
        episodeExternalId: record.episodeId ?? null,
        episodeTitle: record.episodeTitle ?? null,
        episodeLabel: record.episodeLabel,
        currentTime: record.currentTime,
        duration: record.duration,
        progressPercent: record.progressPercent,
        completed: record.completed,
        selectedSourceId: record.selectedSourceId ?? null,
        selectedSourceLabel: record.selectedSourceLabel ?? null,
        selectedSourceUrl: record.selectedSourceUrl ?? null,
        dismissedFromContinue: Boolean(record.dismissedFromContinue),
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [watchHistory.userUid, watchHistory.historyKey],
        set: {
          episodeId: dbEpisodeId,
          episodeTitle: record.episodeTitle ?? null,
          episodeLabel: record.episodeLabel,
          currentTime: record.currentTime,
          duration: record.duration,
          progressPercent: record.progressPercent,
          completed: record.completed,
          selectedSourceId: record.selectedSourceId ?? null,
          selectedSourceLabel: record.selectedSourceLabel ?? null,
          selectedSourceUrl: record.selectedSourceUrl ?? null,
          dismissedFromContinue: Boolean(record.dismissedFromContinue),
          updatedAt: record.updatedAt,
        },
      });
  } catch (error) {
    console.error('Failed to upsert user watch history:', error);
    throw new Error('Falha ao salvar progresso no histórico.', {
      cause: error,
    });
  }
}

export async function dismissItemHistoryInPostgres(
  userUid: string,
  workId: string
): Promise<void> {
  try {
    await pgDb
      .update(watchHistory)
      .set({ dismissedFromContinue: true })
      .where(
        and(eq(watchHistory.userUid, userUid), eq(watchHistory.workId, workId))
      );
  } catch (error) {
    console.error('Failed to dismiss item from continue watching:', error);
    throw new Error('Falha ao atualizar Continuar Assistindo.', {
      cause: error,
    });
  }
}

export interface MigrationImportPayload {
  source?: 'indexeddb_auto' | 'manual_admin';
  items: CatalogItem[];
  lists: M3uListRecord[];
  myListIds: string[];
  watchHistory: WatchHistoryRecord[];
}

export interface MigrationSummary {
  backupId: string;
  idMap: Record<string, string>;
  createdWorks: number;
  mergedWorks: number;
  createdLists: number;
  createdFavorites: number;
  migratedHistory: number;
  createdAt: number;
}

interface RollbackManifest {
  createdListIds: string[];
  createdServerIds: string[];
  createdWorkIds: string[];
  createdSeasonIds: string[];
  createdEpisodeIds: string[];
  createdSourceIds: string[];
  createdFavoriteIds: string[];
  createdHistoryRowIds: string[];
  previousCatalogBackupCount: number;
}

export async function migrateIndexedDbWithBackup(
  userUid: string,
  payload: MigrationImportPayload
): Promise<MigrationSummary> {
  const now = Date.now();
  const backupId = `mig-${now}-${crypto.randomUUID().slice(0, 8)}`;
  const idMap: Record<string, string> = {};

  const manifest: RollbackManifest = {
    createdListIds: [],
    createdServerIds: [],
    createdWorkIds: [],
    createdSeasonIds: [],
    createdEpisodeIds: [],
    createdSourceIds: [],
    createdFavoriteIds: [],
    createdHistoryRowIds: [],
    previousCatalogBackupCount: 0,
  };

  let createdWorks = 0;
  let mergedWorks = 0;
  let createdFavorites = 0;
  let migratedHistory = 0;

  try {
    await pgDb.transaction(async (tx) => {
      const existingWorks = await tx
        .select({ id: works.id })
        .from(works);
      manifest.previousCatalogBackupCount = existingWorks.length;

      for (const listRec of payload.lists || []) {
        await upsertListRecordToPostgres(
          tx,
          listRec,
          now,
          manifest.createdListIds,
          manifest.createdServerIds
        );
      }

      for (const item of payload.items || []) {
        const res = await upsertWorkInsideTx(tx, item, {
          mergeWithoutOverwrite: true,
          preserveAvailability: true,
          now,
          createdWorkIds: manifest.createdWorkIds,
          createdSeasonIds: manifest.createdSeasonIds,
          createdEpisodeIds: manifest.createdEpisodeIds,
          createdSourceIds: manifest.createdSourceIds,
          createdServerIds: manifest.createdServerIds,
        });
        if (item.id) {
          idMap[item.id] = res.workId;
        }
        if (res.created) createdWorks += 1;
        else mergedWorks += 1;
      }

      for (const favRawId of payload.myListIds || []) {
        const mappedWorkId = idMap[favRawId] || favRawId;
        const workExists = await tx
          .select({ id: works.id })
          .from(works)
          .where(eq(works.id, mappedWorkId))
          .limit(1);
        if (workExists.length === 0) continue;

        const favId = `${userUid}::${mappedWorkId}`;
        const existingFav = await tx
          .select({ id: userFavorites.id })
          .from(userFavorites)
          .where(eq(userFavorites.id, favId))
          .limit(1);
        if (existingFav.length === 0) {
          await tx.insert(userFavorites).values({
            id: favId,
            userUid,
            workId: mappedWorkId,
            createdAt: now,
          });
          manifest.createdFavoriteIds.push(favId);
          createdFavorites += 1;
        }
      }

      for (const hist of payload.watchHistory || []) {
        const mappedWorkId = idMap[hist.itemId] || hist.itemId;
        const workExists = await tx
          .select({ id: works.id })
          .from(works)
          .where(eq(works.id, mappedWorkId))
          .limit(1);
        if (workExists.length === 0) continue;

        const historyKey =
          hist.type === 'movie'
            ? `movie:${mappedWorkId}`
            : hist.season && hist.episodeNumber
              ? `series:${mappedWorkId}:S${hist.season}:E${hist.episodeNumber}`
              : hist.id.replace(hist.itemId, mappedWorkId);

        const rowId = `${userUid}::${historyKey}`;
        const existingHist = await tx
          .select()
          .from(watchHistory)
          .where(eq(watchHistory.id, rowId))
          .limit(1);

        if (existingHist.length === 0) {
          let dbEpisodeId: string | null = null;
          if (
            hist.type === 'series' &&
            typeof hist.season === 'number' &&
            typeof hist.episodeNumber === 'number'
          ) {
            const epRow = await tx
              .select({ id: episodes.id })
              .from(episodes)
              .where(
                and(
                  eq(episodes.workId, mappedWorkId),
                  eq(episodes.seasonNumber, hist.season),
                  eq(episodes.episodeNumber, hist.episodeNumber)
                )
              )
              .limit(1);
            dbEpisodeId = epRow[0]?.id ?? null;
          }

          await tx.insert(watchHistory).values({
            id: rowId,
            userUid,
            historyKey,
            workId: mappedWorkId,
            episodeId: dbEpisodeId,
            type: hist.type,
            season: hist.season ?? null,
            episodeNumber: hist.episodeNumber ?? null,
            episodeExternalId: hist.episodeId ?? null,
            episodeTitle: hist.episodeTitle ?? null,
            episodeLabel: hist.episodeLabel,
            currentTime: hist.currentTime,
            duration: hist.duration,
            progressPercent: hist.progressPercent,
            completed: hist.completed,
            selectedSourceId: hist.selectedSourceId ?? null,
            selectedSourceLabel: hist.selectedSourceLabel ?? null,
            selectedSourceUrl: hist.selectedSourceUrl ?? null,
            dismissedFromContinue: Boolean(hist.dismissedFromContinue),
            updatedAt: hist.updatedAt || now,
          });
          manifest.createdHistoryRowIds.push(rowId);
          migratedHistory += 1;
        } else if (
          (hist.updatedAt || 0) > existingHist[0].updatedAt &&
          hist.currentTime > existingHist[0].currentTime
        ) {
          await tx
            .update(watchHistory)
            .set({
              currentTime: hist.currentTime,
              duration: hist.duration,
              progressPercent: hist.progressPercent,
              completed: hist.completed,
              updatedAt: hist.updatedAt || now,
            })
            .where(eq(watchHistory.id, rowId));
          migratedHistory += 1;
        }
      }

      const summaryObj = {
        backupId,
        createdWorks,
        mergedWorks,
        createdLists: manifest.createdListIds.length,
        createdFavorites,
        migratedHistory,
        createdAt: now,
      };

      await tx.insert(migrationBackups).values({
        id: backupId,
        userUid,
        source: payload.source || 'indexeddb_auto',
        status: 'completed',
        snapshotJson: JSON.stringify({
          manifest,
          payloadSummary: {
            itemsCount: payload.items?.length ?? 0,
            listsCount: payload.lists?.length ?? 0,
          },
        }),
        summaryJson: JSON.stringify(summaryObj),
        createdWorkIdsJson: JSON.stringify(manifest.createdWorkIds),
        createdAt: now,
      });
    });

    return {
      backupId,
      idMap,
      createdWorks,
      mergedWorks,
      createdLists: manifest.createdListIds.length,
      createdFavorites,
      migratedHistory,
      createdAt: now,
    };
  } catch (error) {
    console.error('Migration transaction failed and rolled back cleanly:', error);
    throw new Error(
      'Migração interrompida com rollback automático; nenhum dado pré-existente foi alterado.',
      { cause: error }
    );
  }
}

export async function listMigrationBackups(userUid: string) {
  try {
    const rows = await pgDb
      .select({
        id: migrationBackups.id,
        source: migrationBackups.source,
        status: migrationBackups.status,
        summaryJson: migrationBackups.summaryJson,
        createdAt: migrationBackups.createdAt,
        rolledBackAt: migrationBackups.rolledBackAt,
      })
      .from(migrationBackups)
      .where(eq(migrationBackups.userUid, userUid))
      .orderBy(desc(migrationBackups.createdAt));

    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      status: r.status,
      summary: safeJsonParse<Record<string, unknown>>(r.summaryJson, {}),
      createdAt: r.createdAt,
      rolledBackAt: r.rolledBackAt,
    }));
  } catch (error) {
    console.error('Failed to list migration backups:', error);
    throw new Error('Falha ao listar backups de migração.', { cause: error });
  }
}

export async function rollbackMigrationBackup(
  backupId: string,
  userUid: string
): Promise<{
  backupId: string;
  revertedWorks: number;
  revertedLists: number;
  revertedSources: number;
  revertedFavorites: number;
  revertedHistory: number;
}> {
  const now = Date.now();
  try {
    return await pgDb.transaction(async (tx) => {
      const found = await tx
        .select()
        .from(migrationBackups)
        .where(
          and(
            eq(migrationBackups.id, backupId),
            eq(migrationBackups.userUid, userUid)
          )
        )
        .limit(1);

      if (found.length === 0) {
        throw new Error('Backup de migração não encontrado.');
      }
      if (found[0].status === 'rolled_back') {
        throw new Error('Este lote de migração já foi revertido.');
      }

      const parsed = safeJsonParse<{ manifest?: RollbackManifest }>(
        found[0].snapshotJson,
        {}
      );
      const m = parsed.manifest;
      if (!m) {
        throw new Error('Manifesto de rollback ausente no backup.');
      }

      if (m.createdHistoryRowIds.length > 0) {
        await tx
          .delete(watchHistory)
          .where(inArray(watchHistory.id, m.createdHistoryRowIds));
      }
      if (m.createdFavoriteIds.length > 0) {
        await tx
          .delete(userFavorites)
          .where(inArray(userFavorites.id, m.createdFavoriteIds));
      }
      if (m.createdSourceIds.length > 0) {
        await tx
          .delete(sources)
          .where(inArray(sources.id, m.createdSourceIds));
      }
      if (m.createdEpisodeIds.length > 0) {
        await tx
          .delete(episodes)
          .where(inArray(episodes.id, m.createdEpisodeIds));
      }
      if (m.createdSeasonIds.length > 0) {
        await tx
          .delete(seasons)
          .where(inArray(seasons.id, m.createdSeasonIds));
      }
      if (m.createdWorkIds.length > 0) {
        await tx.delete(works).where(inArray(works.id, m.createdWorkIds));
      }
      if (m.createdListIds.length > 0) {
        await tx.delete(lists).where(inArray(lists.id, m.createdListIds));
      }
      if (m.createdServerIds.length > 0) {
        await tx
          .delete(servers)
          .where(inArray(servers.id, m.createdServerIds));
      }

      await tx
        .update(migrationBackups)
        .set({ status: 'rolled_back', rolledBackAt: now })
        .where(eq(migrationBackups.id, backupId));

      return {
        backupId,
        revertedWorks: m.createdWorkIds.length,
        revertedLists: m.createdListIds.length,
        revertedSources: m.createdSourceIds.length,
        revertedFavorites: m.createdFavoriteIds.length,
        revertedHistory: m.createdHistoryRowIds.length,
      };
    });
  } catch (error) {
    console.error('Failed to rollback migration backup:', error);
    throw new Error(
      error instanceof Error ? error.message : 'Falha ao executar rollback.',
      { cause: error }
    );
  }
}

export async function updateWorkStatusOrDeleteInPostgres(params: {
  workId: string;
  action: 'update' | 'delete';
  patch?: Partial<CatalogItem>;
}): Promise<void> {
  const now = Date.now();
  try {
    if (params.action === 'delete') {
      await pgDb.delete(works).where(eq(works.id, params.workId));
      return;
    }

    if (params.patch) {
      const wPatch: Partial<typeof works.$inferInsert> = { updatedAt: now };
      if (params.patch.status) wPatch.status = params.patch.status;
      if (typeof params.patch.tmdbId === 'number')
        wPatch.tmdbId = params.patch.tmdbId;
      if (params.patch.title) wPatch.title = params.patch.title;
      if (typeof params.patch.year === 'number') wPatch.year = params.patch.year;
      if (typeof params.patch.healthChecked === 'boolean')
        wPatch.healthChecked = params.patch.healthChecked;
      if (typeof params.patch.archived === 'boolean')
        wPatch.archived = params.patch.archived;
      if (params.patch.lastError !== undefined)
        wPatch.lastError = params.patch.lastError;

      await pgDb.update(works).set(wPatch).where(eq(works.id, params.workId));

      const mPatch: Partial<typeof workMetadata.$inferInsert> = {
        updatedAt: now,
      };
      if (params.patch.platform) mPatch.platform = params.patch.platform;
      if (params.patch.synopsis !== undefined)
        mPatch.synopsis = params.patch.synopsis;
      if (Array.isArray(params.patch.genres))
        mPatch.genresJson = JSON.stringify(params.patch.genres);
      if (Array.isArray(params.patch.cast))
        mPatch.castJson = JSON.stringify(params.patch.cast);
      if (params.patch.director !== undefined)
        mPatch.director = params.patch.director;
      if (params.patch.duration !== undefined)
        mPatch.duration = params.patch.duration;
      if (typeof params.patch.durationSeconds === 'number')
        mPatch.durationSeconds = params.patch.durationSeconds;
      if (params.patch.qualityBadge !== undefined)
        mPatch.qualityBadge = params.patch.qualityBadge;
      if (typeof params.patch.voteAverage === 'number')
        mPatch.voteAverage = params.patch.voteAverage;
      if (params.patch.posterImage !== undefined)
        mPatch.posterImage = params.patch.posterImage;
      if (params.patch.backdropImage !== undefined)
        mPatch.backdropImage = params.patch.backdropImage;
      if (params.patch.youtubeTrailerId !== undefined)
        mPatch.youtubeTrailerId = params.patch.youtubeTrailerId;
      if (typeof params.patch.tmdbEnriched === 'boolean') {
        mPatch.tmdbEnriched = params.patch.tmdbEnriched;
        if (params.patch.tmdbEnriched) mPatch.enrichedAt = now;
      }
      if (typeof params.patch.youtubeEnriched === 'boolean')
        mPatch.youtubeEnriched = params.patch.youtubeEnriched;

      await pgDb
        .update(workMetadata)
        .set(mPatch)
        .where(eq(workMetadata.workId, params.workId));
    }
  } catch (error) {
    console.error('Failed to update/delete work in PostgreSQL:', error);
    throw new Error('Falha ao atualizar obra no banco.', { cause: error });
  }
}

export interface ServerRecord {
  id: string;
  name: string;
  baseUrl: string;
  serverType: 'm3u' | 'xtream' | 'json' | 'saimo' | 'cdn';
  username?: string;
  password?: string;
  lastSyncAt?: number;
  lastSyncStatus: 'nominal' | 'error' | 'syncing' | 'untested';
  itemCount: number;
  syncReason?: string;
  createdAt: number;
  updatedAt: number;
}

export async function listServersFromPostgres(): Promise<ServerRecord[]> {
  try {
    const rows = await pgDb.select().from(servers).orderBy(desc(servers.updatedAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      serverType: r.serverType as ServerRecord['serverType'],
      username: r.username ?? undefined,
      password: r.password ?? undefined,
      lastSyncAt: r.lastSyncAt ?? undefined,
      lastSyncStatus: r.lastSyncStatus as ServerRecord['lastSyncStatus'],
      itemCount: r.itemCount,
      syncReason: r.syncReason ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  } catch (error) {
    console.error('Failed to list servers from PostgreSQL:', error);
    throw new Error('Falha ao listar servidores cadastrados.', { cause: error });
  }
}

export async function upsertServerInPostgres(record: ServerRecord): Promise<void> {
  const now = Date.now();
  try {
    const existing = await pgDb
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, record.id))
      .limit(1);

    if (existing.length === 0) {
      await pgDb.insert(servers).values({
        id: record.id,
        name: record.name,
        baseUrl: record.baseUrl,
        serverType: record.serverType,
        username: record.username ?? null,
        password: record.password ?? null,
        lastSyncAt: record.lastSyncAt ?? null,
        lastSyncStatus: record.lastSyncStatus || 'untested',
        itemCount: record.itemCount || 0,
        syncReason: record.syncReason ?? null,
        createdAt: record.createdAt || now,
        updatedAt: now,
      });
    } else {
      await pgDb
        .update(servers)
        .set({
          name: record.name,
          baseUrl: record.baseUrl,
          serverType: record.serverType,
          username: record.username ?? null,
          password: record.password ?? null,
          lastSyncAt: record.lastSyncAt ?? undefined,
          lastSyncStatus: record.lastSyncStatus,
          itemCount: record.itemCount,
          syncReason: record.syncReason ?? null,
          updatedAt: now,
        })
        .where(eq(servers.id, record.id));
    }
  } catch (error) {
    console.error('Failed to upsert server in PostgreSQL:', error);
    throw new Error('Falha ao salvar servidor no banco.', { cause: error });
  }
}

export async function deleteServerInPostgres(serverId: string): Promise<void> {
  try {
    await pgDb.delete(servers).where(eq(servers.id, serverId));
  } catch (error) {
    console.error('Failed to delete server in PostgreSQL:', error);
    throw new Error('Falha ao remover servidor.', { cause: error });
  }
}

export async function updateServerSyncStatusInPostgres(
  serverId: string,
  status: ServerRecord['lastSyncStatus'],
  itemCount: number,
  reason?: string
): Promise<void> {
  const now = Date.now();
  try {
    await pgDb
      .update(servers)
      .set({
        lastSyncStatus: status,
        itemCount,
        lastSyncAt: now,
        syncReason: reason ?? null,
        updatedAt: now,
      })
      .where(eq(servers.id, serverId));
  } catch (error) {
    console.error('Failed to update server sync status:', error);
  }
}
