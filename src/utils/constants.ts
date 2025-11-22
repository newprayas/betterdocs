export const APP_CONFIG = {
  name: process.env.NEXT_PUBLIC_APP_NAME || 'Meddy',
  version: process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0',
  description: 'Chat with your documents privately',
};

export const API_CONFIG = {
  gemini: {
    embeddingModel: 'text-embedding-004',
    defaultModel: 'gemini-2.0-flash-exp',
    maxTokens: 8192,
    temperature: 0.7,
    maxRetries: 3,
    retryDelay: 1000,
  },
  rateLimits: {
    requestsPerMinute: 60,
    rateLimitWindow: 60000, // 1 minute in ms
  },
};

export const DB_CONFIG = {
  name: 'RAGDatabase',
  version: 1,
  stores: {
    sessions: 'sessions',
    messages: 'messages',
    documents: 'documents',
    embeddings: 'embeddings',
    settings: 'settings',
  },
};

export const UI_CONFIG = {
  messages: {
    maxHistoryLength: 6,
    maxInputLength: 10000,
    streamingDelay: 100,
  },
  documents: {
    maxFileSize: 50 * 1024 * 1024, // 50MB
    supportedFormats: ['.json'],
    batchSize: 10,
  },
  search: {
    defaultTopK: 4,
    minSimilarity: 0.1,
    maxResults: 20,
  },
};

export const STORAGE_KEYS = {
  apiKey: 'gemini_api_key',
  settings: 'app_settings',
  currentSession: 'current_session_id',
};

export const ROUTES = {
  home: '/',
  onboarding: '/onboarding',
  session: (id: string) => `/session/${id}`,
  settings: '/settings',
};

export const ERROR_MESSAGES = {
  apiKeyMissing: 'API key is missing. Please add it in settings.',
  apiKeyInvalid: 'Invalid API key. Please check your settings.',
  networkError: 'Network error. Please check your connection.',
  documentUploadFailed: 'Failed to upload document. Please try again.',
  chatFailed: 'Failed to send message. Please try again.',
  noDocuments: 'No documents found. Please import documents first.',
  noRelevantChunks: 'No relevant information found in your documents.',
  quotaExceeded: 'Storage quota exceeded. Please delete some documents.',
};

export const SUCCESS_MESSAGES = {
  sessionCreated: 'Session created successfully.',
  sessionUpdated: 'Session updated successfully.',
  sessionDeleted: 'Session deleted successfully.',
  documentUploaded: 'Document uploaded successfully.',
  documentDeleted: 'Document deleted successfully.',
  settingsSaved: 'Settings saved successfully.',
  apiKeyValidated: 'API key validated successfully.',
};

export const DATE_FORMATS = {
  short: 'MMM d, yyyy',
  long: 'MMMM d, yyyy \'at\' h:mm a',
  timeOnly: 'h:mm a',
  relative: {
    justNow: 'Just now',
    minutesAgo: (m: number) => `${m}m ago`,
    hoursAgo: (h: number) => `${h}h ago`,
    daysAgo: (d: number) => `${d}d ago`,
  },
};

export const THEME_COLORS = {
  slate: {
    950: '#020617',
    900: '#0F172A',
    800: '#1E293B',
    700: '#334155',
    600: '#475569',
    500: '#64748B',
    400: '#94A3B8',
    300: '#CBD5E1',
    200: '#E2E8F0',
    100: '#F1F5F9',
  },
  blue: {
    500: '#3B82F6',
    600: '#2563EB',
    400: '#60A5FA',
  },
  red: {
    500: '#EF4444',
  },
  green: {
    500: '#10B981',
  },
  yellow: {
    500: '#F59E0B',
  },
};