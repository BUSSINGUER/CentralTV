import { CatalogItem } from '../types/streaming';

export function redactUrlCredentials(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(
      rawUrl,
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    );

    if (parsed.pathname === '/api/stream' || parsed.pathname === '/api/stream/proxy') {
      const inner = parsed.searchParams.get('url');
      if (inner) {
        return `${parsed.pathname}?url=${redactUrlCredentials(inner)}`;
      }
    }

    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';

    const sensitiveParams = [
      'username',
      'user',
      'password',
      'pass',
      'pwd',
      'token',
      'auth',
      'apikey',
      'api_key',
      'key',
      'sig',
      'signature',
    ];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (sensitiveParams.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '***');
      }
    }

    // Mask Xtream Codes style paths: /(live|movie|series)/<user>/<pass>/<id>
    parsed.pathname = parsed.pathname.replace(
      /^(\/(?:live|movie|series))\/([^/]+)\/([^/]+)(\/.*)?$/i,
      '$1/***/***$4'
    );

    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
  }
}

export async function authorizeStreamOrigins(urls: string[]): Promise<void> {
  const uniqueOrigins = new Set<string>();
  for (const raw of urls) {
    if (!raw || !/^https?:\/\//i.test(raw)) continue;
    try {
      const u = new URL(raw);
      uniqueOrigins.add(`${u.protocol}//${u.host}`);
    } catch {
      // Ignore malformed URLs
    }
  }

  if (uniqueOrigins.size === 0) return;

  try {
    await fetch('/api/stream/authorize-origins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origins: Array.from(uniqueOrigins) }),
    });
  } catch {
    // Non-fatal if offline
  }
}

export function extractUrlsFromCatalogItems(items: CatalogItem[]): string[] {
  const urls: string[] = [];
  for (const item of items) {
    for (const s of item.sources || []) {
      if (s.url) urls.push(s.url);
    }
    for (const ep of item.episodes || []) {
      for (const s of ep.sources || []) {
        if (s.url) urls.push(s.url);
      }
    }
  }
  return urls;
}
