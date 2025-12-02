'use client';

import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/store';

export const ThemeProvider = () => {
  const { settings } = useSettingsStore();
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;
    
    if (settings?.theme === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.add('light');
      root.classList.remove('dark');
    }
  }, [settings?.theme, mounted]);

  // This component doesn't render anything
  return null;
};