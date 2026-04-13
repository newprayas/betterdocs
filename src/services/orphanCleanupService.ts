import { getIndexedDBServices } from './indexedDB';

export const ORPHAN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_LAST_RUN_PREFIX = 'orphan_cleanup_last_run_v1:';
const CLEANUP_START_EVENT = 'rag:orphan-cleanup-start';
const CLEANUP_END_EVENT = 'rag:orphan-cleanup-end';

type CleanupSummary = {
  orphanSessionsRemoved: number;
  orphanMessagesRemoved: number;
  orphanDocumentsRemoved: number;
  orphanEmbeddingsRemoved: number;
  orphanAnnIndexesRemoved: number;
  orphanRouteIndexesRemoved: number;
};

type CleanupResult = {
  ran: boolean;
  summary?: CleanupSummary;
};

const inFlightCleanupByUserId = new Map<string, Promise<CleanupResult>>();

const isBrowser = (): boolean => typeof window !== 'undefined';

const getCleanupKey = (userId: string): string => `${CLEANUP_LAST_RUN_PREFIX}${userId}`;

const dispatchCleanupEvent = (eventName: string): void => {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(eventName));
};

const isCleanupDue = (userId: string): boolean => {
  if (!isBrowser() || !userId) return false;

  const lastRunRaw = window.localStorage.getItem(getCleanupKey(userId));
  const lastRun = lastRunRaw ? Number(lastRunRaw) : 0;
  const now = Date.now();

  return !Number.isFinite(lastRun) || now - lastRun >= ORPHAN_CLEANUP_INTERVAL_MS;
};

/**
 * Runs the orphan cleanup only when it is due.
 * The UI listens for start/end events and shows the existing cleanup overlay.
 */
export async function runOrphanCleanupIfDue(userId: string): Promise<CleanupResult> {
  if (!isBrowser() || !userId) {
    return { ran: false };
  }

  if (!isCleanupDue(userId)) {
    return { ran: false };
  }

  const existing = inFlightCleanupByUserId.get(userId);
  if (existing) {
    return existing;
  }

  const cleanupPromise = (async (): Promise<CleanupResult> => {
    dispatchCleanupEvent(CLEANUP_START_EVENT);

    try {
      const { sessionService } = getIndexedDBServices();
      const summary = await sessionService.cleanupOrphanedData();
      window.localStorage.setItem(getCleanupKey(userId), String(Date.now()));
      return { ran: true, summary };
    } catch (error) {
      console.warn('[ORPHAN CLEANUP] Failed during cleanup:', error);
      return { ran: true };
    } finally {
      dispatchCleanupEvent(CLEANUP_END_EVENT);
    }
  })();

  inFlightCleanupByUserId.set(userId, cleanupPromise);

  try {
    return await cleanupPromise;
  } finally {
    inFlightCleanupByUserId.delete(userId);
  }
}

