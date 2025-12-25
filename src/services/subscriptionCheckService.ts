'use client'

import { createClient } from '@/utils/supabase/client'

// Constants
const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
const BUFFER_HOURS = 6 // Skip server check if subscription ends in > 6 hours (nervous at 6h)
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000 // Force server check if cache is older than 24 hours
const STORAGE_KEY = 'subscription_check_cache'

// Plan duration in days - matches Supabase subscription_plan values
const PLAN_DURATIONS: Record<string, number> = {
    '1 Month': 30,
    '3 Months': 90,
    '6 Months': 180,
    '12 Months': 365,
}

interface SubscriptionCache {
    lastCheck: number // timestamp
    trialEndsAt: string | null // ISO date string
    subscriptionEndsAt: string | null // ISO date string
    isSubscribed: boolean
    userId: string // to invalidate cache on user change
}

interface SubscriptionStatus {
    hasAccess: boolean
    isTrialExpired: boolean
    isSubscriptionExpired: boolean
    daysRemaining: number | null
    checkedFromServer: boolean
}

/**
 * Get cached subscription data from localStorage
 */
function getLocalCache(): SubscriptionCache | null {
    if (typeof window === 'undefined') return null

    try {
        const cached = localStorage.getItem(STORAGE_KEY)
        if (!cached) return null
        return JSON.parse(cached) as SubscriptionCache
    } catch {
        console.log('[SUBSCRIPTION] Failed to parse cache, clearing')
        localStorage.removeItem(STORAGE_KEY)
        return null
    }
}

/**
 * Save subscription data to localStorage
 */
function setLocalCache(cache: SubscriptionCache): void {
    if (typeof window === 'undefined') return

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
        console.log('[SUBSCRIPTION] Cache updated')
    } catch (e) {
        console.warn('[SUBSCRIPTION] Failed to save cache:', e)
    }
}

/**
 * Clear the subscription cache
 */
export function clearSubscriptionCache(): void {
    if (typeof window === 'undefined') return
    localStorage.removeItem(STORAGE_KEY)
    console.log('[SUBSCRIPTION] Cache cleared')
}

/**
 * Check if we should skip the server call based on cooldown and cache
 */
function shouldSkipServerCheck(cache: SubscriptionCache | null, userId: string): { skip: boolean; reason: string } {
    if (!cache) {
        return { skip: false, reason: 'no-cache' }
    }

    // Invalidate cache if user changed
    if (cache.userId !== userId) {
        return { skip: false, reason: 'user-changed' }
    }

    const now = Date.now()
    const timeSinceLastCheck = now - cache.lastCheck

    // 1. Force check if cache is too old (24 hours) - allows for "abrupt stop" of access
    if (timeSinceLastCheck > MAX_CACHE_AGE_MS) {
        return { skip: false, reason: 'cache-too-old-24h' }
    }

    // 2. Check cooldown (5 minutes) to prevent spamming
    if (timeSinceLastCheck < COOLDOWN_MS) {
        return { skip: true, reason: 'cooldown-active' }
    }

    // 3. Check if subscription ends in > 6 hours (skip server if so)
    const subscriptionEndsAt = cache.subscriptionEndsAt ? new Date(cache.subscriptionEndsAt) : null
    const trialEndsAt = cache.trialEndsAt ? new Date(cache.trialEndsAt) : null

    // Use the later of trial end or subscription end
    const effectiveEndDate = (subscriptionEndsAt && cache.isSubscribed)
        ? subscriptionEndsAt
        : trialEndsAt

    if (effectiveEndDate) {
        const hoursUntilExpiry = (effectiveEndDate.getTime() - now) / (1000 * 60 * 60)
        // If it expires soon (< 6 hours), we want to be strict and check server every 5 mins
        if (hoursUntilExpiry > BUFFER_HOURS) {
            return { skip: true, reason: 'subscription-valid-beyond-buffer' }
        }
    }

    return { skip: false, reason: 'check-needed' }
}

/**
 * Calculate subscription status from cache (without server call)
 */
function calculateStatusFromCache(cache: SubscriptionCache): SubscriptionStatus {
    const now = new Date()

    const trialEndsAt = cache.trialEndsAt ? new Date(cache.trialEndsAt) : null
    const subscriptionEndsAt = cache.subscriptionEndsAt ? new Date(cache.subscriptionEndsAt) : null

    const isTrialExpired = trialEndsAt ? now > trialEndsAt : true
    const isSubscriptionExpired = !cache.isSubscribed || !subscriptionEndsAt || now > subscriptionEndsAt

    const hasAccess = !isTrialExpired || !isSubscriptionExpired

    // Calculate days remaining
    let daysRemaining: number | null = null
    if (!isSubscriptionExpired && subscriptionEndsAt) {
        daysRemaining = Math.ceil((subscriptionEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    } else if (!isTrialExpired && trialEndsAt) {
        daysRemaining = Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    }

    return {
        hasAccess,
        isTrialExpired,
        isSubscriptionExpired,
        daysRemaining,
        checkedFromServer: false,
    }
}

/**
 * Main function to check subscription status with optimizations
 * 
 * @param forceServerCheck - Force a server check regardless of cooldown/cache
 * @returns SubscriptionStatus or null if no user is logged in
 */
export async function checkSubscriptionStatus(forceServerCheck = false): Promise<SubscriptionStatus | null> {
    const supabase = createClient()

    // Get current user
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        console.log('[SUBSCRIPTION] No user logged in')
        return null
    }

    const cache = getLocalCache()

    // Check if we should skip server call
    if (!forceServerCheck) {
        const { skip, reason } = shouldSkipServerCheck(cache, user.id)
        if (skip && cache) {
            console.log(`[SUBSCRIPTION] Skipping server check - ${reason}`)
            return calculateStatusFromCache(cache)
        }
        console.log(`[SUBSCRIPTION] Server check needed - ${reason}`)
    } else {
        console.log('[SUBSCRIPTION] Forced server check')
    }

    // Fetch profile from server
    console.log('[SUBSCRIPTION] Checking server...')
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('trial_start_date, is_subscribed, subscription_plan, subscription_start_date')
        .eq('id', user.id)
        .single()

    if (error || !profile) {
        console.error('[SUBSCRIPTION] Failed to fetch profile:', error)
        // Fall back to cache if available
        if (cache && cache.userId === user.id) {
            return calculateStatusFromCache(cache)
        }
        return null
    }

    const now = new Date()

    // Calculate trial expiry
    const trialStart = profile.trial_start_date ? new Date(profile.trial_start_date) : null
    const trialEndsAt = trialStart
        ? new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000)
        : null
    const isTrialExpired = trialEndsAt ? now > trialEndsAt : true

    // Calculate subscription expiry
    const isSubscribed = profile.is_subscribed || false
    const subscriptionPlan = profile.subscription_plan as string | null
    const subscriptionStartDate = profile.subscription_start_date
        ? new Date(profile.subscription_start_date)
        : null

    let subscriptionEndsAt: Date | null = null
    let isSubscriptionExpired = true

    if (isSubscribed && subscriptionPlan && subscriptionStartDate) {
        const planDays = PLAN_DURATIONS[subscriptionPlan] || 30
        subscriptionEndsAt = new Date(subscriptionStartDate.getTime() + planDays * 24 * 60 * 60 * 1000)
        isSubscriptionExpired = now > subscriptionEndsAt
    }

    const hasAccess = !isTrialExpired || !isSubscriptionExpired

    // Calculate days remaining
    let daysRemaining: number | null = null
    if (!isSubscriptionExpired && subscriptionEndsAt) {
        daysRemaining = Math.ceil((subscriptionEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    } else if (!isTrialExpired && trialEndsAt) {
        daysRemaining = Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    }

    // Update cache
    const newCache: SubscriptionCache = {
        lastCheck: Date.now(),
        trialEndsAt: trialEndsAt?.toISOString() || null,
        subscriptionEndsAt: subscriptionEndsAt?.toISOString() || null,
        isSubscribed,
        userId: user.id,
    }
    setLocalCache(newCache)

    console.log(`[SUBSCRIPTION] Status: hasAccess=${hasAccess}, trialExpired=${isTrialExpired}, subscriptionExpired=${isSubscriptionExpired}, daysRemaining=${daysRemaining}`)

    return {
        hasAccess,
        isTrialExpired,
        isSubscriptionExpired,
        daysRemaining,
        checkedFromServer: true,
    }
}

/**
 * Setup visibility change listener for subscription checks
 * Returns a cleanup function to remove the listener
 */
export function setupVisibilityChangeListener(onStatusChange: (status: SubscriptionStatus) => void): () => void {
    if (typeof document === 'undefined') {
        return () => { }
    }

    const handleVisibilityChange = async () => {
        if (document.visibilityState === 'visible') {
            console.log('[SUBSCRIPTION] Visibility change triggered - app became visible')
            const status = await checkSubscriptionStatus()
            if (status) {
                onStatusChange(status)
            }
        }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    console.log('[SUBSCRIPTION] Visibility change listener registered')

    return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        console.log('[SUBSCRIPTION] Visibility change listener removed')
    }
}
