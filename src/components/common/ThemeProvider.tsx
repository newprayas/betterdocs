'use client';

import { useEffect } from 'react';

export const ThemeProvider = () => {
  // Force dark mode globally.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('dark');
    root.classList.remove('light');
  }, []);

  // This component doesn't render anything
  return null;
};
