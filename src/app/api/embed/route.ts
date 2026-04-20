import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { parseSubscriptionStatusPayload } from '@/utils/subscription';

const VOYAGE_EMBEDDING_MODEL = process.env.VOYAGE_EMBEDDING_MODEL || 'voyage-4-large';
const VOYAGE_EMBEDDING_DIMENSION = Number(process.env.VOYAGE_EMBEDDING_DIMENSION || '1024');
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: accessPayload, error: accessError } = await supabase.rpc(
      'get_subscription_access_status',
    );

    if (accessError) {
      console.error('[API PROXY] Failed to verify subscription access:', accessError);
      return NextResponse.json({ error: 'Failed to verify subscription access.' }, { status: 500 });
    }

    const accessStatus = parseSubscriptionStatusPayload(accessPayload);
    if (!accessStatus?.hasAccess) {
      return NextResponse.json(
        {
          error: 'Your free questions are finished. Please redeem a subscription code to continue.',
          status: accessPayload,
        },
        { status: 402 },
      );
    }

    const body = (await req.json()) as { text?: string };
    const text = String(body.text || '').trim();
    const voyageApiKey = process.env.VOYAGE_API_KEY || process.env.NEXT_PUBLIC_VOYAGE_API_KEY;

    if (!text) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    if (!voyageApiKey) {
      return NextResponse.json(
        { error: 'Missing Voyage API key. Set VOYAGE_API_KEY in environment.' },
        { status: 500 },
      );
    }

    const voyageResponse = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${voyageApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: [text],
        model: VOYAGE_EMBEDDING_MODEL,
        output_dimension: VOYAGE_EMBEDDING_DIMENSION,
      }),
    });

    if (!voyageResponse.ok) {
      const errorText = await voyageResponse.text();
      console.error('[API PROXY] Voyage embedding failed:', errorText);
      return NextResponse.json(
        { error: 'Failed to process embedding', details: errorText },
        { status: voyageResponse.status },
      );
    }

    const result = await voyageResponse.json();
    const values = result?.data?.[0]?.embedding;

    if (!Array.isArray(values) || values.length === 0) {
      return NextResponse.json(
        { error: 'Voyage returned an invalid embedding payload' },
        { status: 502 },
      );
    }

    return NextResponse.json({ embedding: values });
  } catch (error: any) {
    console.error('[API PROXY] Fatal error:', error);
    return NextResponse.json(
      { error: 'Failed to process embedding', details: error.message },
      { status: 500 },
    );
  }
}
