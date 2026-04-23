import { kv } from '@vercel/kv';
import { NextRequest, NextResponse } from 'next/server';
import {
  buildMedexPayload,
  MedexServerFormulationChoiceError,
  MedexServerNoExactMatchError,
} from '@/services/drug/medexServerService';
import type { MedexResolvedPayload } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_PREFIX = 'medex:payload:';

const isKvConfigured = (): boolean =>
  Boolean(
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  );

const buildCacheKey = (query: string): string => `${CACHE_PREFIX}${query.trim().toLowerCase()}`;

const enrichPayloadForResponse = (
  payload: MedexResolvedPayload,
  query: string,
  cacheStatus: 'hit' | 'miss',
  routeTotalMs: number,
): MedexResolvedPayload => ({
  ...payload,
  query,
  resolved_query: query,
  logs: {
    ...(payload.logs || {}),
    source: 'server',
    server_cache_status: cacheStatus,
    route_total_ms: routeTotalMs,
  },
});

export async function GET(req: NextRequest) {
  const started = Date.now();
  const query = req.nextUrl.searchParams.get('q')?.trim() || '';

  if (!query) {
    return NextResponse.json({ error: 'Missing q parameter' }, { status: 400 });
  }

  const normalizedQuery = query.toLowerCase();
  const cacheKey = buildCacheKey(normalizedQuery);

  try {
    if (isKvConfigured()) {
      const cached = await kv.get<MedexResolvedPayload>(cacheKey);
      if (cached) {
        const responsePayload = enrichPayloadForResponse(
          cached,
          query,
          'hit',
          Date.now() - started,
        );
        console.log('[MEDEX API] Cache hit', {
          query,
          cacheKey,
          totalMs: responsePayload.logs?.route_total_ms,
        });
        return NextResponse.json(responsePayload, { status: 200 });
      }
    } else {
      console.warn('[MEDEX API] KV not configured, serving uncached MedEx responses');
    }

    const payload = await buildMedexPayload(query);
    if (isKvConfigured()) {
      await kv.set(cacheKey, payload);
    }
    const responsePayload = enrichPayloadForResponse(payload, query, 'miss', Date.now() - started);
    console.log('[MEDEX API] Cache miss -> live fetch', {
      query,
      cacheKey,
      searchFetchMs: responsePayload.logs?.search_fetch_ms,
      brandFetchMs: responsePayload.logs?.brand_fetch_ms,
      alternateFetchMs: responsePayload.logs?.alternate_brands_fetch_ms,
      parseMs: responsePayload.logs?.parse_ms,
      totalMs: responsePayload.logs?.route_total_ms,
    });
    return NextResponse.json(responsePayload, { status: 200 });
  } catch (error) {
    if (error instanceof MedexServerNoExactMatchError) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'no_exact_match',
          query: error.queryName,
          suggestions: error.suggestions,
        },
        { status: 404 },
      );
    }

    if (error instanceof MedexServerFormulationChoiceError) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'formulation_choice_required',
          query: error.queryName,
          drug: error.drugName,
          suggestions: error.suggestions,
          prompt: error.prompt,
        },
        { status: 409 },
      );
    }

    console.error('[MEDEX API] Fatal error', {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'MedEx query failed' },
      { status: 500 },
    );
  }
}
