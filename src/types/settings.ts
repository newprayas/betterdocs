// Settings types for RAG chat application

export interface AppSettings {
  id?: string; // Primary key for IndexedDB
  userId: string;

  // API Configuration
  geminiApiKey: string;
  apiEndpoint?: string;
  model: string;

  // Chat Settings
  temperature: number;
  maxTokens: number;

  // RAG Settings
  similarityThreshold: number;
  chunkSize: number;
  chunkOverlap: number;

  // UI Settings
  theme: 'dark' | 'light';
  fontSize: 'small' | 'medium' | 'large';
  showSources: boolean;
  autoSave: boolean;

  // Privacy Settings
  dataRetention: '1week' | '1month' | '3months' | 'never';
  enableAnalytics: boolean;
  crashReporting: boolean;

  // Advanced Settings
  debugMode: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

export interface SettingsUpdate {
  geminiApiKey?: string;
  apiEndpoint?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  similarityThreshold?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  theme?: 'dark' | 'light';
  fontSize?: 'small' | 'medium' | 'large';
  showSources?: boolean;
  autoSave?: boolean;
  dataRetention?: '1week' | '1month' | '3months' | 'never';
  enableAnalytics?: boolean;
  crashReporting?: boolean;
  debugMode?: boolean;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

export interface ApiKeyValidationResult {
  isValid: boolean;
  error?: {
    type: 'INVALID_KEY' | 'NETWORK_ERROR' | 'QUOTA_EXCEEDED' | 'PERMISSION_DENIED' | 'UNKNOWN_ERROR';
    message: string;
    details?: any;
  };
  responseTime?: number;
}