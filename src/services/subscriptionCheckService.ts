'use client';

import { createClient } from '@/utils/supabase/client';
import {
  DEFAULT_TRIAL_QUERY_LIMIT,
  type SubscriptionStatus,
  parseSubscriptionStatusPayload,
} from '@/utils/subscription';

const COOLDOWN_MS = 5 * 60 * 1000;
const BUFFER_HOURS = 6;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'subscription_check_cache';

interface SubscriptionCache {
  lastCheck: number;
  userId: string;
  status: Omit<SubscriptionStatus, 'checkedFromServer'>;
}

function getLocalCache(): SubscriptionCache | null {
  if (typeof window === 'undefined') return null;

  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (!cached) return null;
    return JSON.parse(cached) as SubscriptionCache;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function setLocalCache(cache: SubscriptionCache): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.warn('[SUBSCRIPTION] Failed to save cache:', error);
  }
}

export function clearSubscriptionCache(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

function shouldSkipServerCheck(
  cache: SubscriptionCache | null,
  userId: string,
): { skip: boolean; reason: string } {
  if (!cache) {
    return { skip: false, reason: 'no-cache' };
  }

  if (cache.userId !== userId) {
    return { skip: false, reason: 'user-changed' };
  }

  const now = Date.now();
  const timeSinceLastCheck = now - cache.lastCheck;

  if (timeSinceLastCheck > MAX_CACHE_AGE_MS) {
    return { skip: false, reason: 'cache-too-old-24h' };
  }

  if (timeSinceLastCheck < COOLDOWN_MS) {
    return { skip: true, reason: 'cooldown-active' };
  }

  if (cache.status.accessType === 'subscription' && cache.status.subscriptionExpiresAt) {
    const hoursUntilExpiry =
      (new Date(cache.status.subscriptionExpiresAt).getTime() - now) / (1000 * 60 * 60);

    if (hoursUntilExpiry > BUFFER_HOURS) {
      return { skip: true, reason: 'subscription-valid-beyond-buffer' };
    }
  }

  return { skip: false, reason: 'check-needed' };
}

function calculateStatusFromCache(cache: SubscriptionCache): SubscriptionStatus {
  return {
    ...cache.status,
    checkedFromServer: false,
  };
}

export async function checkSubscriptionStatus(
  forceServerCheck = false,
): Promise<SubscriptionStatus | null> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const cache = getLocalCache();

  if (!forceServerCheck) {
    const { skip } = shouldSkipServerCheck(cache, user.id);
    if (skip && cache) {
      return calculateStatusFromCache(cache);
    }
  }

  const { data, error } = await supabase.rpc('get_subscription_access_status');
  if (error) {
    console.error('[SUBSCRIPTION] Failed to fetch access status:', error);
    if (cache && cache.userId === user.id) {
      return calculateStatusFromCache(cache);
    }

    return {
      hasAccess: false,
      accessType: 'none',
      isTrialExpired: true,
      isSubscriptionExpired: true,
      daysRemaining: null,
      checkedFromServer: true,
      trialQueriesUsed: DEFAULT_TRIAL_QUERY_LIMIT,
      trialQueryLimit: DEFAULT_TRIAL_QUERY_LIMIT,
      remainingTrialQueries: 0,
      subscriptionExpiresAt: null,
      subscriptionPlan: null,
    };
  }

  const status = parseSubscriptionStatusPayload(data, true);
  if (!status) {
    return null;
  }

  setLocalCache({
    lastCheck: Date.now(),
    userId: user.id,
    status: toCacheStatus(status),
  });

  return status;
}

export function setupVisibilityChangeListener(
  onStatusChange: (status: SubscriptionStatus) => void,
): () => void {
  if (typeof document === 'undefined') {
    return () => {};
  }

  const handleVisibilityChange = async () => {
    if (document.visibilityState === 'visible') {
      const status = await checkSubscriptionStatus();
      if (status) {
        onStatusChange(status);
      }
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

function toCacheStatus(status: SubscriptionStatus): Omit<SubscriptionStatus, 'checkedFromServer'> {
  const { checkedFromServer: _checkedFromServer, ...cacheStatus } = status;
  return cacheStatus;
}
