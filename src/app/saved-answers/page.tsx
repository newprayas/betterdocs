'use client';

import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { Header, ThemeToggleButton } from '@/components/layout';
import { Button, Card, DropdownMenu, DropdownMenuItem, Input } from '@/components/ui';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirmDialog } from '@/components/common/ConfirmDialog';
import { useSavedAnswersStore, useSessionStore } from '@/store';
import { ensureDate } from '@/utils/date';
import { fuzzyFilter } from '@/utils/fuzzySearch';
import type { SavedAnswer } from '@/types';

const formatSavedAnswerDate = (date: Date | string): string =>
  ensureDate(date).toLocaleDateString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
  });

const SavedAnswerCard: React.FC<{
  answer: SavedAnswer;
  onRemove: (answer: SavedAnswer) => void;
}> = ({ answer, onRemove }) => {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(answer.content);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 1600);
    } catch (error) {
      console.error('Failed to copy saved answer:', error);
    }
  };

  return (
    <Card padding="none" shadow="sm" hover className="overflow-hidden">
      <div className="border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-gray-50 to-white dark:from-gray-900 dark:to-gray-800 px-4 sm:px-5 py-3">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300">
                {answer.sessionName}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatSavedAnswerDate(answer.savedAt)}
              </span>
            </div>

            <button
              type="button"
              onClick={() => onRemove(answer)}
              className="shrink-0 rounded p-0.5 text-rose-500 transition-colors hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 dark:text-rose-400 dark:hover:text-rose-300"
              aria-label="Delete saved answer"
              title="Delete saved answer"
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className="flex items-center">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              className="min-w-0 !px-2 !py-1 !text-xs"
            >
              <svg
                className="w-3.5 h-3.5 mr-1.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {isCopied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-5 py-4">
        <div className="saved-answer-markdown prose prose-sm max-w-none break-words text-gray-900 dark:text-gray-100 prose-p:text-gray-800 dark:prose-p:text-gray-200 prose-li:text-gray-800 dark:prose-li:text-gray-200 prose-strong:text-gray-900 dark:prose-strong:text-white prose-headings:text-gray-900 dark:prose-headings:text-white prose-a:text-sky-700 dark:prose-a:text-sky-400">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {answer.content}
          </ReactMarkdown>
        </div>
      </div>
    </Card>
  );
};

export default function SavedAnswersPage() {
  const { isCheckingAuth, isAuthenticated } = useAuthGuard({ requireAuth: true });
  const [isMounted, setIsMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('all');
  const userId = useSessionStore((state) => state.userId);
  const savedAnswers = useSavedAnswersStore((state) => state.savedAnswers);
  const isLoading = useSavedAnswersStore((state) => state.isLoading);
  const error = useSavedAnswersStore((state) => state.error);
  const loadSavedAnswers = useSavedAnswersStore((state) => state.loadSavedAnswers);
  const removeSavedAnswer = useSavedAnswersStore((state) => state.removeSavedAnswer);
  const { confirm, ConfirmDialog } = useConfirmDialog();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    void loadSavedAnswers(userId);
  }, [loadSavedAnswers, userId]);

  const sessionOptions = useMemo(() => {
    const sessions = new Map<string, { sessionId: string; sessionName: string; count: number }>();

    for (const answer of savedAnswers) {
      const current = sessions.get(answer.sessionId);
      if (current) {
        current.count += 1;
      } else {
        sessions.set(answer.sessionId, {
          sessionId: answer.sessionId,
          sessionName: answer.sessionName,
          count: 1,
        });
      }
    }

    return Array.from(sessions.values()).sort((left, right) =>
      left.sessionName.localeCompare(right.sessionName, undefined, { sensitivity: 'base' }),
    );
  }, [savedAnswers]);

  useEffect(() => {
    if (selectedSessionId === 'all') return;
    const hasSelectedSession = sessionOptions.some((option) => option.sessionId === selectedSessionId);
    if (!hasSelectedSession) {
      setSelectedSessionId('all');
    }
  }, [selectedSessionId, sessionOptions]);

  const selectedSessionLabel = useMemo(() => {
    if (selectedSessionId === 'all') return 'All sessions';
    return sessionOptions.find((option) => option.sessionId === selectedSessionId)?.sessionName || 'All sessions';
  }, [selectedSessionId, sessionOptions]);

  const filteredAnswers = useMemo(() => {
    const scopedAnswers = selectedSessionId === 'all'
      ? savedAnswers
      : savedAnswers.filter((answer) => answer.sessionId === selectedSessionId);

    return fuzzyFilter(
      scopedAnswers,
      searchQuery,
      (answer) => `${answer.sessionName} ${answer.content}`,
    );
  }, [savedAnswers, searchQuery, selectedSessionId]);

  const handleDeleteSavedAnswer = async (answer: SavedAnswer) => {
    const confirmed = await confirm({
      title: 'Delete saved answer',
      message: `Remove this saved answer from "${answer.sessionName}"? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
      onConfirm: async () => {
        await removeSavedAnswer(answer.id);
      },
    });

    if (!confirmed) return;
  };

  if (!isMounted || isCheckingAuth || !userId) return <LoadingScreen />;
  if (!isAuthenticated) return null;

  const hasSavedAnswers = savedAnswers.length > 0;
  const visibleCount = filteredAnswers.length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header
        title="Saved Answers"
        showBackButton
        actions={<ThemeToggleButton />}
      />

      <main className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-3 sm:py-4">
        <section className="sticky top-2 z-20 mt-1">
          <div className="rounded-2xl border border-slate-200/70 bg-white/80 p-2.5 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-950/70">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search saved answers..."
                leftIcon={
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35m1.85-5.65a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                }
                className="h-11 bg-white/95 dark:bg-slate-900/80"
              />

              <div className="flex flex-wrap items-center justify-between gap-3 lg:justify-end">
                <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  <span>{visibleCount}</span>
                  <span className="text-slate-400">/</span>
                  <span>{savedAnswers.length}</span>
                  <span>saved</span>
                </div>

                <DropdownMenu
                  align="right"
                  trigger={
                    <Button variant="outline" size="sm" className="min-w-[152px] justify-between gap-2">
                      <span className="inline-flex items-center gap-2">
                        <svg
                          className="w-4 h-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h18l-7 8v5l-4 2v-7L3 5z" />
                        </svg>
                        <span className="truncate">{selectedSessionLabel}</span>
                      </span>
                      <svg
                        className="w-4 h-4 shrink-0 text-slate-400"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                      </svg>
                    </Button>
                  }
                >
                  <DropdownMenuItem
                    onClick={() => setSelectedSessionId('all')}
                    variant={selectedSessionId === 'all' ? 'default' : 'default'}
                  >
                    All sessions
                  </DropdownMenuItem>
                  {sessionOptions.map((session) => (
                    <DropdownMenuItem
                      key={session.sessionId}
                      onClick={() => setSelectedSessionId(session.sessionId)}
                    >
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="truncate">{session.sessionName}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">{session.count}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenu>

                {searchQuery && (
                  <Button variant="outline" size="sm" onClick={() => setSearchQuery('')}>
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </div>
        )}

        <div className="mt-6">
          {isLoading && !hasSavedAnswers ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              Loading saved answers...
            </div>
          ) : filteredAnswers.length === 0 ? (
            <div className="mt-8">
              <EmptyState
                title={searchQuery ? 'No saved answers matched your search' : 'No saved answers yet'}
                description={
                  searchQuery
                    ? 'Try a different keyword or session name.'
                    : 'Save an assistant answer from chat or drug mode to build your library.'
                }
                action={
                  searchQuery ? (
                    <Button variant="outline" onClick={() => setSearchQuery('')}>
                      Clear search
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="mt-6 grid gap-4">
              {filteredAnswers.map((answer) => (
                <SavedAnswerCard
                  key={answer.id}
                  answer={answer}
                  onRemove={handleDeleteSavedAnswer}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <ConfirmDialog />
    </div>
  );
}
