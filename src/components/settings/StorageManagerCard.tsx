
'use client';

import React, { useEffect, useState } from 'react';
import { storageManager, StorageStats } from '../../services/storage/storageManager';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

export function StorageManagerCard() {
    const [stats, setStats] = useState<StorageStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadStats();
    }, []);

    const loadStats = async () => {
        const data = await storageManager.getStats();
        setStats(data);
        setLoading(false);
    };

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    if (loading) return null;

    const isPersisted = stats?.isPersisted;
    const percentUsed = stats?.percentUsed || 0;

    return (
        <Card className="w-full mb-6" padding="none">
            <CardHeader>
                <div className="flex items-center gap-2 text-lg font-medium">
                    {/* Database Icon SVG */}
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                        <path d="M21 12c0 1.66-9 3-9 3s-9-1.34-9-3"></path>
                        <path d="M3 5v14c0 1.66 9 3 9 3s9-1.34 9-3V5"></path>
                    </svg>
                    Storage & Health
                </div>
            </CardHeader>
            <CardBody>
                <div className="space-y-4">
                    {/* Persistence Status */}
                    <div className={`p-4 rounded-lg flex items-center gap-3 ${isPersisted ? 'bg-green-500/10 border border-green-500/20' : 'bg-yellow-500/10 border border-yellow-500/20'}`}>
                        {isPersisted ? (
                            // Check Circle Icon
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-600 dark:text-green-400">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                                <polyline points="22 4 12 14.01 9 11.01"></polyline>
                            </svg>
                        ) : (
                            // Alert Triangle Icon
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-600 dark:text-yellow-400">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                                <line x1="12" y1="9" x2="12" y2="13"></line>
                                <line x1="12" y1="17" x2="12.01" y2="17"></line>
                            </svg>
                        )}
                        <div>
                            <h3 className={`font-semibold ${isPersisted ? 'text-green-700 dark:text-green-300' : 'text-yellow-700 dark:text-yellow-300'}`}>
                                {isPersisted ? 'Data is Protected (Persisted)' : 'Data Risk: Temporary Storage'}
                            </h3>
                            <p className="text-sm opacity-90 text-foreground/80">
                                {isPersisted
                                    ? 'Your library is safe from automatic browser cleanup.'
                                    : 'Browser may delete books if device space gets low.'}
                            </p>
                        </div>
                    </div>

                    {/* Quota Usage */}
                    <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                                {/* Hard Drive Icon */}
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="22" y1="12" x2="2" y2="12"></line>
                                    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                                    <line x1="6" y1="16" x2="6.01" y2="16"></line>
                                    <line x1="10" y1="16" x2="10.01" y2="16"></line>
                                </svg>
                                Storage Used
                            </span>
                            <span className="font-medium">
                                {formatBytes(stats?.usage || 0)} / {formatBytes(stats?.quota || 0)}
                            </span>
                        </div>

                        {/* Custom Progress Bar */}
                        <div className="h-2 w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-blue-600 dark:bg-blue-500 transition-all duration-500 ease-out"
                                style={{ width: `${Math.min(percentUsed, 100)}%` }}
                            />
                        </div>

                        <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{percentUsed.toFixed(1)}% used</span>
                            <span>{formatBytes((stats?.quota || 0) - (stats?.usage || 0))} free</span>
                        </div>
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}
