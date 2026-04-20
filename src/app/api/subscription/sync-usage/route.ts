import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as { pendingCount?: number };
    const pendingCount = Math.max(0, Math.floor(Number(body.pendingCount || 0)));

    if (!pendingCount) {
      return NextResponse.json({ success: true, appliedCount: 0 }, { status: 200 });
    }

    const { data, error } = await supabase.rpc('apply_pending_trial_queries', {
      p_count: pendingCount,
    });

    if (error) {
      console.error('[SUBSCRIPTION] Failed to sync pending trial usage:', error);
      return NextResponse.json(
        { error: 'Failed to sync trial usage.' },
        { status: 500 },
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    console.error('[SUBSCRIPTION] Fatal sync-usage error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to sync trial usage.',
      },
      { status: 500 },
    );
  }
}
