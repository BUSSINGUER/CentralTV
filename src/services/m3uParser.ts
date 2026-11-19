import { db, saveM3uListRecord } from '../db/database';
import {
  authorizeStreamOrigins,
  extractUrlsFromCatalogItems,
} from './streamOrigins';
import {
  deleteListOnServer,
  syncCatalogItemsToServer,
} from './persistenceSync';
import {
  buildProvisionalKey,
  getCandidateProvisionalKeys,
} from '../utils/identity';
import {
  CatalogItem,
  M3uListRecord,
  MediaFormatBadge,
  MediaKind,
  MediaSource,
  PlatformId,
  SeriesEpisode,
  XtreamCredentials,
} from '../types/streaming';

export interface M3UImportStats {
  listId: string;
  detectedFormat?: 'm3u' | 'json';
  bytesRead: number;
  totalBytes: number;
  linesParsed: number;
  rawEntries: number;
  groupedItems: number;
  newItems: number;
  mergedSources: number;
  ignoredDuplicates: number;
  byKind: Record<MediaKind, number>;
  touchedItemIds?: string[];
}

export interface M3UImportOptions {
  listId?: string;
  customName?: string;
  xtreamCredentials?: XtreamCredentials;
  onProgress?: (stats: M3UImportStats) => void;
  signal?: AbortSignal;
}

interface ParsedExtInf {
  tvgId: string;
  tvgName: string;
  tvgLogo: string;
  groupTitle: string;
  displayName: string;
}

const DEFAULT_FALLBACK_BACKDROP =
  '/src/assets/images/hero_duna_horizonte_1794970793813.jpg';
const DEFAULT_FALLBACK_POSTER =
  '/src/assets/images/poster_abismo_azul_1794970796728.jpg';

export function sanitizeLogoUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  return trimmed.replace(/([^:]\/)\/+/g, '$1');
}

export function normalizeTextKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function cleanTitleAndExtractYear(rawTitle: string): {
  cleanTitle: string;
  year?: number;
} {
  let working = rawTitle
    .replace(/^[❖✦•★◆▶►]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip leading M3U group-style prefixes like "❖ 2 4K -" if pasted into title
  working = working.replace(/^(?:\d+\s+)?(?:4K|UHD|FHD|HD|SD)\s*[-–|:]\s*/i, '');

  const yearMatches = Array.from(
    working.matchAll(/[\[(]\s*((?:19|20)\d{2})\s*[\])]/g)
  );
  const extractedYear =
    yearMatches.length > 0
      ? Number(yearMatches[yearMatches.length - 1][1])
      : undefined;

  // Strip duplicated years (2023) (2023) and bracketed technical/language tags
  working = working
    .replace(/[\[(]\s*(?:19|20)\d{2}\s*[\])]/g, ' ')
    .replace(
      /[\[(]\s*(?:4K|UHD|FHD|HD|SD|1080p|720p|480p|LEG|L|DUB|DUBLADO|LEGENDADO|DUAL(?:\s*[ÁA]UDIO)?|CAM|TS|HDR|IMAX|H\.?265|HEVC|60FPS|ALT(?:ERNATIVO)?|BACKUP|\d+)\s*[\])]/gi,
      ' '
    );

  // Strip unbracketed trailing or separator-delimited technical/language tags
  working = working
    .replace(
      /(?:\s*[-–|:]\s*|\s+)(?:4K|UHD|FHD|1080p|720p|480p|DUBLADO|LEGENDADO|DUAL\s*[ÁA]UDIO|H\.?265|HEVC|IMAX|HDR|60FPS)(?=\s|$|[-–|])/gi,
      ' '
    )
    .replace(/\b(?:4K|UHD|FHD|1080p|720p|DUBLADO|LEGENDADO)\s*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[-–—:|]\s*$/g, '')
    .replace(/^[-–—:|]\s*/g, '')
    .trim();

  return {
    cleanTitle: working || rawTitle.trim(),
    year: extractedYear,
  };
}

export function extractSourceMetadataTags(
  rawTitle: string,
  groupTitle: string
): {
  resolutionTag?: string;
  languageTag?: string;
  qualityTag?: string;
} {
  const combined = `${rawTitle} ${groupTitle}`;

  let resolutionTag: string | undefined;
  if (/\b(?:4K|UHD|2160p)\b/i.test(combined)) {
    resolutionTag = '4K';
  } else if (/\b1080p\b/i.test(combined)) {
    resolutionTag = '1080p';
  } else if (/\bFHD\b/i.test(combined)) {
    resolutionTag = 'FHD';
  } else if (/\b720p\b/i.test(combined)) {
    resolutionTag = '720p';
  } else if (/\bHD\b/i.test(combined)) {
    resolutionTag = 'HD';
  } else if (/\bSD\b/i.test(combined)) {
    resolutionTag = 'SD';
  }

  let languageTag: string | undefined;
  if (/\b(?:DUAL\s*[ÁA]UDIO|DUAL)\b/i.test(combined)) {
    languageTag = 'Dual Áudio';
  } else if (/\b(?:DUBLADO|DUB)\b/i.test(combined)) {
    languageTag = 'Dublado';
  } else if (
    /\b(?:LEGENDADO|LEG)\b/i.test(combined) ||
    /[\[(]\s*L\s*[\])]/i.test(rawTitle)
  ) {
    languageTag = 'Legendado';
  }

  const extras: string[] = [];
  if (resolutionTag) extras.push(resolutionTag);
  if (/\bIMAX\b/i.test(combined) && resolutionTag !== 'IMAX') {
    extras.push('IMAX');
  }
  if (/\bH\.?265|HEVC\b/i.test(combined)) {
    extras.push('H.265');
  }
  if (languageTag) extras.push(languageTag);

  return {
    resolutionTag,
    languageTag,
    qualityTag: extras.length > 0 ? extras.join(' · ') : undefined,
  };
}

function getSourcePriorityScore(src: MediaSource): number {
  const tagText = `${src.resolutionTag || ''} ${src.qualityTag || ''} ${src.label || ''} ${src.originalName || ''} ${src.groupTitle || ''}`.toUpperCase();

  let resRank = 4;
  if (/\b(4K|UHD|2160P)\b/.test(tagText)) resRank = 0;
  else if (/\b(1080P|FHD)\b/.test(tagText)) resRank = 1;
  else if (/\b(720P|HD)\b/.test(tagText)) resRank = 2;
  else if (/\bSD\b/.test(tagText)) resRank = 3;

  let langRank = 2;
  if (/\b(DUBLADO|DUB|DUAL)\b/.test(tagText)) langRank = 0;
  else if (/\b(LEGENDADO|LEG)\b/.test(tagText)) langRank = 1;

  return resRank * 10 + langRank;
}

export function sortAndRelabelSources(sources: MediaSource[]): MediaSource[] {
  const sorted = [...sources].sort((a, b) => {
    const scoreA = getSourcePriorityScore(a);
    const scoreB = getSourcePriorityScore(b);
    return scoreA - scoreB;
  });

  return sorted.map((src, idx) => {
    const tag =
      src.qualityTag ||
      [src.resolutionTag, src.languageTag].filter(Boolean).join(' · ') ||
      undefined;
    return {
      ...src,
      qualityTag: tag,
      label: buildSourceLabel(idx + 1, tag),
    };
  });
}

/**
 * Strips quality/server tags from Live TV channel names so
 * "Globo SP FHD", "Globo SP HD", "Globo SP [Alt]" group into "Globo SP"
 * while preserving the detected quality/server tag for the source label.
 */
export function normalizeLiveChannelName(rawName: string): {
  cleanChannelName: string;
  qualityTag?: string;
} {
  let working = rawName
    .replace(/^[❖✦•★◆▶►]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const tagsFound: string[] = [];

  const captureAndStrip = (regex: RegExp) => {
    working = working.replace(regex, (full, captured) => {
      const token = (captured || full).replace(/[\[\]()]/g, '').trim();
      if (token) tagsFound.push(token);
      return ' ';
    });
  };

  captureAndStrip(
    /[\[(]\s*(FHD|HD|SD|4K|UHD|1080p|720p|H\.?265|HEVC|H\.?264|ALT(?:ERNATIVO)?|BACKUP|BKP|SINAL\s*\d*|OP[CÇ][AÃ]O\s*\d*|\d+|60FPS|LOW|LEG|DUB)\s*[\])]/gi
  );

  captureAndStrip(
    /(?:^|\s|[-–|])(H\.?265|HEVC|FHD|UHD|4K|1080p|720p|HD|SD|60FPS|ALTERNATIVO|BACKUP|BKP|ALT)(?=\s|$|[-–|])/gi
  );

  captureAndStrip(/\b(?:Sinal|Op[cç][aã]o|Server|Servidor)\s*\d+\b/gi);

  const cleanChannelName = working
    .replace(/\s*[-–|]+\s*$/g, '')
    .replace(/^\s*[-–|]+\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const qualityTag =
    tagsFound.length > 0 ? tagsFound.join(' ').toUpperCase() : undefined;

  return {
    cleanChannelName: cleanChannelName || rawName.trim(),
    qualityTag,
  };
}

/**
 * Matches ONLY explicit season + episode numbering (S01E01, T01E01, 1x01, Temporada 1).
 * Never matches movie subtitles like "Star Wars: Episódio I".
 */
export function hasExplicitSeasonEpisodePattern(rawTitle: string): boolean {
  return (
    /\b[ST]\d{1,2}\s*[ExX]\d{1,3}\b/i.test(rawTitle) ||
    /\b\d{1,2}x\d{1,3}\b/i.test(rawTitle) ||
    /\bTemporada\s*\d{1,2}\b/i.test(rawTitle)
  );
}

export function extractEpisodeInfo(rawTitle: string): {
  seriesTitle: string;
  season: number;
  episode: number;
  episodeTitle: string;
} | null {
  const patterns: RegExp[] = [
    /^(.*?)\s*[-–|]?\s*\b[ST](\d{1,2})\s*[ExX](\d{1,3})\b(.*)$/i,
    /^(.*?)\s*[-–|]?\s*\b(\d{1,2})x(\d{1,3})\b(.*)$/i,
    /^(.*?)\s*[-–|]?\s*\bTemporada\s*(\d{1,2})\s*[-–,]?\s*Epis[óo]dio\s*(\d{1,3})\b(.*)$/i,
  ];

  for (const regex of patterns) {
    const match = rawTitle.match(regex);
    if (match) {
      const seriesTitle = cleanTitleAndExtractYear(match[1]).cleanTitle;
      const season = Number(match[2]);
      const episode = Number(match[3]);
      const suffix = match[4]?.replace(/^[\s\-–:]+/, '').trim();
      if (seriesTitle) {
        return {
          seriesTitle,
          season,
          episode,
          episodeTitle: suffix || `Episódio ${episode}`,
        };
      }
    }
  }

  return null;
}

function getUrlPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return rawUrl.split('?')[0].toLowerCase();
  }
}

/**
 * Corrected Classification Rules:
 * - 'radio': group-title or title mentions Rádio/Radio/FM/AM or audio stream extension
 * - 'movie': URL contains /movie/ (always movie), OR ends in .mp4/.mkv/.avi without explicit SxxExx
 * - 'series': URL contains /series/ OR explicit S01E01 / T01E01 / 1x01 / Temporada 1
 *   (NEVER classified as series for "Episódio I" / Roman numerals)
 * - 'live': Everything else (.ts, .m3u8, /live/, extensionless channel streams)
 */
export function classifyEntry(
  url: string,
  title: string,
  groupTitle: string
): MediaKind {
  const pathname = getUrlPathname(url);
  const lowerUrl = url.toLowerCase();

  // Prioridade 1 — SÉRIES
  if (
    lowerUrl.includes('/series/') ||
    hasExplicitSeasonEpisodePattern(title) ||
    /\b(?:séries|series|novelas|animes|doramas)\b/i.test(groupTitle)
  ) {
    return 'series';
  }

  // Prioridade 2 — FILMES (VOD)
  if (
    lowerUrl.includes('/movie/') ||
    /\.(mp4|mkv|avi|mov|wmv|webm)$/i.test(pathname) ||
    /[\[(]\s*(?:19|20)\d{2}\s*[\])]/.test(title) ||
    /\b(?:filmes|movies|vod|cinema|lançamentos)\b/i.test(groupTitle)
  ) {
    return 'movie';
  }

  // Prioridade 3 — RÁDIO (Bloqueio de Falso Positivo)
  if (
    /\b(r[áa]dio|radio|fm|am)\b/i.test(groupTitle) ||
    /\b(r[áa]dio|radio|fm|am)\b/i.test(title)
  ) {
    return 'radio';
  }

  // Prioridade 4 — TV AO VIVO
  return 'live';
}

function detectQualityBadge(
  groupTitle: string,
  rawTitle: string
): MediaFormatBadge | undefined {
  const combined = `${groupTitle} ${rawTitle}`.toUpperCase();
  if (combined.includes('IMAX')) return 'IMAX';
  if (combined.includes('4K') || combined.includes('UHD')) return '4K';
  if (combined.includes('DOLBY')) return 'DOLBY';
  return undefined;
}

function detectInitialPlatform(groupTitle: string): PlatformId {
  const g = groupTitle.toLowerCase();
  if (g.includes('netflix')) return 'netflix';
  if (g.includes('disney')) return 'disney';
  if (g.includes('hbo') || g.includes('max')) return 'hbo';
  if (g.includes('hulu') || g.includes('star')) return 'hulu';
  if (g.includes('prime') || g.includes('amazon')) return 'prime';
  if (g.includes('apple')) return 'apple';
  return 'netflix';
}

function cleanGroupLabel(groupTitle: string): string {
  return groupTitle
    .replace(/^[❖✦•★◆]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseExtInfLine(line: string): ParsedExtInf {
  const extractAttr = (attrName: string): string => {
    const regex = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i');
    const match = line.match(regex);
    return match ? match[1].trim() : '';
  };

  let inQuotes = false;
  let commaIdx = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) commaIdx = i;
  }

  const displayName =
    commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';

  return {
    tvgId: extractAttr('tvg-id'),
    tvgName: extractAttr('tvg-name'),
    tvgLogo: sanitizeLogoUrl(extractAttr('tvg-logo')),
    groupTitle: extractAttr('group-title'),
    displayName,
  };
}

function buildSourceLabel(index: number, qualityTag?: string): string {
  return qualityTag ? `Fonte ${index} · ${qualityTag}` : `Fonte ${index}`;
}

export async function importM3UFromStream(
  stream: ReadableStream<Uint8Array>,
  totalBytes: number,
  options: M3UImportOptions = {}
): Promise<M3UImportStats> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');

  const listId =
    options.listId || `list-${crypto.randomUUID().slice(0, 10)}`;

  const stats: M3UImportStats = {
    listId,
    bytesRead: 0,
    totalBytes,
    linesParsed: 0,
    rawEntries: 0,
    groupedItems: 0,
    newItems: 0,
    mergedSources: 0,
    ignoredDuplicates: 0,
    byKind: { movie: 0, series: 0, live: 0, radio: 0 },
    touchedItemIds: [],
  };

  const existingItems = await db.mediaItems.toArray();
  const itemByKey = new Map<string, CatalogItem>();
  const touchedIdSet = new Set<string>();

  for (const existing of existingItems) {
    if (existing.normalizedKey) {
      itemByKey.set(existing.normalizedKey, existing);
    }
    const parsedOrigYear = existing.originalTitle
      ? cleanTitleAndExtractYear(existing.originalTitle).year
      : undefined;
    const effectiveYear = existing.tmdbEnriched ? existing.year : parsedOrigYear;
    const candidateKeys = getCandidateProvisionalKeys({
      type: existing.type,
      title: existing.title,
      originalTitle: existing.originalTitle,
      year: effectiveYear,
    });
    for (const k of candidateKeys) {
      if (!itemByKey.has(k)) {
        itemByKey.set(k, existing);
      }
    }
  }

  const dirtyItems = new Map<string, CatalogItem>();
  const discoveredOrigins = new Set<string>();
  let carryOver = '';
  let currentExtInf: ParsedExtInf | null = null;

  const flushBatch = async () => {
    if (dirtyItems.size === 0) return;
    const batch = Array.from(dirtyItems.values()).map((it) => {
      touchedIdSet.add(it.id);
      return {
        ...it,
        archived: false,
        sources: sortAndRelabelSources(it.sources || []),
        episodes: it.episodes?.map((ep) => ({
          ...ep,
          sources: sortAndRelabelSources(ep.sources || []),
        })),
      };
    });
    dirtyItems.clear();
    await db.mediaItems.bulkPut(batch);
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    stats.linesParsed += 1;
    if (!line || line.startsWith('#EXTM3U')) return;

    if (line.startsWith('#EXTINF')) {
      currentExtInf = parseExtInfLine(line);
      return;
    }

    if (line.startsWith('#')) return;

    if (!/^https?:\/\//i.test(line)) {
      currentExtInf = null;
      return;
    }

    try {
      const parsedOrigin = new URL(line);
      discoveredOrigins.add(`${parsedOrigin.protocol}//${parsedOrigin.host}`);
    } catch {
      // Ignore invalid origin
    }

    const meta = currentExtInf ?? {
      tvgId: '',
      tvgName: '',
      tvgLogo: '',
      groupTitle: '',
      displayName: 'Stream sem título',
    };
    currentExtInf = null;

    const rawTitle = meta.tvgName || meta.displayName || 'Sem Título';
    const mediaKind = classifyEntry(line, rawTitle, meta.groupTitle);

    let groupItemTitle = rawTitle;
    let year: number | undefined;
    let qualityTag: string | undefined;
    let resolutionTag: string | undefined;
    let languageTag: string | undefined;
    let episodeInfo: ReturnType<typeof extractEpisodeInfo> = null;

    if (mediaKind === 'live') {
      const liveNorm = normalizeLiveChannelName(meta.displayName || rawTitle);
      groupItemTitle = liveNorm.cleanChannelName;
      qualityTag = liveNorm.qualityTag;
      resolutionTag = liveNorm.qualityTag;
    } else if (mediaKind === 'series') {
      episodeInfo = extractEpisodeInfo(rawTitle);
      const cleaned = cleanTitleAndExtractYear(
        episodeInfo ? episodeInfo.seriesTitle : rawTitle
      );
      groupItemTitle = cleaned.cleanTitle;
      year = cleaned.year;
      const tags = extractSourceMetadataTags(rawTitle, meta.groupTitle);
      qualityTag = tags.qualityTag;
      resolutionTag = tags.resolutionTag;
      languageTag = tags.languageTag;
    } else {
      const cleaned = cleanTitleAndExtractYear(rawTitle);
      groupItemTitle = cleaned.cleanTitle;
      year = cleaned.year;
      const tags = extractSourceMetadataTags(rawTitle, meta.groupTitle);
      qualityTag = tags.qualityTag;
      resolutionTag = tags.resolutionTag;
      languageTag = tags.languageTag;
    }

    const normalizedKey = buildProvisionalKey({
      type: mediaKind,
      title: groupItemTitle,
      originalTitle: rawTitle,
      year,
    });

    stats.rawEntries += 1;
    const now = Date.now();
    let item = itemByKey.get(normalizedKey);

    const isBrandNewItem = !item;

    if (!item) {
      // Caso 3: Título inédito -> entra na fila de pré-publicação (pendente)
      const qualityBadge = detectQualityBadge(meta.groupTitle, rawTitle);
      const cleanGroup = cleanGroupLabel(meta.groupTitle);
      const logo = meta.tvgLogo;

      item = {
        id: `m3u-${crypto.randomUUID().slice(0, 12)}`,
        normalizedKey,
        title: groupItemTitle,
        originalTitle: rawTitle,
        tvgId: meta.tvgId || undefined,
        tvgName: meta.tvgName || meta.displayName || undefined,
        type: mediaKind,
        mediaKind,
        year: year ?? new Date().getFullYear(),
        genres: cleanGroup ? [cleanGroup] : [mediaKind.toUpperCase()],
        ageRating: '14',
        duration:
          mediaKind === 'series'
            ? '1 Temporada'
            : mediaKind === 'live'
              ? 'Ao Vivo'
              : mediaKind === 'radio'
                ? 'Rádio Digital'
                : '2h 00min',
        durationSeconds: mediaKind === 'series' ? 3000 : 7200,
        platform: detectInitialPlatform(meta.groupTitle),
        qualityBadge,
        synopsis:
          mediaKind === 'live'
            ? `Canal de TV ao Vivo ${groupItemTitle} (${
                cleanGroup || 'Grade Aberta'
              }).`
            : mediaKind === 'radio'
              ? `Estação de áudio ${groupItemTitle} importada via lista M3U.`
              : `Título importado via M3U (${
                  cleanGroup || 'Catálogo Geral'
                }). Execute o enriquecimento TMDB para carregar sinopse, elenco e plataforma.`,
        cast: [],
        director: cleanGroup || 'Importação M3U',
        youtubeTrailerId: '',
        posterImage:
          logo ||
          (mediaKind === 'live'
            ? DEFAULT_FALLBACK_BACKDROP
            : DEFAULT_FALLBACK_POSTER),
        backdropImage: logo || DEFAULT_FALLBACK_BACKDROP,
        tvgLogo: logo,
        groupTitle: meta.groupTitle,
        categories: ['populares'],
        sources: [],
        episodes: mediaKind === 'series' ? [] : undefined,
        status: 'pendente',
        archived: false,
        healthChecked: false,
        tmdbEnriched: false,
        youtubeEnriched: false,
        createdAt: now,
        updatedAt: now,
      };

      itemByKey.set(normalizedKey, item);
      stats.groupedItems += 1;
      stats.newItems += 1;
      stats.byKind[mediaKind] += 1;
    }

    let itemModified = isBrandNewItem || Boolean(item.archived);
    if (item.archived) {
      item.archived = false;
    }

    if (!item.tvgId && meta.tvgId) {
      item.tvgId = meta.tvgId;
      itemModified = true;
    }
    if (!item.tvgName && (meta.tvgName || meta.displayName)) {
      item.tvgName = meta.tvgName || meta.displayName;
      itemModified = true;
    }

    // Upgrade item quality badge if any grouped source is 4K / IMAX
    const detectedBadge = detectQualityBadge(meta.groupTitle, rawTitle);
    if (detectedBadge === '4K' && item.qualityBadge !== '4K') {
      item.qualityBadge = '4K';
      itemModified = true;
    } else if (!item.qualityBadge && detectedBadge) {
      item.qualityBadge = detectedBadge;
      itemModified = true;
    }

    const existingSources = item.sources ?? [];
    const alreadyHasUrl = existingSources.some((s) => s.url === line);

    if (alreadyHasUrl) {
      // Caso 1: Título já existe e URL exata já cadastrada -> ignora duplicata sem rebaixar status
      if (!isBrandNewItem && !(mediaKind === 'series' && episodeInfo)) {
        stats.ignoredDuplicates += 1;
      }
    } else {
      // Caso 2 (se já existente/publicado) ou Caso 3 (se inédito): adiciona fonte vinculada ao listId com prioridade 4K
      const nextIndex = existingSources.length + 1;
      const nextSource: MediaSource = {
        id: `src-${nextIndex}-${now}-${Math.random().toString(36).slice(2, 6)}`,
        label: buildSourceLabel(nextIndex, qualityTag),
        qualityTag,
        resolutionTag,
        languageTag,
        originalName: rawTitle,
        url: line,
        listId,
        groupTitle: meta.groupTitle,
        tvgId: meta.tvgId || undefined,
        status: 'pending',
      };
      item.sources = sortAndRelabelSources([...existingSources, nextSource]);
      itemModified = true;
      if (!isBrandNewItem) {
        stats.mergedSources += 1;
      }
    }

    if (mediaKind === 'series' && episodeInfo) {
      const episodes = item.episodes ?? [];
      const existingEp = episodes.find(
        (ep) =>
          ep.season === episodeInfo!.season &&
          ep.episode === episodeInfo!.episode
      );

      if (existingEp) {
        if (existingEp.sources.some((s) => s.url === line)) {
          if (alreadyHasUrl && !isBrandNewItem) {
            stats.ignoredDuplicates += 1;
          }
        } else {
          existingEp.sources = sortAndRelabelSources([
            ...existingEp.sources,
            {
              id: `ep-src-${existingEp.sources.length + 1}-${now}`,
              label: buildSourceLabel(existingEp.sources.length + 1, qualityTag),
              qualityTag,
              resolutionTag,
              languageTag,
              originalName: rawTitle,
              url: line,
              listId,
              groupTitle: meta.groupTitle,
              status: 'pending',
            },
          ]);
          itemModified = true;
        }
      } else {
        const newEp: SeriesEpisode = {
          id: `s${episodeInfo.season}e${episodeInfo.episode}`,
          season: episodeInfo.season,
          episode: episodeInfo.episode,
          title: episodeInfo.episodeTitle,
          sources: sortAndRelabelSources([
            {
              id: `ep-src-1-${now}`,
              label: buildSourceLabel(1, qualityTag),
              qualityTag,
              resolutionTag,
              languageTag,
              originalName: rawTitle,
              url: line,
              listId,
              groupTitle: meta.groupTitle,
              status: 'pending',
            },
          ]),
        };
        item.episodes = [...episodes, newEp].sort((a, b) =>
          a.season !== b.season ? a.season - b.season : a.episode - b.episode
        );
        itemModified = true;
      }

      const maxSeason = Math.max(
        ...(item.episodes || []).map((e) => e.season),
        1
      );
      item.duration = `${maxSeason} ${
        maxSeason === 1 ? 'Temporada' : 'Temporadas'
      } · ${item.episodes?.length ?? 0} eps`;
    }

    if (!item.tvgLogo && meta.tvgLogo) {
      item.tvgLogo = meta.tvgLogo;
      item.posterImage = meta.tvgLogo;
      if (!item.backdropImage || item.backdropImage === DEFAULT_FALLBACK_BACKDROP) {
        item.backdropImage = meta.tvgLogo;
      }
      itemModified = true;
    }

    if (itemModified) {
      // Never downgrade published or approved items to pendente
      item.updatedAt = now;
      dirtyItems.set(item.id, item);
    }
  };

  while (true) {
    if (options.signal?.aborted) {
      throw new DOMException('Importação cancelada', 'AbortError');
    }

    const { value, done } = await reader.read();
    if (done) break;

    stats.bytesRead += value.byteLength;
    const chunkText = carryOver + decoder.decode(value, { stream: true });
    const lines = chunkText.split(/\r?\n/);
    carryOver = lines.pop() ?? '';

    for (let i = 0; i < lines.length; i++) {
      processLine(lines[i]);
      if (i > 0 && i % 2000 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (dirtyItems.size >= 400) {
      await flushBatch();
    }

    options.onProgress?.({ ...stats, byKind: { ...stats.byKind } });
  }

  const tail = carryOver + decoder.decode();
  if (tail.trim()) {
    processLine(tail);
  }

  await flushBatch();
  stats.touchedItemIds = Array.from(touchedIdSet);
  if (discoveredOrigins.size > 0) {
    await authorizeStreamOrigins(Array.from(discoveredOrigins));
  }
  options.onProgress?.({ ...stats, byKind: { ...stats.byKind } });
  return stats;
}

/**
 * Unifies duplicates across IndexedDB, cleans technical tags & duplicated years from card titles,
 * preserves quality/language tags on every source, sorts 4K first, and re-applies strict
 * Movie vs Series vs Live TV classification.
 */
export async function unifyAndReclassifyCatalog(): Promise<{
  beforeCount: number;
  afterCount: number;
  byKind: Record<MediaKind, number>;
}> {
  const all = await db.mediaItems.toArray();
  const byKey = new Map<string, CatalogItem>();
  const byKind: Record<MediaKind, number> = {
    movie: 0,
    series: 0,
    live: 0,
    radio: 0,
  };

  for (const oldItem of all) {
    const primaryUrl =
      oldItem.sources?.[0]?.url ||
      oldItem.episodes?.[0]?.sources?.[0]?.url ||
      '';
    const rawTitle = oldItem.originalTitle || oldItem.tvgName || oldItem.title;
    const groupTitle = oldItem.groupTitle || oldItem.genres?.[0] || '';

    const newKind = primaryUrl
      ? classifyEntry(primaryUrl, rawTitle, groupTitle)
      : oldItem.type === 'series' || oldItem.type === 'live' || oldItem.type === 'radio'
        ? oldItem.type
        : 'movie';

    let cleanTitle = oldItem.title;
    let year = oldItem.year;

    if (newKind === 'live') {
      const liveNorm = normalizeLiveChannelName(rawTitle);
      cleanTitle = liveNorm.cleanChannelName;
    } else {
      const cleaned = cleanTitleAndExtractYear(rawTitle);
      cleanTitle = cleaned.cleanTitle;
      year = cleaned.year || oldItem.year;
    }

    const cleanedOrigYear = oldItem.originalTitle
      ? cleanTitleAndExtractYear(oldItem.originalTitle).year
      : undefined;
    const effectiveYear =
      oldItem.tmdbEnriched ? oldItem.year : year ?? cleanedOrigYear;
    const key = oldItem.tmdbId
      ? `${newKind}::tmdb::${oldItem.tmdbId}`
      : buildProvisionalKey({
          type: newKind,
          title: cleanTitle,
          originalTitle: oldItem.originalTitle,
          year: effectiveYear,
        });

    const enrichSource = (src: MediaSource): MediaSource => {
      const srcName = src.originalName || rawTitle;
      const srcGroup = src.groupTitle || groupTitle;
      if (newKind === 'live') {
        const liveTag =
          src.qualityTag || normalizeLiveChannelName(srcName).qualityTag;
        return {
          ...src,
          originalName: srcName,
          qualityTag: liveTag,
          resolutionTag: src.resolutionTag || liveTag,
        };
      }
      const tags = extractSourceMetadataTags(srcName, srcGroup);
      const mergedTag =
        tags.qualityTag ||
        src.qualityTag ||
        [src.resolutionTag, src.languageTag].filter(Boolean).join(' · ') ||
        undefined;
      return {
        ...src,
        originalName: srcName,
        groupTitle: srcGroup,
        resolutionTag: tags.resolutionTag || src.resolutionTag,
        languageTag: tags.languageTag || src.languageTag,
        qualityTag: mergedTag,
      };
    };

    const existing = byKey.get(key);
    if (!existing) {
      const enrichedSources = sortAndRelabelSources(
        (oldItem.sources || []).map(enrichSource)
      );
      const has4k = enrichedSources.some(
        (s) => s.resolutionTag === '4K' || s.qualityTag?.includes('4K')
      );

      const updated: CatalogItem = {
        ...oldItem,
        normalizedKey: key,
        title: cleanTitle,
        type: newKind,
        mediaKind: newKind,
        year,
        qualityBadge: has4k ? '4K' : oldItem.qualityBadge,
        sources: enrichedSources,
        episodes: oldItem.episodes?.map((ep) => ({
          ...ep,
          sources: sortAndRelabelSources(ep.sources.map(enrichSource)),
        })),
        updatedAt: Date.now(),
      };
      byKey.set(key, updated);
      byKind[newKind] += 1;
    } else {
      const mergedSources = [...(existing.sources || [])];
      for (const rawSrc of oldItem.sources || []) {
        const enriched = enrichSource(rawSrc);
        if (!mergedSources.some((m) => m.url === enriched.url)) {
          mergedSources.push(enriched);
        }
      }
      existing.sources = sortAndRelabelSources(mergedSources);

      if (oldItem.episodes && oldItem.episodes.length > 0) {
        const epMap = new Map<string, SeriesEpisode>();
        for (const ep of existing.episodes || []) {
          epMap.set(`${ep.season}-${ep.episode}`, ep);
        }
        for (const ep of oldItem.episodes) {
          const epKey = `${ep.season}-${ep.episode}`;
          const targetEp = epMap.get(epKey);
          if (!targetEp) {
            epMap.set(epKey, {
              ...ep,
              sources: sortAndRelabelSources(ep.sources.map(enrichSource)),
            });
          } else {
            const combinedEpSources = [...targetEp.sources];
            for (const s of ep.sources.map(enrichSource)) {
              if (!combinedEpSources.some((m) => m.url === s.url)) {
                combinedEpSources.push(s);
              }
            }
            targetEp.sources = sortAndRelabelSources(combinedEpSources);
          }
        }
        existing.episodes = Array.from(epMap.values()).sort((a, b) =>
          a.season !== b.season ? a.season - b.season : a.episode - b.episode
        );
      }

      if (
        existing.sources.some(
          (s) => s.resolutionTag === '4K' || s.qualityTag?.includes('4K')
        )
      ) {
        existing.qualityBadge = '4K';
      }
      if (!existing.tvgLogo && oldItem.tvgLogo) {
        existing.tvgLogo = oldItem.tvgLogo;
        existing.posterImage = oldItem.tvgLogo;
      }
      if (!existing.tvgId && oldItem.tvgId) {
        existing.tvgId = oldItem.tvgId;
      }
      if (oldItem.tmdbEnriched && !existing.tmdbEnriched) {
        existing.tmdbId = oldItem.tmdbId;
        existing.synopsis = oldItem.synopsis;
        existing.cast = oldItem.cast;
        existing.director = oldItem.director;
        existing.genres = oldItem.genres;
        existing.voteAverage = oldItem.voteAverage;
        existing.posterImage = oldItem.posterImage;
        existing.backdropImage = oldItem.backdropImage;
        existing.platform = oldItem.platform;
        existing.tmdbEnriched = true;
      }
      if (!existing.youtubeTrailerId && oldItem.youtubeTrailerId) {
        existing.youtubeTrailerId = oldItem.youtubeTrailerId;
      }
      if (oldItem.status === 'publicado') {
        existing.status = 'publicado';
      } else if (oldItem.status === 'aprovado' && existing.status === 'pendente') {
        existing.status = 'aprovado';
      }
    }
  }

  const nextList = Array.from(byKey.values());
  await db.mediaItems.clear();
  if (nextList.length > 0) {
    await db.mediaItems.bulkPut(nextList);
    await syncCatalogItemsToServer(nextList, undefined, true);
  }

  return {
    beforeCount: all.length,
    afterCount: nextList.length,
    byKind,
  };
}

export const reclassifyAndRegroupCatalog = unifyAndReclassifyCatalog;

/**
 * Surgically deletes a single M3U list without erasing title sheets, IDs, favorites, or watch history:
 * - Removes only sources linked to listId.
 * - Keeps items that still have >= 1 active source from other lists (reordering 4K priority).
 * - Archives items that drop to 0 remaining sources so metadata, favorites, and progress are preserved until re-import.
 */
export async function deleteM3uList(listId: string): Promise<{
  removedItems: number;
  archivedItems: number;
  updatedItems: number;
  removedSources: number;
}> {
  const allItems = await db.mediaItems.toArray();
  const itemsToUpdate: CatalogItem[] = [];
  let archivedItems = 0;
  let updatedItems = 0;
  let removedSources = 0;

  for (const item of allItems) {
    const prevSources = item.sources || [];
    const nextSources = prevSources.filter((s) => s.listId !== listId);
    const removedFromMain = prevSources.length - nextSources.length;

    let removedFromEps = 0;
    let nextEpisodes = item.episodes;
    if (item.episodes && item.episodes.length > 0) {
      nextEpisodes = item.episodes.map((ep) => {
        const filtered = ep.sources.filter((s) => s.listId !== listId);
        removedFromEps += ep.sources.length - filtered.length;
        return {
          ...ep,
          sources: sortAndRelabelSources(filtered),
        };
      });
    }

    if (removedFromMain === 0 && removedFromEps === 0) {
      continue;
    }

    removedSources += removedFromMain + removedFromEps;

    const hasRemainingSources =
      nextSources.length > 0 ||
      (nextEpisodes?.some((ep) => ep.sources.length > 0) ?? false);

    if (!hasRemainingSources) {
      archivedItems += 1;
      itemsToUpdate.push({
        ...item,
        sources: [],
        episodes: nextEpisodes,
        archived: true,
        updatedAt: Date.now(),
      });
    } else {
      updatedItems += 1;
      const sortedSources = sortAndRelabelSources(nextSources);
      const has4k = sortedSources.some(
        (s) => s.resolutionTag === '4K' || s.qualityTag?.includes('4K')
      );

      let duration = item.duration;
      if (item.type === 'series' && nextEpisodes) {
        const activeEps = nextEpisodes.filter((ep) => ep.sources.length > 0);
        const maxSeason = Math.max(
          ...activeEps.map((e) => e.season),
          1
        );
        duration = `${maxSeason} ${
          maxSeason === 1 ? 'Temporada' : 'Temporadas'
        } · ${activeEps.length} eps`;
      }

      itemsToUpdate.push({
        ...item,
        sources: sortedSources,
        episodes: nextEpisodes,
        duration,
        archived: false,
        qualityBadge: has4k
          ? '4K'
          : item.qualityBadge === '4K'
            ? undefined
            : item.qualityBadge,
        updatedAt: Date.now(),
      });
    }
  }

  if (itemsToUpdate.length > 0) {
    await db.mediaItems.bulkPut(itemsToUpdate);
  }
  await db.m3u_lists.delete(listId);
  await deleteListOnServer(listId);

  return {
    removedItems: archivedItems,
    archivedItems,
    updatedItems,
    removedSources,
  };
}

function buildServerDisplayName(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `Servidor ${parsed.hostname}`;
  } catch {
    return rawUrl.slice(0, 48);
  }
}

async function persistListSummary(
  stats: M3UImportStats,
  name: string,
  sourceType: M3uListRecord['sourceType'],
  sourceLocation?: string,
  xtreamCredentials?: XtreamCredentials
) {
  const record: M3uListRecord = {
    id: stats.listId,
    name,
    sourceType,
    sourceLocation,
    xtreamCredentials,
    importedAt: Date.now(),
    totalEntries: stats.rawEntries,
    newItemsCreated: stats.newItems,
    mergedSourcesCount: stats.mergedSources,
    ignoredDuplicatesCount: stats.ignoredDuplicates,
  };
  await saveM3uListRecord(record);

  const touchedIds = stats.touchedItemIds || [];
  const touchedItems =
    touchedIds.length > 0
      ? (await db.mediaItems.bulkGet(touchedIds)).filter((it): it is CatalogItem =>
          Boolean(it)
        )
      : [];
  await syncCatalogItemsToServer(touchedItems, record, false);
}

export function normalizeServerUrl(rawServerUrl: string): string {
  const trimmed = rawServerUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function buildXtreamM3uUrl(creds: XtreamCredentials): string {
  const server = normalizeServerUrl(creds.serverUrl);
  const user = encodeURIComponent(creds.username.trim());
  const pass = encodeURIComponent(creds.password.trim());
  return `${server}/get.php?username=${user}&password=${pass}&type=m3u_plus&output=ts`;
}

function mapExplicitJsonType(rawType: unknown): MediaKind | null {
  if (typeof rawType !== 'string') return null;
  const t = rawType.trim().toLowerCase();
  if (!t) return null;
  if (t === 'movie' || t === 'movies' || t === 'filme' || t === 'filmes' || t === 'vod') {
    return 'movie';
  }
  if (t === 'series' || t === 'serie' || t === 'séries' || t === 'série' || t === 'tvshow' || t === 'show') {
    return 'series';
  }
  if (t === 'live' || t === 'tv' || t === 'channel' || t === 'canal' || t === 'canais' || t === 'iptv') {
    return 'live';
  }
  if (t === 'radio' || t === 'rádio' || t === 'radios' || t === 'audio' || t === 'fm' || t === 'am') {
    return 'radio';
  }
  return null;
}

function pickFirstString(
  obj: Record<string, unknown>,
  keys: string[]
): string {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
    if (typeof val === 'number' && !Number.isNaN(val)) {
      return String(val);
    }
  }
  return '';
}

interface JsonExtractedEntry {
  title: string;
  url: string;
  logo: string;
  backdrop: string;
  category: string;
  explicitType: MediaKind | null;
  year?: number;
  synopsis?: string;
  tvgId?: string;
  youtubeTrailerId?: string;
  voteAverage?: number;
  duration?: string;
  qualityHint?: string;
}

function extractEntriesFromJsonPayload(payload: unknown): JsonExtractedEntry[] {
  const results: JsonExtractedEntry[] = [];

  const collectFromList = (
    arr: unknown[],
    defaultType: MediaKind | null = null,
    defaultCategory = ''
  ) => {
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const obj = raw as Record<string, unknown>;

      const title = pickFirstString(obj, [
        'title',
        'name',
        'titulo',
        'nome',
        'tvgName',
        'tvg_name',
        'channel_name',
      ]);
      if (!title) continue;

      const logo = sanitizeLogoUrl(
        pickFirstString(obj, [
          'poster',
          'posterImage',
          'poster_path',
          'poster_url',
          'cover',
          'logo',
          'tvgLogo',
          'tvg_logo',
          'image',
          'img',
          'thumbnail',
          'thumb',
        ])
      );
      const backdrop = sanitizeLogoUrl(
        pickFirstString(obj, [
          'backdrop',
          'backdropImage',
          'backdrop_path',
          'banner',
          'background',
        ])
      );
      const category =
        pickFirstString(obj, [
          'category',
          'group',
          'groupTitle',
          'group_title',
          'genre',
          'categoria',
        ]) ||
        (Array.isArray(obj.genres) && typeof obj.genres[0] === 'string'
          ? obj.genres[0]
          : defaultCategory);

      const explicitType =
        mapExplicitJsonType(
          obj.type ?? obj.mediaKind ?? obj.kind ?? obj.media_type ?? obj.tipo
        ) || defaultType;

      const yearRaw = obj.year ?? obj.ano ?? obj.release_year;
      const parsedYear =
        typeof yearRaw === 'number'
          ? yearRaw
          : typeof yearRaw === 'string' && /^\d{4}/.test(yearRaw.trim())
            ? Number(yearRaw.trim().slice(0, 4))
            : undefined;

      const synopsis = pickFirstString(obj, [
        'synopsis',
        'overview',
        'description',
        'sinopse',
        'plot',
      ]);
      const tvgId = pickFirstString(obj, ['tvgId', 'tvg_id', 'epg_id', 'id_epg']);
      const youtubeTrailerId = pickFirstString(obj, [
        'youtubeTrailerId',
        'trailerId',
        'trailer_id',
        'youtube_id',
      ]);
      const duration = pickFirstString(obj, ['duration', 'duracao', 'runtime']);
      const qualityHint = pickFirstString(obj, ['quality', 'resolution', 'qualidade']);

      const ratingRaw = obj.voteAverage ?? obj.rating ?? obj.nota;
      const voteAverage =
        typeof ratingRaw === 'number'
          ? ratingRaw
          : typeof ratingRaw === 'string' && !Number.isNaN(Number(ratingRaw))
            ? Number(ratingRaw)
            : undefined;

      const directUrl = pickFirstString(obj, [
        'url',
        'stream_url',
        'streamUrl',
        'stream',
        'link',
        'src',
        'video_url',
        'videoUrl',
        'm3u8',
        'mp4',
        'play_url',
      ]);

      const urlsToEmit: Array<{ url: string; quality?: string }> = [];
      if (directUrl && /^https?:\/\//i.test(directUrl)) {
        urlsToEmit.push({ url: directUrl, quality: qualityHint || undefined });
      }

      if (Array.isArray(obj.sources)) {
        for (const s of obj.sources) {
          if (typeof s === 'string' && /^https?:\/\//i.test(s.trim())) {
            urlsToEmit.push({ url: s.trim() });
          } else if (s && typeof s === 'object') {
            const srcObj = s as Record<string, unknown>;
            const sUrl = pickFirstString(srcObj, ['url', 'stream_url', 'src', 'link']);
            if (sUrl && /^https?:\/\//i.test(sUrl)) {
              const sQual = pickFirstString(srcObj, ['quality', 'qualityTag', 'label']);
              urlsToEmit.push({ url: sUrl, quality: sQual || qualityHint || undefined });
            }
          }
        }
      }

      for (const entry of urlsToEmit) {
        results.push({
          title,
          url: entry.url,
          logo,
          backdrop,
          category,
          explicitType,
          year:
            parsedYear && parsedYear >= 1900 && parsedYear <= 2035
              ? parsedYear
              : undefined,
          synopsis: synopsis || undefined,
          tvgId: tvgId || undefined,
          youtubeTrailerId: youtubeTrailerId || undefined,
          voteAverage,
          duration: duration || undefined,
          qualityHint: entry.quality,
        });
      }
    }
  };

  if (Array.isArray(payload)) {
    collectFromList(payload);
    return results;
  }

  if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>;
    const typedBuckets: Array<[string, MediaKind | null]> = [
      ['items', null],
      ['catalog', null],
      ['data', null],
      ['results', null],
      ['entries', null],
      ['streams', null],
      ['list', null],
      ['movies', 'movie'],
      ['filmes', 'movie'],
      ['series', 'series'],
      ['channels', 'live'],
      ['canais', 'live'],
      ['live', 'live'],
      ['tv', 'live'],
      ['radios', 'radio'],
    ];

    for (const [key, bucketType] of typedBuckets) {
      const candidate = root[key];
      if (Array.isArray(candidate)) {
        collectFromList(candidate, bucketType);
      }
    }

    // Fallback: single catalog item object with url + title
    if (results.length === 0) {
      collectFromList([root]);
    }
  }

  return results;
}

export async function importCatalogFromJson(
  payload: unknown,
  totalBytes: number,
  options: M3UImportOptions = {}
): Promise<M3UImportStats> {
  const entries = extractEntriesFromJsonPayload(payload);
  if (entries.length === 0) {
    throw new Error(
      'O JSON retornado não contém itens válidos com título e URL de stream (title/name + url/stream_url).'
    );
  }

  const listId = options.listId || `list-${crypto.randomUUID().slice(0, 10)}`;
  const stats: M3UImportStats = {
    listId,
    detectedFormat: 'json',
    bytesRead: totalBytes,
    totalBytes,
    linesParsed: entries.length,
    rawEntries: entries.length,
    groupedItems: 0,
    newItems: 0,
    mergedSources: 0,
    ignoredDuplicates: 0,
    byKind: { movie: 0, series: 0, live: 0, radio: 0 },
    touchedItemIds: [],
  };

  const existingItems = await db.mediaItems.toArray();
  const itemByKey = new Map<string, CatalogItem>();

  for (const existing of existingItems) {
    if (existing.normalizedKey) {
      itemByKey.set(existing.normalizedKey, existing);
    }
    const parsedOrigYear = existing.originalTitle
      ? cleanTitleAndExtractYear(existing.originalTitle).year
      : undefined;
    const effectiveYear = existing.tmdbEnriched ? existing.year : parsedOrigYear;
    for (const k of getCandidateProvisionalKeys({
      type: existing.type,
      title: existing.title,
      originalTitle: existing.originalTitle,
      year: effectiveYear,
    })) {
      if (!itemByKey.has(k)) {
        itemByKey.set(k, existing);
      }
    }
  }

  const dirtyItems = new Map<string, CatalogItem>();
  const now = Date.now();

  for (const entry of entries) {
    if (options.signal?.aborted) {
      throw new DOMException('Importação cancelada', 'AbortError');
    }

    const rawTitle = entry.title;
    const mediaKind =
      entry.explicitType || classifyEntry(entry.url, rawTitle, entry.category);

    let groupItemTitle = rawTitle;
    let year = entry.year;
    let qualityTag = entry.qualityHint;
    let resolutionTag: string | undefined;
    let languageTag: string | undefined;
    let episodeInfo: ReturnType<typeof extractEpisodeInfo> = null;

    if (mediaKind === 'live') {
      const liveNorm = normalizeLiveChannelName(rawTitle);
      groupItemTitle = liveNorm.cleanChannelName;
      qualityTag = qualityTag || liveNorm.qualityTag;
      resolutionTag = liveNorm.qualityTag;
    } else if (mediaKind === 'series') {
      episodeInfo = extractEpisodeInfo(rawTitle);
      const cleaned = cleanTitleAndExtractYear(
        episodeInfo ? episodeInfo.seriesTitle : rawTitle
      );
      groupItemTitle = cleaned.cleanTitle;
      year = year || cleaned.year;
      const tags = extractSourceMetadataTags(
        `${rawTitle} ${entry.qualityHint || ''}`,
        entry.category
      );
      qualityTag = tags.qualityTag || qualityTag;
      resolutionTag = tags.resolutionTag;
      languageTag = tags.languageTag;
    } else {
      const cleaned = cleanTitleAndExtractYear(rawTitle);
      groupItemTitle = cleaned.cleanTitle;
      year = year || cleaned.year;
      const tags = extractSourceMetadataTags(
        `${rawTitle} ${entry.qualityHint || ''}`,
        entry.category
      );
      qualityTag = tags.qualityTag || qualityTag;
      resolutionTag = tags.resolutionTag;
      languageTag = tags.languageTag;
    }

    const normalizedKey = buildProvisionalKey({
      type: mediaKind,
      title: groupItemTitle,
      originalTitle: rawTitle,
      year,
    });

    let item = itemByKey.get(normalizedKey);

    const isBrandNewItem = !item;

    if (!item) {
      const cleanGroup = cleanGroupLabel(entry.category);
      const qualityBadge = detectQualityBadge(
        entry.category,
        `${rawTitle} ${entry.qualityHint || ''}`
      );
      const poster =
        entry.logo ||
        entry.backdrop ||
        (mediaKind === 'live'
          ? DEFAULT_FALLBACK_BACKDROP
          : DEFAULT_FALLBACK_POSTER);
      const backdrop = entry.backdrop || entry.logo || DEFAULT_FALLBACK_BACKDROP;

      item = {
        id: `json-${crypto.randomUUID().slice(0, 12)}`,
        normalizedKey,
        title: groupItemTitle,
        originalTitle: rawTitle,
        tvgId: entry.tvgId,
        tvgName: rawTitle,
        type: mediaKind,
        mediaKind,
        year: year ?? new Date().getFullYear(),
        genres: cleanGroup ? [cleanGroup] : [mediaKind.toUpperCase()],
        ageRating: '14',
        duration:
          entry.duration ||
          (mediaKind === 'series'
            ? '1 Temporada'
            : mediaKind === 'live'
              ? 'Ao Vivo'
              : mediaKind === 'radio'
                ? 'Rádio Digital'
                : '2h 00min'),
        durationSeconds: mediaKind === 'series' ? 3000 : 7200,
        platform: detectInitialPlatform(entry.category),
        qualityBadge,
        synopsis:
          entry.synopsis ||
          (mediaKind === 'live'
            ? `Canal de TV ao Vivo ${groupItemTitle} (${
                cleanGroup || 'Grade Aberta'
              }).`
            : mediaKind === 'radio'
              ? `Estação de áudio ${groupItemTitle} importada via catálogo JSON.`
              : `Título importado via catálogo JSON (${
                  cleanGroup || 'Catálogo Geral'
                }).`),
        cast: [],
        director: cleanGroup || 'Catálogo JSON',
        youtubeTrailerId: entry.youtubeTrailerId || '',
        voteAverage: entry.voteAverage,
        posterImage: poster,
        backdropImage: backdrop,
        tvgLogo: entry.logo || undefined,
        groupTitle: entry.category || undefined,
        categories: ['populares'],
        sources: [],
        episodes: mediaKind === 'series' ? [] : undefined,
        status: 'pendente',
        archived: false,
        healthChecked: false,
        tmdbEnriched: false,
        youtubeEnriched: Boolean(entry.youtubeTrailerId),
        createdAt: now,
        updatedAt: now,
      };

      itemByKey.set(normalizedKey, item);
      stats.groupedItems += 1;
      stats.newItems += 1;
      stats.byKind[mediaKind] += 1;
    }

    let itemModified = isBrandNewItem || Boolean(item.archived);
    if (item.archived) {
      item.archived = false;
    }
    const existingSources = item.sources ?? [];
    const alreadyHasUrl = existingSources.some((s) => s.url === entry.url);

    if (alreadyHasUrl) {
      if (!isBrandNewItem && !(mediaKind === 'series' && episodeInfo)) {
        stats.ignoredDuplicates += 1;
      }
    } else {
      const nextIndex = existingSources.length + 1;
      const nextSource: MediaSource = {
        id: `src-${nextIndex}-${now}-${Math.random().toString(36).slice(2, 6)}`,
        label: buildSourceLabel(nextIndex, qualityTag),
        qualityTag,
        resolutionTag,
        languageTag,
        originalName: rawTitle,
        url: entry.url,
        listId,
        groupTitle: entry.category || undefined,
        tvgId: entry.tvgId,
        status: 'pending',
      };
      item.sources = sortAndRelabelSources([...existingSources, nextSource]);
      itemModified = true;
      if (!isBrandNewItem) {
        stats.mergedSources += 1;
      }
    }

    if (mediaKind === 'series' && episodeInfo) {
      const episodes = item.episodes ?? [];
      const existingEp = episodes.find(
        (ep) =>
          ep.season === episodeInfo!.season &&
          ep.episode === episodeInfo!.episode
      );

      if (existingEp) {
        if (existingEp.sources.some((s) => s.url === entry.url)) {
          if (alreadyHasUrl && !isBrandNewItem) {
            stats.ignoredDuplicates += 1;
          }
        } else {
          existingEp.sources = sortAndRelabelSources([
            ...existingEp.sources,
            {
              id: `ep-src-${existingEp.sources.length + 1}-${now}`,
              label: buildSourceLabel(existingEp.sources.length + 1, qualityTag),
              qualityTag,
              resolutionTag,
              languageTag,
              originalName: rawTitle,
              url: entry.url,
              listId,
              groupTitle: entry.category || undefined,
              status: 'pending',
            },
          ]);
          itemModified = true;
        }
      } else {
        const newEp: SeriesEpisode = {
          id: `s${episodeInfo.season}e${episodeInfo.episode}`,
          season: episodeInfo.season,
          episode: episodeInfo.episode,
          title: episodeInfo.episodeTitle,
          sources: sortAndRelabelSources([
            {
              id: `ep-src-1-${now}`,
              label: buildSourceLabel(1, qualityTag),
              qualityTag,
              resolutionTag,
              languageTag,
              originalName: rawTitle,
              url: entry.url,
              listId,
              groupTitle: entry.category || undefined,
              status: 'pending',
            },
          ]),
        };
        item.episodes = [...episodes, newEp].sort((a, b) =>
          a.season !== b.season ? a.season - b.season : a.episode - b.episode
        );
        itemModified = true;
      }
    }

    if (itemModified) {
      item.updatedAt = now;
      dirtyItems.set(item.id, item);
    }
  }

  if (dirtyItems.size > 0) {
    const batch = Array.from(dirtyItems.values()).map((it) => ({
      ...it,
      archived: false,
      sources: sortAndRelabelSources(it.sources || []),
      episodes: it.episodes?.map((ep) => ({
        ...ep,
        sources: sortAndRelabelSources(ep.sources || []),
      })),
    }));
    stats.touchedItemIds = batch.map((b) => b.id);
    await db.mediaItems.bulkPut(batch);
    await authorizeStreamOrigins(extractUrlsFromCatalogItems(batch));
  }

  options.onProgress?.({ ...stats, byKind: { ...stats.byKind } });
  return stats;
}

export async function importM3UFromFile(
  file: File,
  options: M3UImportOptions = {}
): Promise<M3UImportStats> {
  const listId = options.listId || `list-${crypto.randomUUID().slice(0, 10)}`;
  const mergedOptions: M3UImportOptions = { ...options, listId };

  let stats: M3UImportStats;
  if (typeof file.stream === 'function') {
    stats = await importM3UFromStream(file.stream(), file.size, mergedOptions);
  } else {
    const chunkSize = 2 * 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let offset = 0;
          while (offset < file.size) {
            const slice = file.slice(offset, offset + chunkSize);
            const buffer = await slice.arrayBuffer();
            controller.enqueue(new Uint8Array(buffer));
            offset += chunkSize;
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
    stats = await importM3UFromStream(stream, file.size, mergedOptions);
  }

  stats.detectedFormat = 'm3u';
  await persistListSummary(
    stats,
    options.customName?.trim() || file.name,
    'file',
    file.name
  );
  return stats;
}

export async function importM3UFromText(
  text: string,
  options: M3UImportOptions = {}
): Promise<M3UImportStats> {
  const listId = options.listId || `list-${crypto.randomUUID().slice(0, 10)}`;
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stats = await importM3UFromStream(stream, bytes.byteLength, {
    ...options,
    listId,
  });
  stats.detectedFormat = 'm3u';
  await persistListSummary(
    stats,
    options.customName?.trim() || 'Lista Exemplo M3U',
    'sample'
  );
  return stats;
}

export async function importM3UFromUrl(
  url: string,
  options: M3UImportOptions = {}
): Promise<M3UImportStats> {
  const cleanUrl = url.trim();
  const listId = options.listId || `list-${crypto.randomUUID().slice(0, 10)}`;
  const resp = await fetch(
    `/api/fetch-list?url=${encodeURIComponent(cleanUrl)}`,
    { signal: options.signal }
  );

  if (!resp.ok || !resp.body) {
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(
      errBody.error || `Falha ao acessar lista remota (${resp.status}).`
    );
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error(
      'O link informado aponta para uma página HTML, e não para uma lista M3U ou API JSON direta.'
    );
  }

  const contentLength = Number(resp.headers.get('content-length') || 0);
  const headerFormat = resp.headers.get('x-list-format');
  const reader = resp.body.getReader();

  // Peek the initial bytes to confirm HTML vs JSON vs M3U safely
  const peekedChunks: Uint8Array[] = [];
  let peekedBytes = 0;
  let sampleText = '';

  while (peekedBytes < 4096) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      peekedChunks.push(value);
      peekedBytes += value.byteLength;
      sampleText += new TextDecoder().decode(value, { stream: true });
      if (sampleText.trimStart().length >= 32) break;
    }
  }

  const trimmedSample = sampleText.replace(/^\uFEFF/, '').trimStart();
  const sampleLower = trimmedSample.toLowerCase();

  if (
    sampleLower.startsWith('<!doctype') ||
    sampleLower.startsWith('<html') ||
    sampleLower.startsWith('<head') ||
    sampleLower.startsWith('<body') ||
    (sampleLower.startsWith('<') && sampleLower.includes('<html'))
  ) {
    await reader.cancel().catch(() => {});
    throw new Error(
      'O link informado aponta para uma página HTML, e não para uma lista M3U (#EXTM3U) ou catálogo JSON direto.'
    );
  }

  const looksLikeJson =
    trimmedSample.startsWith('{') ||
    trimmedSample.startsWith('[') ||
    headerFormat === 'json' ||
    contentType.includes('application/json');

  if (looksLikeJson && !trimmedSample.includes('#EXTM3U')) {
    const allChunks: Uint8Array[] = [...peekedChunks];
    let totalRead = peekedBytes;
    while (true) {
      if (options.signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException('Importação cancelada', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        allChunks.push(value);
        totalRead += value.byteLength;
      }
    }

    const merged = new Uint8Array(totalRead);
    let offset = 0;
    for (const chunk of allChunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const jsonText = new TextDecoder('utf-8').decode(merged).replace(/^\uFEFF/, '');
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonText);
    } catch {
      throw new Error(
        'A resposta parecia JSON, mas não foi possível decodificar um JSON válido.'
      );
    }

    const stats = await importCatalogFromJson(parsedJson, totalRead, {
      ...options,
      listId,
    });
    await persistListSummary(
      stats,
      options.customName?.trim() || `${buildServerDisplayName(cleanUrl)} (JSON)`,
      'json',
      cleanUrl
    );
    return stats;
  }

  const looksLikeM3u =
    trimmedSample.includes('#EXTM3U') ||
    trimmedSample.includes('#EXTINF') ||
    headerFormat === 'm3u' ||
    /^https?:\/\//i.test(trimmedSample);

  if (!looksLikeM3u) {
    await reader.cancel().catch(() => {});
    throw new Error(
      'O conteúdo retornado não é uma lista M3U (#EXTM3U / #EXTINF) nem um catálogo JSON válido.'
    );
  }

  const reconstructedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of peekedChunks) {
        controller.enqueue(chunk);
      }
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      return reader.cancel();
    },
  });

  const stats = await importM3UFromStream(reconstructedStream, contentLength, {
    ...options,
    listId,
  });
  stats.detectedFormat = 'm3u';

  const isXtream = Boolean(options.xtreamCredentials);
  const locationToSave = isXtream
    ? normalizeServerUrl(options.xtreamCredentials!.serverUrl)
    : cleanUrl;
  const defaultName = isXtream
    ? `${buildServerDisplayName(locationToSave)} (Xtream)`
    : buildServerDisplayName(cleanUrl);

  await persistListSummary(
    stats,
    options.customName?.trim() || defaultName,
    isXtream ? 'xtream' : 'url',
    locationToSave,
    options.xtreamCredentials
  );
  return stats;
}

export async function importFromXtreamCredentials(
  credentials: XtreamCredentials,
  options: M3UImportOptions = {}
): Promise<M3UImportStats> {
  const normalizedCreds: XtreamCredentials = {
    serverUrl: normalizeServerUrl(credentials.serverUrl),
    username: credentials.username.trim(),
    password: credentials.password.trim(),
  };

  if (!normalizedCreds.serverUrl || !normalizedCreds.username || !normalizedCreds.password) {
    throw new Error('Preencha Servidor, Usuário e Senha para conectar via Xtream Codes.');
  }

  const fullM3uUrl = buildXtreamM3uUrl(normalizedCreds);
  return importM3UFromUrl(fullM3uUrl, {
    ...options,
    xtreamCredentials: normalizedCreds,
  });
}

export async function resyncM3uList(
  list: M3uListRecord,
  options: Omit<M3UImportOptions, 'listId' | 'customName' | 'xtreamCredentials'> = {}
): Promise<M3UImportStats> {
  if (list.sourceType === 'xtream' && list.xtreamCredentials) {
    return importFromXtreamCredentials(list.xtreamCredentials, {
      ...options,
      listId: list.id,
      customName: list.name,
    });
  }
  if ((list.sourceType === 'url' || list.sourceType === 'json') && list.sourceLocation) {
    return importM3UFromUrl(list.sourceLocation, {
      ...options,
      listId: list.id,
      customName: list.name,
    });
  }
  throw new Error('Esta lista é de um arquivo local e não possui URL remota para re-sincronização.');
}

export const SAMPLE_M3U_SNIPPET = `#EXTM3U
#EXTINF:-1 tvg-name="Sempre Vitoriosos (2023) (2023) 1080p Legendado" tvg-logo="https://image.tmdb.org/t/p/w780/rKJvZkOtswkIdwBlLUGRbUo1YEt.jpg" group-title="Filmes | Legendados",Sempre Vitoriosos (2023) (2023) 1080p Legendado
http://topcdn.live:80/movie/571613925/429226544/8088147.mp4
#EXTINF:-1 tvg-name="Sempre Vitoriosos (2023) (2023) [4K] Dublado" tvg-logo="https://image.tmdb.org/t/p/w780/rKJvZkOtswkIdwBlLUGRbUo1YEt.jpg" group-title="❖ 2 4K",Sempre Vitoriosos (2023) (2023) [4K] Dublado
http://topcdn.live:80/movie/571613925/429226544/8088149.mp4
#EXTINF:-1 tvg-name="Star Wars: Episódio I - A Ameaça Fantasma (1999) Dublado" tvg-logo="https://image.tmdb.org/t/p/w780/n0p4Q8f0G0vM6iQ8O4w7s9jZ8wL.jpg" group-title="Filmes | Ficção",Star Wars: Episódio I - A Ameaça Fantasma (1999) Dublado
http://topcdn.live:80/movie/571613925/429226544/8088150.mp4
#EXTINF:-1 tvg-name="Barbie em O Quebra-Nozes" tvg-logo="https://image.tmdb.org//t/p/w600_and_h900_bestv2/suSGUJNCgdVVjCXcJBDtjKxWTlg.jpg" group-title="❖ 2 4K",Barbie em O Quebra-Nozes
http://topcdn.live:80/movie/571613925/429226544/8088148.mp4
#EXTINF:-1 tvg-id="GloboSP.br" tvg-name="Globo SP FHD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/TV_Globo_logo.svg/240px-TV_Globo_logo.svg.png" group-title="Canais Abertos",Globo SP FHD
http://topcdn.live:80/live/571613925/429226544/1001.ts
#EXTINF:-1 tvg-id="GloboSP.br" tvg-name="Globo SP HD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/TV_Globo_logo.svg/240px-TV_Globo_logo.svg.png" group-title="Canais Abertos",Globo SP HD
http://topcdn.live:80/live/571613925/429226544/1002.ts
#EXTINF:-1 tvg-id="GloboSP.br" tvg-name="Globo SP [Alt]" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/TV_Globo_logo.svg/240px-TV_Globo_logo.svg.png" group-title="Canais Abertos",Globo SP [Alt]
http://topcdn.live:80/live/571613925/429226544/1003`;
