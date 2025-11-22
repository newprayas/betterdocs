import { db } from './db';
import type { AppSettings, SettingsUpdate } from '@/types';
import { userIdLogger } from '@/utils/userIdDebugLogger';

export class SettingsService {
  private getSettingsId(userId: string): string {
    return `app-settings-${userId}`;
  }

  /**
   * Get app settings for a user
   */
  async getSettings(userId: string): Promise<AppSettings | undefined> {
    userIdLogger.logServiceCall('settingsService', 'getSettings', 'read', userId);
    
    if (!db) return undefined;
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.getSettings', new Error('Attempt to get settings without userId'), userId);
      return undefined;
    }
    
    const id = this.getSettingsId(userId);
    const settings = await db.settings.get(id);
    console.log('[SETTINGS GET]', `Retrieved settings for user: ${userId}`);
    return settings;
  }

  /**
   * Get default settings
   */
  getDefaultSettings(userId: string): AppSettings {
    const defaultSettings: AppSettings = {
      id: this.getSettingsId(userId),
      userId,
      geminiApiKey: '',
      temperature: 0.7,
      maxTokens: 4096,
      similarityThreshold: 0.7,
      chunkSize: 1000,
      chunkOverlap: 200,
      theme: 'dark' as const,
      fontSize: 'medium' as const,
      showSources: true,
      autoSave: true,
      dataRetention: 'never' as const,
      enableAnalytics: false,
      crashReporting: false,
      debugMode: false,
      logLevel: 'error' as const,
    };

    return defaultSettings;
  }

  /**
   * Create or update settings
   */
  async updateSettings(updates: SettingsUpdate, userId: string): Promise<AppSettings> {
    userIdLogger.logServiceCall('settingsService', 'updateSettings', 'update', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.updateSettings', new Error('Attempt to update settings without userId'), userId);
      throw new Error('userId is required to update settings');
    }
    
    const existing = await this.getSettings(userId);
    const settings = existing ? { ...existing, ...updates } : { ...this.getDefaultSettings(userId), ...updates };

    // Ensure IDs match
    settings.id = this.getSettingsId(userId);
    settings.userId = userId;

    if (!db) throw new Error('Database not available');
    await db.settings.put(settings);
    return settings;
  }

  /**
   * Update API key
   */
  /**
   * Update API key
   */
  async updateApiKey(geminiApiKey: string, userId: string): Promise<AppSettings> {
    userIdLogger.logServiceCall('settingsService', 'updateApiKey', 'update', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.updateApiKey', new Error('Attempt to update API key without userId'), userId);
      throw new Error('userId is required to update API key');
    }
    
    return await this.updateSettings({ geminiApiKey }, userId);
  }



  /**
   * Update generation settings
   */
  /**
   * Update generation settings
   */
  async updateGenerationSettings(
    maxTokens: number,
    temperature: number,
    userId: string
  ): Promise<AppSettings> {
    userIdLogger.logServiceCall('settingsService', 'updateGenerationSettings', 'update', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.updateGenerationSettings', new Error('Attempt to update generation settings without userId'), userId);
      throw new Error('userId is required to update generation settings');
    }
    
    return await this.updateSettings({ maxTokens, temperature }, userId);
  }

  /**
   * Update UI settings
   */
  /**
   * Update UI settings
   */
  async updateUISettings(theme: 'dark' | 'light', fontSize: 'small' | 'medium' | 'large', userId: string): Promise<AppSettings> {
    userIdLogger.logServiceCall('settingsService', 'updateUISettings', 'update', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.updateUISettings', new Error('Attempt to update UI settings without userId'), userId);
      throw new Error('userId is required to update UI settings');
    }
    
    return await this.updateSettings({ theme, fontSize }, userId);
  }

  /**
   * Toggle sources display
   */
  /**
   * Toggle sources display
   */
  async toggleShowSources(userId: string): Promise<AppSettings> {
    userIdLogger.logServiceCall('settingsService', 'toggleShowSources', 'update', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.toggleShowSources', new Error('Attempt to toggle show sources without userId'), userId);
      throw new Error('userId is required to toggle show sources');
    }
    
    const existing = await this.getSettings(userId);
    const showSources = existing ? !existing.showSources : true;
    return await this.updateSettings({ showSources }, userId);
  }

  /**
   * Reset settings to defaults
   */
  /**
   * Reset settings to defaults
   */
  async resetSettings(userId: string): Promise<AppSettings> {
    userIdLogger.logServiceCall('settingsService', 'resetSettings', 'update', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.resetSettings', new Error('Attempt to reset settings without userId'), userId);
      throw new Error('userId is required to reset settings');
    }
    
    if (!db) throw new Error('Database not available');
    const defaultSettings = this.getDefaultSettings(userId);
    await db.settings.put(defaultSettings);
    return defaultSettings;
  }

  /**
   * Check if API key is configured
   */
  /**
   * Check if API key is configured
   */
  async hasApiKey(userId: string): Promise<boolean> {
    userIdLogger.logServiceCall('settingsService', 'hasApiKey', 'read', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.hasApiKey', new Error('Attempt to check API key without userId'), userId);
      return false;
    }
    
    const settings = await this.getSettings(userId);
    return !!(settings?.geminiApiKey && settings.geminiApiKey.trim().length > 0);
  }

  /**
   * Get API key (masked for display)
   */
  /**
   * Get API key (masked for display)
   */
  async getMaskedApiKey(userId: string): Promise<string> {
    userIdLogger.logServiceCall('settingsService', 'getMaskedApiKey', 'read', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.getMaskedApiKey', new Error('Attempt to get masked API key without userId'), userId);
      return '';
    }
    
    const settings = await this.getSettings(userId);
    if (!settings?.geminiApiKey) return '';

    const key = settings.geminiApiKey;
    if (key.length <= 10) return key;

    return key.substring(0, 7) + '...' + key.substring(key.length - 3);
  }

  /**
   * Validate API key format
   */
  validateApiKey(geminiApiKey: string): boolean {
    // Basic Gemini API key validation
    const geminiKeyPattern = /^AIza[0-9A-Za-z_-]{35}$/;
    return geminiKeyPattern.test(geminiApiKey);
  }

  /**
   * Export settings
   */
  /**
   * Export settings
   */
  async exportSettings(userId: string): Promise<string> {
    userIdLogger.logServiceCall('settingsService', 'exportSettings', 'read', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.exportSettings', new Error('Attempt to export settings without userId'), userId);
      throw new Error('userId is required to export settings');
    }
    
    const settings = await this.getSettings(userId);
    if (!settings) throw new Error('No settings to export');

    // Create exportable settings (without sensitive data)
    const exportable = {
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      similarityThreshold: settings.similarityThreshold,
      chunkSize: settings.chunkSize,
      chunkOverlap: settings.chunkOverlap,
      theme: settings.theme,
      fontSize: settings.fontSize,
      showSources: settings.showSources,
      autoSave: settings.autoSave,
      dataRetention: settings.dataRetention,
      enableAnalytics: settings.enableAnalytics,
      crashReporting: settings.crashReporting,
      debugMode: settings.debugMode,
      logLevel: settings.logLevel,
    };

    return JSON.stringify(exportable, null, 2);
  }

  /**
   * Import settings
   */
  async importSettings(settingsJson: string, userId: string): Promise<AppSettings> {
    userIdLogger.logServiceCall('settingsService', 'importSettings', 'update', userId);
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('settingsService.importSettings', new Error('Attempt to import settings without userId'), userId);
      throw new Error('userId is required to import settings');
    }
    
    try {
      const imported = JSON.parse(settingsJson);

      // Validate imported settings
      const validUpdates: SettingsUpdate = {};

      if (typeof imported.similarityThreshold === 'number' && imported.similarityThreshold >= 0 && imported.similarityThreshold <= 1) {
        validUpdates.similarityThreshold = imported.similarityThreshold;
      }
      if (typeof imported.chunkSize === 'number' && imported.chunkSize > 0) {
        validUpdates.chunkSize = imported.chunkSize;
      }
      if (typeof imported.chunkOverlap === 'number' && imported.chunkOverlap >= 0) {
        validUpdates.chunkOverlap = imported.chunkOverlap;
      }
      if (typeof imported.maxTokens === 'number' && imported.maxTokens > 0) {
        validUpdates.maxTokens = imported.maxTokens;
      }
      if (typeof imported.temperature === 'number' && imported.temperature >= 0 && imported.temperature <= 2) {
        validUpdates.temperature = imported.temperature;
      }
      if (typeof imported.showSources === 'boolean') {
        validUpdates.showSources = imported.showSources;
      }
      if (typeof imported.autoSave === 'boolean') {
        validUpdates.autoSave = imported.autoSave;
      }
      if (typeof imported.dataRetention === 'string') {
        validUpdates.dataRetention = imported.dataRetention;
      }
      if (typeof imported.enableAnalytics === 'boolean') {
        validUpdates.enableAnalytics = imported.enableAnalytics;
      }
      if (typeof imported.crashReporting === 'boolean') {
        validUpdates.crashReporting = imported.crashReporting;
      }
      if (typeof imported.debugMode === 'boolean') {
        validUpdates.debugMode = imported.debugMode;
      }
      if (typeof imported.logLevel === 'string') {
        validUpdates.logLevel = imported.logLevel;
      }

      return await this.updateSettings(validUpdates, userId);
    } catch (error) {
      throw new Error('Invalid settings format');
    }
  }
}

export const settingsService = new SettingsService();