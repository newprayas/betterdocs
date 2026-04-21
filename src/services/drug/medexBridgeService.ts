import type { MedexResolvedPayload } from '@/types';

const MEDEX_HELPER_PORT = 8765;
const MEDEX_HELPER_HOSTS = ['127.0.0.1', 'localhost'];
const HEALTH_TIMEOUT_MS = 1200;
const QUERY_TIMEOUT_MS = 30000;
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  payload: MedexResolvedPayload;
  cachedAt: number;
};

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
    return `${query.trim().toLowerCase()}::${includeAlternate ? 'alt' : 'base'}`;
  }

  private getCached(query: string, includeAlternate: boolean): MedexResolvedPayload | null {
    const key = this.getQueryKey(query, includeAlternate);
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return cached.payload;
  }

  private setCached(query: string, includeAlternate: boolean, payload: MedexResolvedPayload): void {
    this.cache.set(this.getQueryKey(query, includeAlternate), {
      payload,
      cachedAt: Date.now(),
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

  async queryDrug(query: string, includeAlternate = false): Promise<MedexResolvedPayload> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new Error('Drug query is empty');
    }

    const cached = this.getCached(trimmedQuery, includeAlternate);
    if (cached) return cached;

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
      throw new Error((raw as { error?: string }).error || 'MedEx query failed');
    }

    const payload = raw as MedexResolvedPayload;
    this.setCached(trimmedQuery, includeAlternate, payload);
    return payload;
  }
}

export const medexBridgeService = new MedexBridgeService();

export const isMedexHelperUnavailableError = (error: unknown): boolean =>
  error instanceof Error &&
  /MedEx local helper is not running/i.test(error.message);
