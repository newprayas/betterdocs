'use client';

import { SUBSCRIPTION_REFRESH_EVENT, type SubscriptionStatus, parseSubscriptionStatusPayload } from '@/utils/subscription';

export interface ConsumeQueryAccessResult {
  allowed: boolean;
  reason: string;
  status: SubscriptionStatus | null;
}

export interface RedeemSubscriptionCodeResult {
  success: boolean;
  error?: string;
  status: SubscriptionStatus | null;
}

export async function consumeQueryAccess(): Promise<ConsumeQueryAccessResult> {
  const response = await fetch('/api/subscription/consume', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const payload = await safeJsonParse(response);
  const status = parseSubscriptionStatusPayload(payload);

  if (!response.ok) {
    return {
      allowed: false,
      reason: typeof payload?.error === 'string' ? payload.error : 'Failed to verify access.',
      status,
    };
  }

  return {
    allowed: Boolean(payload?.allowed),
    reason: typeof payload?.reason === 'string' ? payload.reason : 'unknown',
    status,
  };
}

export async function redeemSubscriptionCode(code: string): Promise<RedeemSubscriptionCodeResult> {
  const response = await fetch('/api/subscription/redeem', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });

  const payload = await safeJsonParse(response);
  const status = parseSubscriptionStatusPayload(payload?.status ?? payload);

  if (!response.ok) {
    return {
      success: false,
      error: typeof payload?.error === 'string' ? payload.error : 'Failed to redeem the code.',
      status,
    };
  }

  return {
    success: Boolean(payload?.success),
    error: typeof payload?.error === 'string' ? payload.error : undefined,
    status,
  };
}

export function notifySubscriptionRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SUBSCRIPTION_REFRESH_EVENT));
}

async function safeJsonParse(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
