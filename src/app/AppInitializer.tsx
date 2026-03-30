'use client';

import { useEffect, useRef, useState } from 'react';
import { geminiService } from '../services/gemini';
import { useSettingsStore, useSessionStore, useDocumentStore, useChatStore } from '../store';
import { createClient } from '../utils/supabase/client';
import { userIdLogger } from '../utils/userIdDebugLogger';
import { storageManager } from '../services/storage/storageManager';
import { getIndexedDBServices } from '../services/indexedDB';
import { SessionPreparationOverlay } from '../components/ui';
import { Capacitor } from '@capacitor/core';

const RESUME_STALE_HIDDEN_MS = 15000;
const STALE_PIPELINE_AGE_MS = 90000;
const AUTH_RECOVERY_RETRIES = 3;
const AUTH_RECOVERY_BASE_DELAY_MS = 400;
const ORPHAN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_FAKE_DURATION_MS = 10000;
const CLEANUP_FAKE_CAP = 92;
const CLEANUP_CREEP_CAP = 97;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getCleanupStatus = (progress: number, isReady: boolean): string => {
  if (isReady) return 'Books are ready';
  if (progress < 30) return 'Checking old data';
  if (progress < 65) return 'Cleaning book storage';
  if (progress < 90) return 'Preparing your library';
  return 'Final checks';
};

export function AppInitializer() {
  const [isClient, setIsClient] = useState(false);
  const [showCleanupOverlay, setShowCleanupOverlay] = useState(false);
  const [cleanupProgress, setCleanupProgress] = useState(0);
  const [isCleanupReady, setIsCleanupReady] = useState(false);
  const lastHiddenAtRef = useRef<number | null>(null);
  const supabaseRef = useRef(createClient());
  const hydratedUserIdRef = useRef<string | null>(null);
  const hydratingUserIdRef = useRef<string | null>(null);
  const startupCleanupUserRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  // Ensure we only run client-side code on the client
  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isClient) return;
    if (!Capacitor.isNativePlatform()) return;
    document.documentElement.classList.add('native-capacitor');

    return () => {
      document.documentElement.classList.remove('native-capacitor');
    };
  }, [isClient]);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
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

      if (isMountedRef.current) {
        setShowCleanupOverlay(true);
        setCleanupProgress(0);
        setIsCleanupReady(false);
        console.log('[APP INIT] Cleanup overlay shown');
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
      } finally {
        if (isMountedRef.current) {
          setIsCleanupReady(true);
        }
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
        redirectToLoginIfNeeded();
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
      clearSettings();
      clearSessions();
      clearDocuments();
      hydratedUserIdRef.current = null;
      hydratingUserIdRef.current = null;
      startupCleanupUserRef.current = null;
      redirectToLoginIfNeeded();
    };

    checkSession();

    return () => {
      subscription.unsubscribe();
    };
  }, [loadSettings, loadSessions, setSettingsUserId, setSessionUserId, setDocumentUserId, clearSettings, clearSessions, clearDocuments, isClient]);

  useEffect(() => {
    if (!showCleanupOverlay) {
      return;
    }

    if (isCleanupReady) {
      setCleanupProgress(100);
      const hideTimer = window.setTimeout(() => {
        setShowCleanupOverlay(false);
        console.log('[APP INIT] Cleanup overlay hidden');
      }, 280);

      return () => {
        window.clearTimeout(hideTimer);
      };
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;

      setCleanupProgress((current) => {
        const linearProgress = Math.min(
          CLEANUP_FAKE_CAP,
          (elapsedMs / CLEANUP_FAKE_DURATION_MS) * CLEANUP_FAKE_CAP,
        );

        if (elapsedMs <= CLEANUP_FAKE_DURATION_MS) {
          return Math.max(current, linearProgress);
        }

        return Math.min(
          CLEANUP_CREEP_CAP,
          Math.max(current, linearProgress) + 0.35,
        );
      });
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [showCleanupOverlay, isCleanupReady]);

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

  // Migration: replace legacy inference model IDs with the current Groq default
  useEffect(() => {
    if (!isClient || !settings || !settings.userId) return;

    const legacyInferenceModels = [
      'gpt-oss-120b',
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'moonshotai/kimi-k2-instruct',
      'moonshotai/kimi-k2-instruct-0905'
    ];

    if (settings.groqModel && legacyInferenceModels.includes(settings.groqModel)) {
      console.log('[APP INIT] 🔄 MIGRATION: Upgrading legacy inference model', settings.groqModel, 'to groq/compound');
      updateSettings({ groqModel: 'groq/compound' });
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

  // Initialize storage manager on the client.
  useEffect(() => {
    if (!isClient) return;

    const initializeStorage = async () => {
      // Initialize Storage Manager (Request Persistence)
      await storageManager.init();
      console.log('[APP INIT] Storage Manager initialized');
    };

    initializeStorage();
  }, [isClient]);

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

  return showCleanupOverlay ? (
    <SessionPreparationOverlay
      progress={cleanupProgress}
      title="Cleaning books to keep Meddy fast..."
      description="Please wait while old data is cleaned and your library is prepared."
      status={getCleanupStatus(cleanupProgress, isCleanupReady)}
    />
  ) : null;
}
