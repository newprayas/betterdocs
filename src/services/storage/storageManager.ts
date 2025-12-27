
export interface StorageStats {
    quota: number;
    usage: number;
    percentUsed: number;
    isPersisted: boolean;
}

class StorageManager {
    private _isPersisted: boolean = false;

    async init(): Promise<boolean> {
        if (typeof navigator === 'undefined' || !navigator.storage) {
            console.warn('[StorageManager] Storage API not supported');
            return false;
        }

        try {
            // 1. Check current status
            this._isPersisted = await navigator.storage.persist();
            console.log(`[StorageManager] Persistence status: ${this._isPersisted ? '✅ Persisted' : '⚠️ Temporary'}`);

            // 2. If not persisted, try to request it (Silent Request)
            if (!this._isPersisted) {
                // Note: The browser decides based on engagement score. 
                // We just ask; we don't prompt the user visually effectively.
                this._isPersisted = await navigator.storage.persist();
                if (this._isPersisted) {
                    console.log('[StorageManager] Persistence granted successfully! 🎉');
                } else {
                    console.log('[StorageManager] Persistence request denied (for now). Browser may grant it later with more usage.');
                }
            }

            return this._isPersisted;
        } catch (error) {
            console.error('[StorageManager] Error initializing persistence:', error);
            return false;
        }
    }

    async getStats(): Promise<StorageStats> {
        if (typeof navigator === 'undefined' || !navigator.storage) {
            return { quota: 0, usage: 0, percentUsed: 0, isPersisted: false };
        }

        try {
            const estimate = await navigator.storage.estimate();
            const quota = estimate.quota || 0;
            const usage = estimate.usage || 0;
            const percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
            const isPersisted = await navigator.storage.persisted(); // Check live status

            return {
                quota,
                usage,
                percentUsed,
                isPersisted
            };
        } catch (error) {
            console.error('[StorageManager] Error getting stats:', error);
            return { quota: 0, usage: 0, percentUsed: 0, isPersisted: false };
        }
    }
}

export const storageManager = new StorageManager();
