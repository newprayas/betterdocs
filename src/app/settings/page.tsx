'use client';

import React, { useState, useEffect } from 'react';

export const dynamic = 'force-dynamic';
import { useRouter } from 'next/navigation';
import { useSettingsStore } from '../../store';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Switch } from '../../components/ui/Switch';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { Header } from '../../components/layout/Header';
import clsx from 'clsx';

import type { ApiKeyValidationResult } from '../../types/settings';

export default function SettingsPage() {
  const router = useRouter();
  const {
    settings,
    updateSettings,
    loadSettings,
    isLoading,
    userId
  } = useSettingsStore();

  const [localSettings, setLocalSettings] = useState({
    geminiApiKey: '',
    groqApiKey: '',
    groqModel: 'llama-3.3-70b-versatile',
  });

  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [validationResult, setValidationResult] = useState<ApiKeyValidationResult | null>(null);
  const [showValidationError, setShowValidationError] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [showSaveBanner, setShowSaveBanner] = useState<'success' | 'error' | null>(null);
  const [isApiKeySaved, setIsApiKeySaved] = useState(false);
  const [isGroqApiKeySaved, setIsGroqApiKeySaved] = useState(false);
  const [savedApiKey, setSavedApiKey] = useState('');
  const [savedGroqApiKey, setSavedGroqApiKey] = useState('');

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isMounted && userId) {
      loadSettings(userId);
    }
  }, [loadSettings, isMounted, userId]);

  useEffect(() => {
    if (settings) {
      console.log('[SETTINGS PAGE] Settings from store loaded:', {
        geminiApiKey: settings.geminiApiKey ? `Set (${settings.geminiApiKey.length} chars)` : 'Not set',
      });
      setLocalSettings({
        geminiApiKey: settings.geminiApiKey || '',
        groqApiKey: settings.groqApiKey || '',
        groqModel: settings.groqModel || 'llama-3.3-70b-versatile',
      });
      setSavedApiKey(settings.geminiApiKey || '');
      setSavedGroqApiKey(settings.groqApiKey || '');
      setIsApiKeySaved(!!settings.geminiApiKey);
      setIsGroqApiKeySaved(!!settings.groqApiKey);
    }
  }, [settings]);

  const handleSettingChange = (field: string, value: any) => {
    setLocalSettings(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);

    // Re-enable save button if API key is changed from saved value
    if (field === 'geminiApiKey' && value !== savedApiKey) {
      setIsApiKeySaved(false);
    }
    if (field === 'groqApiKey' && value !== savedGroqApiKey) {
      setIsGroqApiKeySaved(false);
    }
  };

  const handleSave = async () => {
    try {
      console.log('[SETTINGS PAGE] Saving settings:', {
        geminiApiKey: localSettings.geminiApiKey ? `Set (${localSettings.geminiApiKey.length} chars)` : 'Not set',
      });
      await updateSettings(localSettings);
      setHasChanges(false);
      console.log('[SETTINGS PAGE] Settings saved successfully');
    } catch (error) {
      console.error('[SETTINGS PAGE] Failed to save settings:', error);
    }
  };

  const handleReset = async () => {
    try {
      const defaultSettings = {
        geminiApiKey: '',
        groqApiKey: '',
        groqModel: 'llama-3.3-70b-versatile',
      };
      await updateSettings(defaultSettings);
      setLocalSettings(defaultSettings);
      setHasChanges(false);
      setShowResetDialog(false);
    } catch (error) {
      console.error('Failed to reset settings:', error);
    }
  };

  const handleApiKeyUpdate = async (apiKey: string) => {
    console.log('[SETTINGS PAGE] API Key update called with:', apiKey ? `Set (${apiKey.length} chars)` : 'Not set');
    setLocalSettings(prev => ({ ...prev, geminiApiKey: apiKey }));
    setHasChanges(true);
    setShowApiKeyDialog(false);
    console.log('[SETTINGS PAGE] Local settings updated, hasChanges:', true);

    // Auto-save when API key is set
    try {
      console.log('[SETTINGS PAGE] Auto-saving API key...');
      await updateSettings({ ...localSettings, geminiApiKey: apiKey });
      setHasChanges(false);
      console.log('[SETTINGS PAGE] API key auto-saved successfully');
    } catch (error) {
      console.error('[SETTINGS PAGE] Failed to auto-save API key:', error);
    }
  };


  const handleTestGroqConnection = async () => {
    if (!localSettings.groqApiKey) {
      setValidationResult({
        isValid: false,
        error: {
          type: 'INVALID_KEY',
          message: 'Please enter a Groq API key first'
        }
      });
      setShowValidationError(true);
      setConnectionStatus('error');
      setTimeout(() => setConnectionStatus('idle'), 3000);
      return;
    }

    setIsTestingConnection(true);
    setConnectionStatus('testing');
    setShowValidationError(false);

    try {
      const { groqService } = await import('../../services/groq/groqService');
      const isValid = await groqService.validateApiKey(localSettings.groqApiKey);

      if (isValid) {
        setValidationResult({ isValid: true });
        setConnectionStatus('success');
        setTimeout(() => setConnectionStatus('idle'), 5000);
      } else {
        setValidationResult({
          isValid: false,
          error: {
            type: 'INVALID_KEY',
            message: 'Invalid Groq API Key. Please check and try again.'
          }
        });
        setConnectionStatus('error');
        setShowValidationError(true);
        setTimeout(() => setConnectionStatus('idle'), 5000);
      }
    } catch (error) {
      setValidationResult({
        isValid: false,
        error: {
          type: 'UNKNOWN_ERROR',
          message: 'Failed to test Groq API key connection',
          details: error instanceof Error ? error.message : String(error)
        }
      });
      setConnectionStatus('error');
      setShowValidationError(true);
      setTimeout(() => setConnectionStatus('idle'), 5000);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleTestConnection = async () => {
    if (!localSettings.geminiApiKey) {
      setValidationResult({
        isValid: false,
        error: {
          type: 'INVALID_KEY',
          message: 'Please enter an API key first'
        }
      });
      setShowValidationError(true);
      setConnectionStatus('error');
      setTimeout(() => setConnectionStatus('idle'), 3000);
      return;
    }

    setIsTestingConnection(true);
    setConnectionStatus('testing');
    setShowValidationError(false);

    try {
      const { geminiService } = await import('../../services/gemini');
      const result = await geminiService.validateApiKey(localSettings.geminiApiKey);
      setValidationResult(result);

      if (result.isValid) {
        setConnectionStatus('success');
        setTimeout(() => setConnectionStatus('idle'), 5000);
      } else {
        setConnectionStatus('error');
        setShowValidationError(true);
        setTimeout(() => setConnectionStatus('idle'), 5000);
      }
    } catch (error) {
      setValidationResult({
        isValid: false,
        error: {
          type: 'UNKNOWN_ERROR',
          message: 'Failed to test API key connection',
          details: error instanceof Error ? error.message : String(error)
        }
      });
      setConnectionStatus('error');
      setShowValidationError(true);
      setTimeout(() => setConnectionStatus('idle'), 5000);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const getErrorMessage = (result: ApiKeyValidationResult) => {
    if (!result.error) return 'Unknown error occurred';

    switch (result.error.type) {
      case 'INVALID_KEY':
        return 'Invalid API Key: ' + result.error.message;
      case 'NETWORK_ERROR':
        return 'Network Error: ' + result.error.message;
      case 'QUOTA_EXCEEDED':
        return 'Quota Exceeded: ' + result.error.message;
      case 'PERMISSION_DENIED':
        return 'Permission Denied: ' + result.error.message;
      case 'UNKNOWN_ERROR':
      default:
        return 'Error: ' + result.error.message;
    }
  };

  const getErrorIcon = (type: string) => {
    switch (type) {
      case 'INVALID_KEY':
        return '🔑';
      case 'NETWORK_ERROR':
        return '🌐';
      case 'QUOTA_EXCEEDED':
        return '📊';
      case 'PERMISSION_DENIED':
        return '🚫';
      case 'UNKNOWN_ERROR':
      default:
        return '⚠️';
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-8 overflow-y-auto">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <Header />

      <main className="flex-1 container mx-auto px-4 py-8 max-w-4xl overflow-y-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            Settings
          </h1>
          <p className="text-gray-600 dark:text-gray-300">
            Configure your RAG chat application preferences
          </p>
        </div>

        {/* Start Chatting Button - Appears when Groq API key is saved */}
        {isGroqApiKeySaved && (
          <div className="flex justify-center mb-6">
            <Button
              variant="primary"
              size="lg"
              className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-8 rounded-lg shadow-md hover:shadow-lg transition-all duration-200"
              onClick={() => router.push('/')}
            >
              Start Chatting
            </Button>
          </div>
        )}

        <div className="space-y-6">
          {/* Success/Error Banner */}
          {showSaveBanner && (
            <div className={clsx(
              "fixed top-20 right-4 z-50 px-6 py-3 rounded-lg shadow-lg transform transition-all duration-300",
              showSaveBanner === 'success'
                ? "bg-green-500 text-white"
                : "bg-red-500 text-white"
            )}>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-lg">
                    {showSaveBanner === 'success' ? '🎉' : '🔴'}
                  </span>
                  <span className="font-medium">
                    {showSaveBanner === 'success'
                      ? 'API saved successfully'
                      : 'Enter a correct API key error'}
                  </span>
                </div>
                {showSaveBanner === 'success' && (
                  <div className="text-sm ml-8">
                    You can now go back and chat with your books! 😁
                  </div>
                )}
              </div>
            </div>
          )}
          {/* API Configuration */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                API Configuration
              </h2>

              <div className="space-y-4">
                {/* Groq API Key */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Groq API Key
                  </label>
                  <Input
                    type="password"
                    value={localSettings.groqApiKey}
                    onChange={(e) => handleSettingChange('groqApiKey', e.target.value)}
                    placeholder="gsk_..."
                    className="w-full mb-2"
                  />

                  <div className="mt-4 mb-4">
                    <p className="font-semibold text-gray-900 dark:text-white">📚 What is API key?</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">It is a simple password needed to chat with your documents 🥳 - you can get it from the link below ✨</p>
                  </div>

                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-4">
                    ✅ Get your API key from{' '}
                    <a
                      href="https://console.groq.com/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 dark:text-blue-400 hover:underline font-bold"
                    >
                      [Groq Console - Click here ✨]
                    </a>
                  </p>

                  <div className="flex justify-center mt-6">
                    <Button
                      variant="primary"
                      size="md"
                      className="w-full max-w-sm py-2 shadow-md hover:shadow-lg transition-all duration-200"
                      onClick={async () => {
                        if (localSettings.groqApiKey) {
                          try {
                            console.log('[SETTINGS PAGE] Testing and saving Groq API key...');
                            const { groqService } = await import('../../services/groq/groqService');
                            const isValid = await groqService.validateApiKey(localSettings.groqApiKey);

                            if (isValid) {
                              await updateSettings({
                                groqApiKey: localSettings.groqApiKey,
                                groqModel: localSettings.groqModel
                              });
                              setHasChanges(false);
                              setSavedGroqApiKey(localSettings.groqApiKey);
                              setIsGroqApiKeySaved(true);
                              setShowSaveBanner('success');
                              setTimeout(() => setShowSaveBanner(null), 3000);
                            } else {
                              setShowSaveBanner('error');
                              setTimeout(() => setShowSaveBanner(null), 3000);
                            }
                          } catch (error) {
                            setShowSaveBanner('error');
                            setTimeout(() => setShowSaveBanner(null), 3000);
                          }
                        }
                      }}
                      disabled={!localSettings.groqApiKey || isGroqApiKeySaved}
                    >
                      {isGroqApiKeySaved ? '✓ API Key Saved' : 'Save API Key'}
                    </Button>
                  </div>
                </div>

              </div>
            </div>
          </Card>



          {/* Appearance Settings */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                Appearance
              </h2>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Dark Mode
                    </label>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Switch between light and dark themes
                    </p>
                  </div>
                  <Switch
                    checked={settings?.theme === 'dark'}
                    onCheckedChange={(checked) => updateSettings({ theme: checked ? 'dark' : 'light' })}
                    size="md"
                  />
                </div>
              </div>
            </div>
          </Card>



        </div>
      </main>

      {/* API Key Dialog */}
      <Modal
        isOpen={showApiKeyDialog}
        onClose={() => setShowApiKeyDialog(false)}
        title="Set Gemini API Key"
      >
        <div className="space-y-4">
          <p className="text-gray-600 dark:text-gray-300">
            Enter your Gemini API key to enable AI chat functionality.
          </p>

          <Input
            type="password"
            placeholder="AIza..."
            onChange={(e) => setLocalSettings(prev => ({ ...prev, geminiApiKey: e.target.value }))}
            className="w-full"
          />

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowApiKeyDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => handleApiKeyUpdate(localSettings.geminiApiKey)}
              disabled={!localSettings.geminiApiKey}
            >
              Set Key
            </Button>
          </div>
        </div>
      </Modal>


      {/* Reset Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showResetDialog}
        onClose={() => setShowResetDialog(false)}
        onConfirm={handleReset}
        title="Reset Settings"
        message="Are you sure you want to reset all settings to their default values? This action cannot be undone."
        confirmText="Reset"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}