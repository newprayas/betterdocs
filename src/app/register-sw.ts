'use client';

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';

export function ServiceWorkerRegister() {
    useEffect(() => {
        if (process.env.NODE_ENV !== 'production') return;
        if (!('serviceWorker' in navigator)) return;
        if (Capacitor.isNativePlatform()) {
            navigator.serviceWorker.getRegistrations()
                .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
                .catch((error) => {
                    console.error('Failed to clear native service workers:', error);
                });

            if ('caches' in window) {
                caches.keys()
                    .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
                    .catch((error) => {
                        console.error('Failed to clear native caches:', error);
                    });
            }

            return;
        }

        const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
        if (window.location.protocol !== 'https:' && !isLocalhost) return;

        const onLoad = () => {
            navigator.serviceWorker
                .register('/sw.js', { scope: '/' })
                .catch((error) => {
                    console.error('Service Worker registration failed:', error);
                });
        };

        window.addEventListener('load', onLoad);
        return () => {
            window.removeEventListener('load', onLoad);
        };
    }, []);

    return null;
}
