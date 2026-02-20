'use client';

import React, { useState, useEffect } from 'react';

export const dynamic = 'force-dynamic';
import { useRouter } from 'next/navigation';
import { useSettingsStore } from '../../store';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { Header } from '../../components/layout/Header';

export default function SettingsPage() {
  const router = useRouter();
  const { settings, updateSettings, loadSettings, isLoading, userId } = useSettingsStore();

  const [localRetrievalMode, setLocalRetrievalMode] = useState<'legacy_hybrid' | 'ann_rerank_v1'>('legacy_hybrid');

  useEffect(() => {
    if (userId) {
      loadSettings(userId);
    }
  }, [loadSettings, userId]);

  useEffect(() => {
    if (settings?.retrievalMode) {
      setLocalRetrievalMode(settings.retrievalMode);
    }
  }, [settings?.retrievalMode]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-8 overflow-y-auto">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
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
            Configure your app preferences.
          </p>
        </div>

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

        <div className="space-y-6">
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

                <div className="pt-4 border-t border-gray-200 dark:border-slate-700">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Retrieval Mode (Feature Flag)
                  </label>
                  <select
                    value={localRetrievalMode}
                    onChange={async (e) => {
                      const mode = e.target.value as 'legacy_hybrid' | 'ann_rerank_v1';
                      setLocalRetrievalMode(mode);
                      await updateSettings({ retrievalMode: mode });
                    }}
                    className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                  >
                    <option value="legacy_hybrid">Legacy Hybrid (stable)</option>
                    <option value="ann_rerank_v1">ANN + Top-40 Rerank (beta)</option>
                  </select>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Use ANN mode for faster on-device retrieval. If ANN assets are missing, the app auto-falls back to legacy mode.
                  </p>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
