'use client';

import React, { useEffect, useState } from 'react';
import { useSessionStore, useChatStore } from '../../store';

interface GlobalLoadingScreenProps {
    minDisplayTime?: number; // Minimum time to show the screen in ms (default 1500)
}

export const GlobalLoadingScreen: React.FC<GlobalLoadingScreenProps> = ({
    minDisplayTime = 2000
}) => {
    const [isVisible, setIsVisible] = useState(true);
    const [minTimerExpired, setMinTimerExpired] = useState(false);

    // Store state
    const { isLoading: isSessionLoading } = useSessionStore();
    const { isPreloading, preloadingProgress, preloadMessages } = useChatStore();
    const { sessions } = useSessionStore();

    // 1. Handle Visibility Change (App Resume) & Initial Mount
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                console.log('📱 [GlobalLoading] App resumed/visible - Triggering splash screen');
                showSplashScreen();
            }
        };

        // Initial show
        showSplashScreen();

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, []);

    // Helper to reset timer and show screen
    const showSplashScreen = () => {
        setIsVisible(true);
        setMinTimerExpired(false);

        // Trigger preloading again on resume to ensure freshness
        const topSessionIds = useSessionStore.getState().sessions.slice(0, 5).map(s => s.id);
        if (topSessionIds.length > 0) {
            useChatStore.getState().preloadMessages(topSessionIds);
        }

        // Start timer
        setTimeout(() => {
            setMinTimerExpired(true);
        }, minDisplayTime);
    };

    /* Simulated Progress Logic */
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        if (!isVisible) {
            setProgress(0);
            return;
        }

        // Reset progress when showing
        setProgress(0);

        const intervalTime = 50; // Update every 50ms
        const steps = minDisplayTime / intervalTime;
        const increment = 95 / steps; // Target 95% over the duration

        const timer = setInterval(() => {
            setProgress(prev => {
                // If real loading is done and timer expired, we jump to 100 via the other effect
                // But here we cap at 95% until then to show "activity"
                if (prev >= 95) return 95;
                return Math.min(95, prev + increment);
            });
        }, intervalTime);

        return () => clearInterval(timer);
    }, [isVisible, minDisplayTime]);

    // 2. Logic to dismiss the screen
    useEffect(() => {
        // Requirements to dismiss:
        // 1. Minimum timer must have expired
        // 2. Sessions must be loaded
        // 3. Message preloading must be finished (or not active)

        if (minTimerExpired && !isSessionLoading && !isPreloading) {
            // Finish the bar
            setProgress(100);

            // Small buffer to ensure smooth transition
            const timeout = setTimeout(() => {
                setIsVisible(false);
            }, 300); // 300ms to let the bar finish filling visual
            return () => clearTimeout(timeout);
        }
    }, [minTimerExpired, isSessionLoading, isPreloading]);

    if (!isVisible) return null;

    return (
        <div className="fixed inset-0 z-[9999] bg-white dark:bg-gray-950 flex flex-col items-center justify-center transition-opacity duration-300">
            <div className="flex flex-col items-center space-y-8 animate-in fade-in zoom-in duration-300">
                {/* Logo or App Name */}
                <div className="relative mb-4">
                    <svg
                        className="h-20 w-20 text-blue-600 dark:text-blue-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                        />
                    </svg>
                </div>

                <div className="text-center space-y-2">
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">
                        MEDDY
                    </h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">
                        Preparing your workspace...
                    </p>
                </div>

                {/* Progress Bar */}
                <div className="w-64 space-y-2">
                    <div className="h-1.5 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-blue-600 rounded-full transition-all duration-300 ease-out"
                            style={{
                                width: `${Math.max(progress, isPreloading ? preloadingProgress : 0)}%`
                            }}
                        />
                    </div>
                    <p className="text-xs text-center text-gray-400 dark:text-gray-500">
                        {Math.round(Math.max(progress, isPreloading ? preloadingProgress : 0))}%
                    </p>
                </div>
            </div>
        </div>
    );
};
