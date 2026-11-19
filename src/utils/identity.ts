import type { MediaKind, MediaSource } from '../types/streaming.ts';

export function normalizeTextKey(input: string): string {
  return input
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
    .replace(
      /\s*[-–|]?\s*\b(?:S\d{1,2}\s*[ExX]\d{1,3}|T\d{1,2}\s*[ExX]\d{1,3}|\d{1,2}x\d{1,3})\b.*$/i,
      ''
    )
    .trim();

  const yearMatches = Array.from(
    working.matchAll(/(?:[\[(]\s*|\b)((?:19|20)\d{2})(?:\s*[\])]|\b)/g)
  );
  const year =
    yearMatches.length > 0
      ? Number(yearMatches[yearMatches.length - 1][1])
      : undefined;

  working = working
    .replace(/\s*[\[(]\s*(?:19|20)\d{2}\s*[\])]\s*/g, ' ')
    .replace(/\s+(?:19|20)\d{2}\s*$/g, ' ')
    .replace(
      /\s*[\[(]\s*(?:4K|UHD|2160p|1080p|720p|480p|FHD|HD|SD|H265|HEVC|H\.265|x264|x265|WEB-DL|WEBRip|BluRay|HDR|DV|DUB|DUBLADO|LEG|LEGENDADO|DUAL|NACIONAL|IMAX|CAM|HDTS|60FPS|ALT)\s*[\])]/gi,
      ' '
    )
    .replace(
      /\b(?:4K|UHD|2160p|1080p|720p|480p|FHD|HD|SD|H265|HEVC|H\.265|x264|x265|WEB-DL|WEBRip|BluRay|Dublado|Legendado|Dual\s*Áudio|Dual\s*Audio|Nacional)\b/gi,
      ' '
    )
    .replace(/\s*[-–|/:]+\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    cleanTitle: working || rawTitle.trim(),
    year:
      typeof year === 'number' && year >= 1900 && year <= 2035
        ? year
        : undefined,
  };
}

export function normalizeLiveChannelTitle(rawName: string): string {
  const cleaned = rawName
    .replace(
      /\s*[\[(]\s*(?:4K|UHD|FHD|HD|SD|H265|HEVC|ALT|BACKUP|RESERVA|1|2|3)\s*[\])]/gi,
      ' '
    )
    .replace(
      /\s+\b(?:4K|UHD|FHD|HD|SD|H265|HEVC|60FPS|H\.265|BACKUP|ALT)\b/gi,
      ' '
    )
    .replace(/\s*[-–|]+\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || rawName.trim();
}

/**
 * Generates a strict provisional match key used when TMDB ID is absent:
 * - For 'movie' & 'series': type + normalizedTitle + exact year (or 'unyeared' so dated works never collide with undated or differently dated works).
 * - For 'live' & 'radio': type + normalizedTitle.
 */
export function buildProvisionalKey(params: {
  type: MediaKind;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
}): string {
  const { type, title, originalTitle, year } = params;

  if (type === 'live' || type === 'radio') {
    const channelName = normalizeLiveChannelTitle(originalTitle || title);
    return `${type}::${normalizeTextKey(channelName)}`;
  }

  const cleaned = cleanTitleAndExtractYear(title);
  const cleanedOrig = originalTitle
    ? cleanTitleAndExtractYear(originalTitle)
    : null;

  const baseTitle = cleaned.cleanTitle || cleanedOrig?.cleanTitle || title;
  const resolvedYear =
    typeof year === 'number' && year >= 1900 && year <= 2035
      ? year
      : cleaned.year ?? cleanedOrig?.year;

  return `${type}::${normalizeTextKey(baseTitle)}::${resolvedYear ?? 'unyeared'}`;
}

/**
 * Generates candidate provisional keys (from both current title and originalTitle)
 * so TMDB-localized titles still match re-imported M3U entries when exact year matches.
 */
export function getCandidateProvisionalKeys(params: {
  type: MediaKind;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
}): string[] {
  const keys = new Set<string>();
  keys.add(
    buildProvisionalKey({
      type: params.type,
      title: params.title,
      originalTitle: null,
      year: params.year,
    })
  );
  if (params.originalTitle) {
    keys.add(
      buildProvisionalKey({
        type: params.type,
        title: params.originalTitle,
        originalTitle: params.originalTitle,
        year: params.year,
      })
    );
  }
  return Array.from(keys);
}

export function extractServerOrigin(rawUrl?: string | null): {
  baseUrl: string;
  name: string;
} | null {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl.trim())) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const baseUrl = `${parsed.protocol}//${parsed.host}`.toLowerCase();
    return {
      baseUrl,
      name: `Servidor ${parsed.hostname}`,
    };
  } catch {
    return null;
  }
}

export function getSourcePriorityScore(src: Pick<MediaSource, 'qualityTag' | 'resolutionTag' | 'label'>): number {
  const joined = `${src.resolutionTag || ''} ${src.qualityTag || ''} ${src.label || ''}`.toUpperCase();
  if (joined.includes('4K') || joined.includes('2160P') || joined.includes('UHD')) {
    return 400;
  }
  if (joined.includes('FHD') || joined.includes('1080P')) {
    return 300;
  }
  if (joined.includes('HD') || joined.includes('720P')) {
    return 200;
  }
  if (joined.includes('SD') || joined.includes('480P')) {
    return 100;
  }
  return 50;
}

export function sortAndRelabelSourcesList(sources: MediaSource[]): MediaSource[] {
  const sorted = [...sources].sort(
    (a, b) => getSourcePriorityScore(b) - getSourcePriorityScore(a)
  );
  return sorted.map((src, idx) => {
    const tag =
      src.qualityTag ||
      [src.resolutionTag, src.languageTag].filter(Boolean).join(' · ') ||
      undefined;
    return {
      ...src,
      label: tag ? `Fonte ${idx + 1} · ${tag}` : `Fonte ${idx + 1}`,
    };
  });
}
