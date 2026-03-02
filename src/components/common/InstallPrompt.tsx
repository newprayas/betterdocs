'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '../ui/Button';

type PromptPlatform = 'android' | 'ios';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const MAX_PROMPT_DISPLAYS = 3;
const STORAGE_KEYS = {
    installed: 'pwa_installed',
    androidPromptCount: 'pwa_prompt_android_count',
    iosPromptCount: 'pwa_prompt_ios_count',
};

const isRunningStandalone = () => {
    if (typeof window === 'undefined') return false;
    const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    const mediaStandalone = window.matchMedia('(display-mode: standalone)').matches;
    return iosStandalone || mediaStandalone;
};

const isIOSDevice = () => {
    if (typeof window === 'undefined') return false;
    const ua = window.navigator.userAgent.toLowerCase();
    const isAppleMobile = /iphone|ipad|ipod/.test(ua);
    const isIpadOs = window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
    return isAppleMobile || isIpadOs;
};

const isSafariBrowser = () => {
    if (typeof window === 'undefined') return false;
    const ua = window.navigator.userAgent.toLowerCase();
    return ua.includes('safari') && !ua.includes('crios') && !ua.includes('fxios') && !ua.includes('edgios') && !ua.includes('opios');
};

const getCountKey = (platform: PromptPlatform) =>
    platform === 'android' ? STORAGE_KEYS.androidPromptCount : STORAGE_KEYS.iosPromptCount;

const getPromptCount = (platform: PromptPlatform) => {
    if (typeof window === 'undefined') return 0;
    const raw = window.localStorage.getItem(getCountKey(platform));
    const count = Number(raw ?? '0');
    return Number.isFinite(count) ? count : 0;
};

const incrementPromptCount = (platform: PromptPlatform) => {
    if (typeof window === 'undefined') return;
    const next = getPromptCount(platform) + 1;
    window.localStorage.setItem(getCountKey(platform), String(next));
};

const hasReachedPromptLimit = (platform: PromptPlatform) => getPromptCount(platform) >= MAX_PROMPT_DISPLAYS;

const hasInstalledPwa = () => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEYS.installed) === '1';
};

export const InstallPrompt = () => {
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
    const [showPrompt, setShowPrompt] = useState(false);
    const [platform, setPlatform] = useState<PromptPlatform | null>(null);
    const [needsSafariNotice, setNeedsSafariNotice] = useState(false);

    const markInstalled = () => {
        if (typeof window !== 'undefined') {
            window.localStorage.setItem(STORAGE_KEYS.installed, '1');
        }
        setDeferredPrompt(null);
        setShowPrompt(false);
        setPlatform(null);
    };

    useEffect(() => {
        if (hasInstalledPwa() || isRunningStandalone()) return;

        if (isIOSDevice() && !hasReachedPromptLimit('ios')) {
            incrementPromptCount('ios');
            setPlatform('ios');
            setNeedsSafariNotice(!isSafariBrowser());
            setShowPrompt(true);
        }

        const handler = (e: Event) => {
            if (hasInstalledPwa() || isRunningStandalone() || hasReachedPromptLimit('android')) return;
            // Prevent the mini-infobar from appearing on mobile
            e.preventDefault();

            const installEvent = e as BeforeInstallPromptEvent;
            setDeferredPrompt(installEvent);
            setPlatform('android');
            incrementPromptCount('android');
            setShowPrompt(true);
        };

        const onAppInstalled = () => {
            window.localStorage.setItem(STORAGE_KEYS.installed, '1');
            setDeferredPrompt(null);
            setShowPrompt(false);
            setPlatform(null);
        };

        window.addEventListener('beforeinstallprompt', handler);
        window.addEventListener('appinstalled', onAppInstalled);

        return () => {
            window.removeEventListener('beforeinstallprompt', handler);
            window.removeEventListener('appinstalled', onAppInstalled);
        };
    }, []);

    const handleInstallClick = async () => {
        if (!deferredPrompt) return;

        // Show the install prompt
        await deferredPrompt.prompt();

        // Wait for the user to respond to the prompt
        const { outcome } = await deferredPrompt.userChoice;

        // We've used the prompt, and can't use it again, throw it away
        setDeferredPrompt(null);
        setShowPrompt(false);
        setPlatform(null);

        if (outcome === 'accepted') {
            markInstalled();
        }
    };

    if (!showPrompt || !platform) return null;

    if (platform === 'ios') {
        return (
            <div className="fixed inset-0 z-50 bg-slate-950/95 overflow-y-auto">
                <div className="min-h-full p-4 sm:p-6">
                    <div className="mx-auto max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
                        <div className="p-5 sm:p-6 border-b border-slate-700">
                            <h3 className="text-xl font-semibold text-white">Install MEDDY on iPhone</h3>
                            <p className="mt-2 text-sm text-slate-300">
                                Follow these steps to add MEDDY to your home screen.
                            </p>
                        </div>

                        <div className="p-5 sm:p-6 space-y-4">
                            {needsSafariNotice && (
                                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                                    Open MEDDY in Safari first, then use the steps below.
                                </p>
                            )}

                            <ol className="space-y-2 text-sm text-slate-200 list-decimal list-inside">
                                <li>Go to the MEDDY website in Safari.</li>
                                <li>Tap Share (box with an upward arrow).</li>
                                <li>Scroll down and tap Add to Home Screen.</li>
                                <li>Tap Add in the top-right corner.</li>
                            </ol>

                            <div className="rounded-xl border border-slate-700 bg-slate-950 p-2">
                                <img
                                    src="/onboarding/ios-add-to-home.png"
                                    alt="How to add MEDDY to iOS home screen"
                                    className="w-full rounded-lg"
                                />
                            </div>
                        </div>

                        <div className="p-5 sm:p-6 border-t border-slate-700 flex flex-col sm:flex-row justify-end gap-2">
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setShowPrompt(false);
                                    setPlatform(null);
                                }}
                            >
                                Not now
                            </Button>
                            <Button variant="primary" onClick={markInstalled}>
                                I added it
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

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
                        onClick={() => {
                            setShowPrompt(false);
                            setPlatform(null);
                        }}
                        className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="flex justify-end gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            setShowPrompt(false);
                            setPlatform(null);
                        }}
                    >
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
