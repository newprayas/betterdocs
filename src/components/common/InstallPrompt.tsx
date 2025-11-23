'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '../ui/Button';

export const InstallPrompt = () => {
    const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
    const [showPrompt, setShowPrompt] = useState(false);

    useEffect(() => {
        const handler = (e: any) => {
            // Prevent the mini-infobar from appearing on mobile
            e.preventDefault();
            // Stash the event so it can be triggered later.
            setDeferredPrompt(e);
            // Update UI notify the user they can install the PWA
            setShowPrompt(true);
        };

        window.addEventListener('beforeinstallprompt', handler);

        return () => {
            window.removeEventListener('beforeinstallprompt', handler);
        };
    }, []);

    const handleInstallClick = async () => {
        if (!deferredPrompt) return;

        // Show the install prompt
        deferredPrompt.prompt();

        // Wait for the user to respond to the prompt
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`User response to the install prompt: ${outcome}`);

        // We've used the prompt, and can't use it again, throw it away
        setDeferredPrompt(null);
        setShowPrompt(false);
    };

    if (!showPrompt) return null;

    return (
        <div className="fixed bottom-4 left-4 right-4 z-50 md:left-auto md:right-4 md:w-96">
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 flex flex-col gap-3">
                <div className="flex items-start justify-between">
                    <div>
                        <h3 className="font-semibold text-gray-900 dark:text-white">Install MEDDY</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                            Install our app for a better experience with offline access and faster loading.
                        </p>
                    </div>
                    <button
                        onClick={() => setShowPrompt(false)}
                        className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setShowPrompt(false)}>
                        Not now
                    </Button>
                    <Button variant="primary" size="sm" onClick={handleInstallClick}>
                        Install
                    </Button>
                </div>
            </div>
        </div>
    );
};
