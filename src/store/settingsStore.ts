import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { SettingsStore } from './types';
import { AppSettings, SettingsUpdate } from '@/types/settings';
import { getIndexedDBServices } from '../services/indexedDB';

// Helper function to get services (client-side only)
const getSettingsService = () => {
  if (typeof window !== 'undefined') {
    const services = getIndexedDBServices();
    return services.settingsService;
  }
  return null;
};

export const useSettingsStore = create<SettingsStore>()(
  devtools(
    persist(
      (set, get) => ({
        // State
        settings: null,
        isLoading: false,
        error: null,
        userId: null,

        // Actions
        loadSettings: async (userId: string) => {
          // Only run on client side
          if (typeof window === 'undefined') {
            console.warn('[SETTINGS STORE] Skipping loadSettings during SSR');
            return;
          }
          
          set({ isLoading: true, error: null, userId });
          try {
            const settingsService = getSettingsService();
            if (!settingsService) {
              throw new Error('Settings service not available');
            }
            let settings = await settingsService.getSettings(userId);

            // If no settings exist, use defaults
            if (!settings) {
              settings = settingsService.getDefaultSettings(userId);
              await settingsService.updateSettings(settings, userId);
            }

            set({ settings, isLoading: false });
          } catch (error) {
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : 'Failed to load settings',
            });
          }
        },

        updateSettings: async (newSettings: Partial<AppSettings>) => {
          // Only run on client side
          if (typeof window === 'undefined') {
            console.warn('[SETTINGS STORE] Skipping updateSettings during SSR');
            throw new Error('Cannot update settings during SSR');
          }
          
          const { userId } = get();
          if (!userId) {
            set({ error: 'User ID not found. Please log in.' });
            throw new Error('User ID not found');
          }

          set({ isLoading: true, error: null });
          try {
            const settingsService = getSettingsService();
            if (!settingsService) {
              throw new Error('Settings service not available');
            }
            const updatedSettings = await settingsService.updateSettings(newSettings, userId);
            set({ settings: updatedSettings, isLoading: false });
          } catch (error) {
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : 'Failed to update settings'
            });
            throw error;
          }
        },

        resetSettings: async () => {
          const { userId } = get();
          if (!userId) {
            set({ error: 'User ID not found. Please log in.' });
            throw new Error('User ID not found');
          }

          set({ isLoading: true, error: null });
          try {
            const settingsService = getSettingsService();
            if (!settingsService) {
              throw new Error('Settings service not available');
            }
            const defaultSettings = await settingsService.resetSettings(userId);
            set({ settings: defaultSettings, isLoading: false });
          } catch (error) {
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : 'Failed to reset settings'
            });
          }
        },

        validateApiKey: async (apiKey: string) => {
          try {
            // Basic format validation
            const geminiKeyPattern = /^AIza[0-9A-Za-z_-]{35}$/;
            if (!geminiKeyPattern.test(apiKey)) {
              return 'Invalid API key format';
            }
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : 'API key validation failed';
          }
        },

        setUserId: (userId: string | null) => {
          set({ userId });
        },

        clearSettings: () => {
          set({
            settings: null,
            userId: null,
            error: null
          });
        },

        setLoading: (isLoading: boolean) => {
          set({ isLoading });
        },

        setError: (error: string | null) => {
          set({ error });
        },
      }),
      {
        name: 'settings-store',
        partialize: (state) => ({
          settings: state.settings,
          userId: state.userId,
        }),
      }
    )
  )
);