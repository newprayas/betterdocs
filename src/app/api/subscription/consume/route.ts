import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized', allowed: false }, { status: 401 });
    }

    const { data, error } = await supabase.rpc('consume_trial_query_if_needed');
    if (error) {
      console.error('[SUBSCRIPTION] Failed to consume query access:', error);
      return NextResponse.json(
        { error: 'Failed to verify query access.', allowed: false },
        { status: 500 },
      );
    }

    const allowed = Boolean((data as Record<string, unknown> | null)?.allowed);
    return NextResponse.json(data, { status: allowed ? 200 : 402 });
  } catch (error) {
    console.error('[SUBSCRIPTION] Fatal consume-query error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to verify query access.',
        allowed: false,
      },
      { status: 500 },
    );
  }
}
