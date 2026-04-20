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
      return NextResponse.json({ error: 'Unauthorized', success: false }, { status: 401 });
    }

    const body = (await req.json()) as { code?: string };
    const code = String(body.code || '').trim();

    if (!code) {
      return NextResponse.json(
        { error: 'Please enter a code.', success: false },
        { status: 400 },
      );
    }

    const { data, error } = await supabase.rpc('redeem_subscription_code', {
      p_code: code,
    });

    if (error) {
      console.error('[SUBSCRIPTION] Failed to redeem subscription code:', error);
      return NextResponse.json(
        { error: 'Failed to redeem the code.', success: false },
        { status: 500 },
      );
    }

    const success = Boolean((data as Record<string, unknown> | null)?.success);
    return NextResponse.json(data, { status: success ? 200 : 400 });
  } catch (error) {
    console.error('[SUBSCRIPTION] Fatal redeem error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to redeem the code.',
        success: false,
      },
      { status: 500 },
    );
  }
}
