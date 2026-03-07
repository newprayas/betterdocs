'use client';

import { useEffect, useRef, useState } from 'react';
import { geminiService } from '../services/gemini';
import { groqService } from '../services/groq/groqService';
import { useSettingsStore, useSessionStore, useDocumentStore, useChatStore } from '../store';
import { createClient } from '../utils/supabase/client';
import { userIdLogger } from '../utils/userIdDebugLogger';
import { storageManager } from '../services/storage/storageManager';
import { getIndexedDBServices } from '../services/indexedDB';

const RESUME_STALE_HIDDEN_MS = 15000;
const STALE_PIPELINE_AGE_MS = 90000;
const AUTH_RECOVERY_RETRIES = 3;
const AUTH_RECOVERY_BASE_DELAY_MS = 400;
const ORPHAN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AppInitializer() {
  const [isClient, setIsClient] = useState(false);
  const lastHiddenAtRef = useRef<number | null>(null);
  const supabaseRef = useRef(createClient());
  const hydratedUserIdRef = useRef<string | null>(null);
  const hydratingUserIdRef = useRef<string | null>(null);
  const startupCleanupUserRef = useRef<string | null>(null);

  // Ensure we only run client-side code on the client
  useEffect(() => {
    setIsClient(true);
  }, []);
  const { settings, loadSettings, setUserId: setSettingsUserId, clearSettings, updateSettings } = useSettingsStore();
  const { loadSessions, setUserId: setSessionUserId, clearSessions } = useSessionStore();
  const { setUserId: setDocumentUserId, clearDocuments } = useDocumentStore();
  const supabase = supabaseRef.current;

  useEffect(() => {
    // Only run on client side
    if (!isClient) return;

    const setStoreUserIds = (userId: string, reason: string) => {
      userIdLogger.logStoreUpdate('SettingsStore', userId, `setUserId (${reason})`);
      setSettingsUserId(userId);

      userIdLogger.logStoreUpdate('SessionStore', userId, `setUserId (${reason})`);
      setSessionUserId(userId);

      userIdLogger.logStoreUpdate('DocumentStore', userId, `setUserId (${reason})`);
      setDocumentUserId(userId);
    };

    const maybeRunStartupCleanup = async (userId: string): Promise<void> => {
      const cleanupKey = `orphan_cleanup_last_run_v1:${userId}`;
      const now = Date.now();

      const lastRunRaw = window.localStorage.getItem(cleanupKey);
      const lastRun = lastRunRaw ? Number(lastRunRaw) : 0;
      const dailyDue = !Number.isFinite(lastRun) || now - lastRun >= ORPHAN_CLEANUP_INTERVAL_MS;

      if (!dailyDue) {
        console.log('[APP INIT] Startup orphan cleanup skipped (not due)', {
          lastRun,
          hoursSinceLastRun: lastRun > 0 ? ((now - lastRun) / 3600000).toFixed(2) : 'n/a'
        });
        return;
      }

      try {
        const { sessionService } = getIndexedDBServices();
        const cleanupSummary = await sessionService.cleanupOrphanedData();
        window.localStorage.setItem(cleanupKey, String(now));
        console.log('[APP INIT] Startup orphan cleanup complete:', {
          reason: 'daily',
          ...cleanupSummary
        });
      } catch (cleanupError) {
        console.warn('[APP INIT] Startup orphan cleanup failed:', cleanupError);
      }
    };

    const hydrateUserData = async (userId: string, reason: string) => {
      if (hydratingUserIdRef.current === userId) {
        console.log('[APP INIT]', `Skipping duplicate hydrate for user ${userId} (${reason})`);
        return;
      }

      hydratingUserIdRef.current = userId;
      userIdLogger.logAuthChange('AppInitializer', userId, reason);
      setStoreUserIds(userId, reason);

      const settingsOpId = userIdLogger.logOperationStart('AppInitializer', `loadSettings (${reason})`, userId);
      const sessionsOpId = userIdLogger.logOperationStart('AppInitializer', `loadSessions (${reason})`, userId);

      try {
        await Promise.all([
          loadSettings(userId).finally(() => {
            userIdLogger.logOperationEnd('AppInitializer', settingsOpId, userId);
          }),
          loadSessions(userId).then(async () => {
            userIdLogger.logOperationEnd('AppInitializer', sessionsOpId, userId);
            const currentSessions = useSessionStore.getState().sessions;
            if (currentSessions.length > 0) {
              const topSessionIds = currentSessions.slice(0, 5).map(s => s.id);
              useChatStore.getState().preloadMessages(topSessionIds);
            }
          })
        ]);

        if (startupCleanupUserRef.current !== userId) {
          startupCleanupUserRef.current = userId;
          setTimeout(async () => {
            await maybeRunStartupCleanup(userId);
          }, 1500);
        }

        hydratedUserIdRef.current = userId;
      } finally {
        if (hydratingUserIdRef.current === userId) {
          hydratingUserIdRef.current = null;
        }
      }
    };

    const redirectToLoginIfNeeded = () => {
      if (typeof window === 'undefined') return;
      const pathname = window.location.pathname;
      if (pathname.startsWith('/login') || pathname.startsWith('/auth/')) return;

      const redirectUrl = new URL('/login', window.location.origin);
      redirectUrl.searchParams.set('redirectedFrom', pathname);
      window.location.replace(redirectUrl.toString());
    };

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[APP INIT]', 'Auth state changed:', event, session?.user?.id);

      const userId = session?.user?.id || null;

      // Log auth state change
      userIdLogger.logAuthChange('AppInitializer', userId, event);

      if (session?.user && userId) {
        // For token refresh on the same user, keep it lightweight to avoid resume-time DB contention.
        if (event === 'TOKEN_REFRESHED' && hydratedUserIdRef.current === userId) {
          setStoreUserIds(userId, event);
          return;
        }

        await hydrateUserData(userId, event);
        console.log('[APP INIT]', 'User data loaded for:', userId);
      } else if (event === 'SIGNED_OUT') {
        // Clear stores on sign out
        userIdLogger.logStoreUpdate('SettingsStore', null, 'clearSettings');
        clearSettings();

        userIdLogger.logStoreUpdate('SessionStore', null, 'clearSessions');
        clearSessions();

        userIdLogger.logStoreUpdate('DocumentStore', null, 'clearDocuments');
        clearDocuments(); // Clear DocumentStore

        hydratedUserIdRef.current = null;
        hydratingUserIdRef.current = null;
        startupCleanupUserRef.current = null;
        console.log('[APP INIT]', 'User data cleared');
      }
    });

    // Initial check for session
    const checkSession = async () => {
      if (!isClient) return;

      for (let attempt = 0; attempt <= AUTH_RECOVERY_RETRIES; attempt++) {
        const { data: { session } } = await supabase.auth.getSession();
        const userId = session?.user?.id || null;
        if (session?.user && userId) {
          await hydrateUserData(userId, 'INITIAL_SESSION_CHECK');
          return;
        }

        // Explicit refresh can recover transient PWA resume state.
        const { data: userData } = await supabase.auth.getUser();
        if (userData.user?.id) {
          await hydrateUserData(userData.user.id, 'INITIAL_USER_REFRESH');
          return;
        }

        if (attempt < AUTH_RECOVERY_RETRIES) {
          await sleep(AUTH_RECOVERY_BASE_DELAY_MS * (attempt + 1));
        }
      }

      userIdLogger.logAuthChange('AppInitializer', null, 'INITIAL_SESSION_CHECK (no session after retry)');
      redirectToLoginIfNeeded();
    };

    checkSession();

    return () => {
      subscription.unsubscribe();
    };
  }, [loadSettings, loadSessions, setSettingsUserId, setSessionUserId, setDocumentUserId, clearSettings, clearSessions, clearDocuments, isClient]);

  // Special Migration: Force update legacy models to Gemma 3 27B
  useEffect(() => {
    if (!isClient || !settings || !settings.userId) return;

    // Treat 4B and 12B as legacy now too
    const legacyModels = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemma-3-12b-it', 'gemma-3-4b-it'];

    // Check if current model is in legacy list
    if (settings.model && legacyModels.includes(settings.model)) {
      console.log('[APP INIT] 🔄 MIGRATION: Upgrading legacy model', settings.model, 'to gemma-3-27b-it');

      // Force update settings
      updateSettings({ model: 'gemma-3-27b-it' });
    }
  }, [isClient, settings?.model, settings?.userId, updateSettings]);

  // Migration: replace legacy Groq model IDs with Cerebras model default
  useEffect(() => {
    if (!isClient || !settings || !settings.userId) return;

    const legacyInferenceModels = [
      'llama-3.3-70b-versatile',
      'moonshotai/kimi-k2-instruct',
      'moonshotai/kimi-k2-instruct-0905'
    ];

    if (settings.groqModel && legacyInferenceModels.includes(settings.groqModel)) {
      console.log('[APP INIT] 🔄 MIGRATION: Upgrading legacy inference model', settings.groqModel, 'to gpt-oss-120b');
      updateSettings({ groqModel: 'gpt-oss-120b' });
    }
  }, [isClient, settings?.groqModel, settings?.userId, updateSettings]);

  // Initialize Gemini embedding service with env keys (no user key needed)
  useEffect(() => {
    if (!isClient) return;

    const initializeEmbeddings = async () => {
      try {
        console.log('[APP INIT]', 'Initializing Gemini embedding service with env keys...');
        const success = geminiService.initializeEmbeddingKeys();
        if (success) {
          console.log('[APP INIT]', 'Gemini embedding service initialized successfully');
        } else {
          console.error('[APP INIT ERROR]', 'Failed to initialize Gemini embedding service - no keys found');
        }
      } catch (error) {
        console.error('[APP INIT ERROR]', 'Failed to initialize Gemini embedding service:', error);
      }
    };

    initializeEmbeddings();
  }, [isClient]);

  // Initialize inference service from env keys (and optional legacy saved key) plus storage manager
  useEffect(() => {
    if (!isClient) return;

    const initializeGroqAndStorage = async () => {
      console.log('[APP INIT]', 'Initializing inference service...');
      await groqService.initialize(settings?.groqApiKey || '');
      console.log('[APP INIT]', 'Inference service initialized:', groqService.isInitialized() ? 'ready' : 'missing keys');

      // Initialize Storage Manager (Request Persistence)
      await storageManager.init();
      console.log('[APP INIT] Storage Manager initialized');
    };

    initializeGroqAndStorage();
  }, [isClient, settings?.groqApiKey]);

  // Hybrid stale-guard: keep fast resume, but reset only stale in-progress chat state.
  useEffect(() => {
    if (!isClient) return;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAtRef.current = Date.now();
        return;
      }

      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      const hiddenDuration = lastHiddenAtRef.current ? now - lastHiddenAtRef.current : 0;
      lastHiddenAtRef.current = null;

      const chatState = useChatStore.getState();
      const pipelineAge = chatState.pipelineStartedAt ? now - chatState.pipelineStartedAt : 0;
      const hasActivePipelineUi = chatState.isReadingSources || chatState.isStreaming;
      const isOverAgedPipeline = Boolean(chatState.pipelineStartedAt && pipelineAge > STALE_PIPELINE_AGE_MS);
      const isStaleByResume = hasActivePipelineUi && hiddenDuration > RESUME_STALE_HIDDEN_MS;

      if (!isOverAgedPipeline && !isStaleByResume) return;

      console.warn('[APP INIT] Resetting stale in-progress chat state after resume', {
        hiddenDurationMs: hiddenDuration,
        pipelineAgeMs: pipelineAge,
      });

      chatState.resetTransientState('Previous in-progress request was reset after app resume. Please send again.');

      const { currentSessionId } = useSessionStore.getState();
      if (currentSessionId) {
        chatState.loadMessages(currentSessionId).catch((error) => {
          console.warn('[APP INIT] Failed to refresh messages after stale reset:', error);
        });
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isClient]);

  // Global Storage Check
  useEffect(() => {
    if (!isClient) return;

    const checkStorage = async () => {
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const { usage, quota } = await navigator.storage.estimate();
          if (usage && quota) {
            const percentage = (usage / quota) * 100;
            console.log(`[APP INIT] Storage usage: ${percentage.toFixed(1)}% (${(usage / 1024 / 1024).toFixed(1)}MB / ${(quota / 1024 / 1024).toFixed(1)}MB)`);

            if (percentage > 80) {
              console.warn('[APP INIT] ⚠️ STORAGE CRITICAL: Usage > 80%. Mobile crashes likely.');
            }
          }
        }
      } catch (e) {
        console.warn('[APP INIT] Failed to check storage quota', e);
      }
    };

    // Check after a short delay to let main threads settle
    const timer = setTimeout(checkStorage, 5000);
    return () => clearTimeout(timer);
  }, [isClient]);

  // This component doesn't render anything
  return null;
}
