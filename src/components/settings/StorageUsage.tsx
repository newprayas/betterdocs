import React, { useEffect, useState } from 'react';

interface StorageEstimate {
    quota: number;
    usage: number;
}

export const StorageUsage: React.FC = () => {
    const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isPersisted, setIsPersisted] = useState<boolean>(false);

    useEffect(() => {
        const fetchEstimate = async () => {
            try {
                if (navigator.storage && navigator.storage.estimate) {
                    const result = await navigator.storage.estimate();
                    setEstimate({
                        quota: result.quota || 0,
                        usage: result.usage || 0
                    });

                    // Check persistence
                    if (navigator.storage.persisted) {
                        const persisted = await navigator.storage.persisted();
                        setIsPersisted(persisted);
                    }
                } else {
                    setError('Storage API not supported in this browser');
                }
            } catch (err) {
                console.error('Failed to get storage estimate:', err);
                setError('Failed to load storage details');
            } finally {
                setLoading(false);
            }
        };

        fetchEstimate();
    }, []);

    const handleRequestPersistence = async () => {
        if (navigator.storage && navigator.storage.persist) {
            const granted = await navigator.storage.persist();
            setIsPersisted(granted);
            if (granted) {
                console.log('Persistent storage granted');
            } else {
                console.log('Persistent storage denied');
            }
        }
    };

    if (loading) {
        return (
            <div className="animate-pulse flex space-x-4">
                <div className="flex-1 space-y-2 py-1">
                    <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded w-full"></div>
                </div>
            </div>
        );
    }

    if (error || !estimate) {
        return (
            <div className="text-sm text-gray-500 dark:text-gray-400 italic">
                {error || 'Storage information unavailable'}
            </div>
        );
    }

    // Calculate percentage
    // Avoid division by zero
    const percentage = estimate.quota > 0
        ? Math.min(100, Math.round((estimate.usage / estimate.quota) * 100))
        : 0;

    // Format bytes to legible string (MB/GB)
    const formatBytes = (bytes: number, decimals = 1) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    };

    // Determine color based on usage
    let colorClass = 'bg-green-500';
    let message = 'Storage status: Healthy';

    if (percentage >= 80) {
        colorClass = 'bg-red-500';
        message = '⚠️ Storage Critical! Please delete some books.';
    } else if (percentage >= 60) {
        colorClass = 'bg-yellow-500';
        message = '⚠️ Storage getting full.';
    }

    return (
        <div className="w-full">
            <div className="flex justify-between items-end mb-2">
                <div>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1">
                        Storage Used
                    </span>
                    <div className="flex items-baseline gap-2">
                        <span className={`text-4xl font-bold ${percentage >= 80 ? 'text-red-600 dark:text-red-500' : percentage >= 60 ? 'text-yellow-600 dark:text-yellow-500' : 'text-blue-600 dark:text-blue-500'}`}>
                            {percentage}%
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                            ({formatBytes(estimate.usage)} / {formatBytes(estimate.quota)})
                        </span>
                    </div>
                </div>

                {/* Persistence Indicator */}
                <div className="flex flex-col items-end">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${isPersisted ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                        {isPersisted ? 'Persistent' : 'Standard'}
                    </span>
                </div>
            </div>

            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 mb-2">
                <div
                    className={`h-3 rounded-full transition-all duration-500 ${colorClass}`}
                    style={{ width: `${percentage}%` }}
                ></div>
            </div>

            <p className={`text-xs ${percentage >= 60 ? 'text-red-500 font-semibold' : 'text-gray-500 dark:text-gray-400'}`}>
                {message}
            </p>

            {!isPersisted && (
                <button
                    onClick={handleRequestPersistence}
                    className="mt-3 text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                >
                    <span>👉 Request Persistent Storage</span>
                </button>
            )}

            {percentage >= 60 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Note: Mobile browsers limit storage per site. If this bar gets full, the app may crash or fail to save chats.
                </p>
            )}
        </div>
    );
};
