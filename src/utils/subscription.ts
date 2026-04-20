export type SubscriptionPlanId = '1 Month' | '3 Months';
export type SubscriptionAccessType = 'trial' | 'subscription' | 'none';

export interface SubscriptionPlanDefinition {
  id: SubscriptionPlanId;
  name: string;
  duration: string;
  durationDays: number;
  price: number;
  savingsText?: string;
}

export interface SubscriptionStatus {
  hasAccess: boolean;
  accessType: SubscriptionAccessType;
  isTrialExpired: boolean;
  isSubscriptionExpired: boolean;
  daysRemaining: number | null;
  checkedFromServer: boolean;
  trialQueriesUsed: number;
  trialQueryLimit: number;
  remainingTrialQueries: number;
  subscriptionExpiresAt: string | null;
  subscriptionPlan: string | null;
}

export const DEFAULT_TRIAL_QUERY_LIMIT = 30;
export const SUBSCRIPTION_REFRESH_EVENT = 'subscription:refresh';

export const SUBSCRIPTION_PLANS: SubscriptionPlanDefinition[] = [
  {
    id: '1 Month',
    name: '1 month',
    duration: '30 days',
    durationDays: 30,
    price: 150,
  },
  {
    id: '3 Months',
    name: '3 months',
    duration: '90 days',
    durationDays: 90,
    price: 350,
    savingsText: 'Save 100 tk',
  },
];

export function parseSubscriptionStatusPayload(
  payload: unknown,
  checkedFromServer = true,
): SubscriptionStatus | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const status = payload as Record<string, unknown>;
  const trialQueryLimit = toWholeNumber(status.trial_query_limit, DEFAULT_TRIAL_QUERY_LIMIT);
  const trialQueriesUsed = toWholeNumber(status.trial_queries_used, 0);
  const remainingTrialQueries = Math.max(
    0,
    toWholeNumber(status.remaining_trial_queries, trialQueryLimit - trialQueriesUsed),
  );

  return {
    hasAccess: Boolean(status.has_access),
    accessType: normalizeAccessType(status.access_type),
    isTrialExpired: Boolean(status.is_trial_expired),
    isSubscriptionExpired: Boolean(status.is_subscription_expired),
    daysRemaining: toNullableWholeNumber(status.days_remaining),
    checkedFromServer,
    trialQueriesUsed,
    trialQueryLimit,
    remainingTrialQueries,
    subscriptionExpiresAt: toNullableString(status.subscription_expires_at),
    subscriptionPlan: toNullableString(status.subscription_plan),
  };
}

function normalizeAccessType(value: unknown): SubscriptionAccessType {
  if (value === 'trial' || value === 'subscription') {
    return value;
  }

  return 'none';
}

function toWholeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }

  return fallback;
}

function toNullableWholeNumber(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }

  return null;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
