'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
    useEffect(() => {
        if (process.env.NODE_ENV !== 'production') return;
        if (!('serviceWorker' in navigator)) return;

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
