'use client';

import { useEffect, useState } from 'react';
import { geminiService } from '../services/gemini';
import { useSettingsStore, useSessionStore, useDocumentStore } from '../store';
import { createClient } from '../utils/supabase/client';
import { userIdLogger } from '../utils/userIdDebugLogger';

export function AppInitializer() {
  const [isClient, setIsClient] = useState(false);

  // Ensure we only run client-side code on the client
  useEffect(() => {
    setIsClient(true);
  }, []);
  const { settings, loadSettings, setUserId: setSettingsUserId, clearSettings } = useSettingsStore();
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
          loadSessions(userId).finally(() => {
            userIdLogger.logOperationEnd('AppInitializer', sessionsOpId, userId);
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

  // Initialize Gemini service when settings change (and API key is available)
  useEffect(() => {
    if (!isClient) return;
    
    if (settings?.geminiApiKey) {
      const initializeGemini = async () => {
        try {
          console.log('[APP INIT]', 'Initializing Gemini service...');
          // Use fallback model if settings.model is undefined (for backward compatibility)
          // FIX: Use type assertion (as any) to access model property safely
          // This resolves the "Property 'model' does not exist on type 'AppSettings'" error
          const model = (settings as any).model || 'gemini-2.5-flash-lite';
          await geminiService.initialize(settings.geminiApiKey, model, 'text-embedding-004');
          console.log('[APP INIT]', 'Gemini service initialized successfully');
        } catch (error) {
          console.error('[APP INIT ERROR]', 'Failed to initialize Gemini service:', error);
        }
      };

      initializeGemini();
    }
  }, [isClient, settings?.geminiApiKey, (settings as any)?.model]); // Also update dependency

  // This component doesn't render anything
  return null;
}