'use client';

import { useEffect, useState } from 'react';
import { geminiService } from '../services/gemini';
import { groqService } from '../services/groq/groqService';
import { useSettingsStore, useSessionStore, useDocumentStore, useChatStore } from '../store';
import { createClient } from '../utils/supabase/client';
import { userIdLogger } from '../utils/userIdDebugLogger';

export function AppInitializer() {
  const [isClient, setIsClient] = useState(false);

  // Ensure we only run client-side code on the client
  useEffect(() => {
    setIsClient(true);
  }, []);
  const { settings, loadSettings, setUserId: setSettingsUserId, clearSettings, updateSettings } = useSettingsStore();
  const { loadSessions, setUserId: setSessionUserId, clearSessions } = useSessionStore();
  const { setUserId: setDocumentUserId, clearDocuments } = useDocumentStore();
  const supabase = createClient();

  useEffect(() => {
    // Only run on client side
    if (!isClient) return;

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[APP INIT]', 'Auth state changed:', event, session?.user?.id);

      const userId = session?.user?.id || null;

      // Log auth state change
      userIdLogger.logAuthChange('AppInitializer', userId, event);

      if (session?.user && userId) {
        // Set User ID in stores
        userIdLogger.logStoreUpdate('SettingsStore', userId, 'setUserId');
        setSettingsUserId(userId);

        userIdLogger.logStoreUpdate('SessionStore', userId, 'setUserId');
        setSessionUserId(userId);

        userIdLogger.logStoreUpdate('DocumentStore', userId, 'setUserId');
        setDocumentUserId(userId); // Set DocumentStore user ID

        // Load user-specific data
        const settingsOpId = userIdLogger.logOperationStart('AppInitializer', 'loadSettings', userId);
        const sessionsOpId = userIdLogger.logOperationStart('AppInitializer', 'loadSessions', userId);

        await Promise.all([
          loadSettings(userId).finally(() => {
            userIdLogger.logOperationEnd('AppInitializer', settingsOpId, userId);
          }),
          loadSessions(userId).finally(() => {
            userIdLogger.logOperationEnd('AppInitializer', sessionsOpId, userId);
          })
          // Documents are loaded per session, so we don't load them here directly
        ]);

        console.log('[APP INIT]', 'User data loaded for:', userId);
      } else if (event === 'SIGNED_OUT') {
        // Clear stores on sign out
        userIdLogger.logStoreUpdate('SettingsStore', null, 'clearSettings');
        clearSettings();

        userIdLogger.logStoreUpdate('SessionStore', null, 'clearSessions');
        clearSessions();

        userIdLogger.logStoreUpdate('DocumentStore', null, 'clearDocuments');
        clearDocuments(); // Clear DocumentStore

        console.log('[APP INIT]', 'User data cleared');
      }
    });

    // Initial check for session
    const checkSession = async () => {
      if (!isClient) return;
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id || null;

      if (session?.user && userId) {
        // userId is already defined above as session?.user?.id || null
        // No need to redeclare it here

        userIdLogger.logAuthChange('AppInitializer', userId, 'INITIAL_SESSION_CHECK');

        userIdLogger.logStoreUpdate('SettingsStore', userId, 'setUserId (initial)');
        setSettingsUserId(userId);

        userIdLogger.logStoreUpdate('SessionStore', userId, 'setUserId (initial)');
        setSessionUserId(userId);

        userIdLogger.logStoreUpdate('DocumentStore', userId, 'setUserId (initial)');
        setDocumentUserId(userId); // Set DocumentStore user ID for initial check

        const settingsOpId = userIdLogger.logOperationStart('AppInitializer', 'loadSettings (initial)', userId);
        const sessionsOpId = userIdLogger.logOperationStart('AppInitializer', 'loadSessions (initial)', userId);

        await Promise.all([
          loadSettings(userId).finally(() => {
            userIdLogger.logOperationEnd('AppInitializer', settingsOpId, userId);
          }),
          loadSessions(userId).then(async () => {
            userIdLogger.logOperationEnd('AppInitializer', sessionsOpId, userId);
            // Preload messages for top 5 sessions immediately after loading sessions
            const currentSessions = useSessionStore.getState().sessions;
            if (currentSessions.length > 0) {
              const topSessionIds = currentSessions.slice(0, 5).map(s => s.id);
              console.log('[APP INIT] 🚀 Triggering global preload for', topSessionIds.length, 'sessions');
              // We import the store directly to avoid hook rules in this async callback if needed, 
              // but since we are in a component, we can use the hook's method if we extracted it.
              // However, to be safe and clean, we'll use the store instance method if available or just the hook.
              // Since we are inside useEffect, we can't use the hook *inside* the callback easily without closure issues.
              // Better to use the store's getState() method for actions if possible, or just call the method we got from the hook.
              // We'll use the method from the hook which we need to add to the component scope.
              useChatStore.getState().preloadMessages(topSessionIds);
            }
          })
        ]);
      } else {
        userIdLogger.logAuthChange('AppInitializer', null, 'INITIAL_SESSION_CHECK (no session)');
      }
    };

    checkSession();

    return () => {
      subscription.unsubscribe();
    };
  }, [loadSettings, loadSessions, setSettingsUserId, setSessionUserId, setDocumentUserId, clearSettings, clearSessions, clearDocuments, isClient, supabase]);

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

  // Initialize Groq service when settings change (and Groq API key is available)
  useEffect(() => {
    if (!isClient) return;

    if (settings?.groqApiKey) {
      console.log('[APP INIT]', 'Initializing Groq service...');
      groqService.initialize(settings.groqApiKey);
      console.log('[APP INIT]', 'Groq service initialized successfully');
    }
  }, [isClient, settings?.groqApiKey]);

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