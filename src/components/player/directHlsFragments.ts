import Hls, { type FragmentLoaderContext, type HlsConfig, type LoaderCallbacks, type LoaderConfiguration } from 'hls.js';

export function directFragmentUrl(url: string, page: string): URL | undefined {
  try {
    const proxy = new URL(url, page);
    if (proxy.origin !== new URL(page).origin ||
      !['/api/stream', '/api/stream/proxy'].includes(proxy.pathname) ||
      [...proxy.searchParams.keys()].some((key) => key !== 'url')) return;
    const target = new URL(proxy.searchParams.get('url') ?? '');
    if (target.protocol === 'https:' && !target.username && !target.password) return target;
  } catch {
    return;
  }
}

export function makeDirectFragmentLoader(): NonNullable<HlsConfig['fLoader']> {
  const BaseLoader = Hls.DefaultConfig.loader as unknown as NonNullable<HlsConfig['fLoader']>;
  const retryAfter = new Map<string, number>();
  return class {
    private loader: InstanceType<typeof BaseLoader>;

    constructor(private readonly config: HlsConfig) {
      this.loader = new BaseLoader(config);
    }

    get context() { return this.loader.context; }
    get stats() { return this.loader.stats; }
    destroy() { this.loader.destroy(); }
    abort() { this.loader.abort(); }
    getCacheAge() { return this.loader.getCacheAge?.() ?? null; }
    getResponseHeader(name: string) { return this.loader.getResponseHeader?.(name) ?? null; }

    load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>) {
      const direct = directFragmentUrl(context.url, location.href);
      if (!direct || (retryAfter.get(direct.origin) ?? 0) > Date.now()) {
        this.loader.load(context, config, callbacks);
        return;
      }

      const fallback = () => {
        retryAfter.set(direct.origin, Date.now() + 5 * 60_000);
        const retry = this.loader.stats.retry;
        this.loader.destroy();
        this.loader = new BaseLoader(this.config);
        this.loader.stats.retry = retry;
        if (context.part) context.part.stats = this.loader.stats;
        else context.frag.stats = this.loader.stats;
        this.loader.load(context, config, callbacks);
      };
      this.loader.load({ ...context, url: direct.href }, {
        ...config,
        timeout: Math.min(config.timeout, 2500),
        loadPolicy: {
          ...config.loadPolicy,
          maxTimeToFirstByteMs: Math.min(config.loadPolicy.maxTimeToFirstByteMs, 2500),
          maxLoadTimeMs: Math.min(config.loadPolicy.maxLoadTimeMs, 5000),
          timeoutRetry: null,
          errorRetry: null,
        },
      }, {
        ...callbacks,
        onProgress: undefined,
        onError: fallback,
        onTimeout: fallback,
        onAbort: (stats, _context, details) => callbacks.onAbort?.(stats, context, details),
        onSuccess: (response, stats, _context, details) => {
          const contentType = this.getResponseHeader('content-type') || '';
          if (!(response.data instanceof ArrayBuffer) || !response.data.byteLength ||
            /text\/html|application\/json/i.test(contentType) ||
            ((context.rangeEnd ?? 0) > 0 && response.code !== 206)) {
            fallback();
            return;
          }
          callbacks.onProgress?.(stats, context, response.data, details);
          callbacks.onSuccess(response, stats, context, details);
        },
      });
    }
  };
}
