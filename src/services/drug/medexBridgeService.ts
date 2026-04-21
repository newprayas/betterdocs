import { getIndexedDBServices } from '@/services/indexedDB';
import type { MedexResolvedPayload } from '@/types';

const MEDEX_HELPER_PORT = 8765;
const MEDEX_HELPER_HOSTS = ['127.0.0.1', 'localhost'];
const HEALTH_TIMEOUT_MS = 1200;
const QUERY_TIMEOUT_MS = 30000;
const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;
const MEDEX_CACHE_SCHEMA_VERSION = 'v3';
const LOCAL_HELPER_HOSTNAME_SET = new Set(['localhost', '127.0.0.1']);

type CacheEntry = {
  payload: MedexResolvedPayload;
  cachedAt: number;
};

export class MedexNoExactMatchError extends Error {
  queryName: string;

  suggestions: string[];

  constructor(queryName: string, suggestions: string[], message?: string) {
    super(message || `No exact MedEx result found for '${queryName}'`);
    this.name = 'MedexNoExactMatchError';
    this.queryName = queryName;
    this.suggestions = suggestions;
  }
}

const withTimeout = async <T>(promiseFactory: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timer = 0;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      window.clearTimeout(timer);
    }
  }
};

class MedexBridgeService {
  private baseUrl: string | null = null;

  private cache = new Map<string, CacheEntry>();

  private getQueryKey(query: string, includeAlternate: boolean): string {
    return `${MEDEX_CACHE_SCHEMA_VERSION}::${query.trim().toLowerCase()}::${includeAlternate ? 'alt' : 'base'}`;
  }

  private getCached(query: string, includeAlternate: boolean): MedexResolvedPayload | null {
    const key = this.getQueryKey(query, includeAlternate);
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > MEMORY_CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    console.log('[MEDEX CACHE] Memory hit', {
      query,
      includeAlternate,
      ageMs: Date.now() - cached.cachedAt,
    });
    return cached.payload;
  }

  private setCached(query: string, includeAlternate: boolean, payload: MedexResolvedPayload): void {
    this.cache.set(this.getQueryKey(query, includeAlternate), {
      payload,
      cachedAt: Date.now(),
    });
  }

  private async getPersistentCached(
    query: string,
    includeAlternate: boolean,
  ): Promise<MedexResolvedPayload | null> {
    if (typeof window === 'undefined') return null;

    const cacheService = getIndexedDBServices().medexCacheService;
    const directKey = this.getQueryKey(query, includeAlternate);
    const fallbackKey = includeAlternate ? null : this.getQueryKey(query, true);

    const directRecord = await cacheService.getCache(directKey);
    const fallbackRecord = fallbackKey ? await cacheService.getCache(fallbackKey) : undefined;
    const record = directRecord || fallbackRecord;

    if (!record) return null;

    console.log('[MEDEX CACHE] IndexedDB hit', {
      query,
      includeAlternate,
      cachedAt: record.cachedAt,
      reusedAlternatePayload: !directRecord && !!fallbackRecord,
    });
    this.setCached(query, includeAlternate || record.includeAlternate, record.payload);
    return record.payload;
  }

  private async setPersistentCached(
    query: string,
    includeAlternate: boolean,
    payload: MedexResolvedPayload,
  ): Promise<void> {
    if (typeof window === 'undefined') return;

    await getIndexedDBServices().medexCacheService.saveCache({
      id: this.getQueryKey(query, includeAlternate),
      query: query.trim(),
      normalizedQuery: query.trim().toLowerCase(),
      includeAlternate,
      cachedAt: new Date().toISOString(),
      payload,
    });
  }

  private async discoverBaseUrl(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;

    if (typeof window === 'undefined') {
      throw new Error('MedEx local helper is only available in the browser');
    }

    for (const host of MEDEX_HELPER_HOSTS) {
      const candidate = `http://${host}:${MEDEX_HELPER_PORT}`;
      try {
        const response = await withTimeout(
          () =>
            fetch(`${candidate}/health`, {
              method: 'GET',
            }),
          HEALTH_TIMEOUT_MS,
        );

        if (!response.ok) continue;

        const payload = (await response.json()) as { ok?: boolean };
        if (payload.ok) {
          this.baseUrl = candidate;
          return candidate;
        }
      } catch {
        // try next host
      }
    }

    throw new Error(
      'MedEx local helper is not running. Start scraping-scripts/medex_local_helper.py on this device first.',
    );
  }

  private shouldPreferLocalHelper(): boolean {
    if (typeof window === 'undefined') return false;
    return LOCAL_HELPER_HOSTNAME_SET.has(window.location.hostname);
  }

  private async queryViaServerRoute(query: string): Promise<MedexResolvedPayload> {
    const url = new URL('/api/medex/query', window.location.origin);
    url.searchParams.set('q', query);

    const response = await withTimeout(
      () =>
        fetch(url.toString(), {
          method: 'GET',
        }),
      QUERY_TIMEOUT_MS,
    );

    const raw = (await response.json()) as MedexResolvedPayload | { error?: string };
    if (!response.ok) {
      const errorPayload = raw as {
        error?: string;
        code?: string;
        query?: string;
        suggestions?: string[];
      };
      if (errorPayload.code === 'no_exact_match') {
        throw new MedexNoExactMatchError(
          errorPayload.query || query,
          Array.isArray(errorPayload.suggestions) ? errorPayload.suggestions : [],
          errorPayload.error || 'No exact MedEx match found',
        );
      }
      throw new Error(errorPayload.error || 'MedEx query failed');
    }

    const payload = raw as MedexResolvedPayload;
    console.log('[MEDEX SERVER]', 'Route response', {
      query,
      cacheStatus: payload.logs?.server_cache_status || 'unknown',
      searchFetchMs: payload.logs?.search_fetch_ms ?? null,
      brandFetchMs: payload.logs?.brand_fetch_ms ?? null,
      alternateFetchMs: payload.logs?.alternate_brands_fetch_ms ?? null,
      parseMs: payload.logs?.parse_ms ?? null,
      routeTotalMs: payload.logs?.route_total_ms ?? null,
    });
    return payload;
  }

  async queryDrug(query: string, includeAlternate = false): Promise<MedexResolvedPayload> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new Error('Drug query is empty');
    }

    const cached = this.getCached(trimmedQuery, includeAlternate);
    if (cached) return cached;

    const persistentCached = await this.getPersistentCached(trimmedQuery, includeAlternate);
    if (persistentCached) return persistentCached;

    console.log('[MEDEX CACHE] Miss -> live fetch', {
      query: trimmedQuery,
      includeAlternate,
    });

    let payload: MedexResolvedPayload;
    if (this.shouldPreferLocalHelper()) {
      try {
        const baseUrl = await this.discoverBaseUrl();
        const url = new URL(`${baseUrl}/query`);
        url.searchParams.set('q', trimmedQuery);
        if (includeAlternate) {
          url.searchParams.set('include_alternate', '1');
        }

        const response = await withTimeout(
          () =>
            fetch(url.toString(), {
              method: 'GET',
            }),
          QUERY_TIMEOUT_MS,
        );

        const raw = (await response.json()) as MedexResolvedPayload | { error?: string };
        if (!response.ok) {
          const errorPayload = raw as {
            error?: string;
            code?: string;
            query?: string;
            suggestions?: string[];
          };
          if (errorPayload.code === 'no_exact_match') {
            throw new MedexNoExactMatchError(
              errorPayload.query || trimmedQuery,
              Array.isArray(errorPayload.suggestions) ? errorPayload.suggestions : [],
              errorPayload.error || 'No exact MedEx match found',
            );
          }
          throw new Error(errorPayload.error || 'MedEx query failed');
        }

        payload = raw as MedexResolvedPayload;
      } catch (error) {
        if (isMedexHelperUnavailableError(error)) {
          console.warn('[MEDEX BRIDGE] Local helper unavailable, falling back to server route', {
            query: trimmedQuery,
          });
          payload = await this.queryViaServerRoute(trimmedQuery);
        } else {
          throw error;
        }
      }
    } else {
      payload = await this.queryViaServerRoute(trimmedQuery);
    }

    this.setCached(trimmedQuery, includeAlternate, payload);
    await this.setPersistentCached(trimmedQuery, includeAlternate, payload);
    console.log('[MEDEX CACHE] Saved', {
      query: trimmedQuery,
      includeAlternate,
    });
    return payload;
  }
}

export const medexBridgeService = new MedexBridgeService();

export const isMedexHelperUnavailableError = (error: unknown): boolean =>
  error instanceof Error &&
  /MedEx local helper is not running/i.test(error.message);

export const isMedexNoExactMatchError = (error: unknown): error is MedexNoExactMatchError =>
  error instanceof MedexNoExactMatchError;
