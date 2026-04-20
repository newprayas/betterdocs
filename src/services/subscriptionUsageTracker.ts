'use client';

import { createClient } from '@/utils/supabase/client';

const STORAGE_KEY = 'subscription_pending_trial_usage_v1';
const SUBSCRIPTION_CACHE_KEY = 'subscription_check_cache';

type PendingUsageMap = Record<string, number>;

function getPendingUsageMap(): PendingUsageMap {
  if (typeof window === 'undefined') return {};

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PendingUsageMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return {};
  }
}

function setPendingUsageMap(value: PendingUsageMap): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (error) {
    console.warn('[SUBSCRIPTION] Failed to store pending trial usage:', error);
  }
}

export async function incrementLocalTrialUsage(): Promise<void> {
  if (!shouldTrackTrialUsageFromCache()) {
    return;
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const map = getPendingUsageMap();
  map[user.id] = Math.max(0, Math.floor((map[user.id] || 0) + 1));
  setPendingUsageMap(map);
}

export async function flushPendingTrialUsage(): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const map = getPendingUsageMap();
  const pendingCount = Math.max(0, Math.floor(map[user.id] || 0));
  if (!pendingCount) return;

  const response = await fetch('/api/subscription/sync-usage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pendingCount }),
  });

  if (!response.ok) {
    const payload = await safeJsonParse(response);
    const message =
      typeof payload?.error === 'string'
        ? payload.error
        : 'Failed to sync pending trial usage.';
    throw new Error(message);
  }

  const nextMap = getPendingUsageMap();
  delete nextMap[user.id];
  setPendingUsageMap(nextMap);
}

async function safeJsonParse(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function shouldTrackTrialUsageFromCache(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const raw = localStorage.getItem(SUBSCRIPTION_CACHE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as {
      status?: {
        accessType?: string;
      };
    };

    return parsed?.status?.accessType === 'trial';
  } catch {
    return true;
  }
}
