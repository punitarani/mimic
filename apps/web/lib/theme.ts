'use client';
import { useCallback, useEffect, useState } from 'react';
import { THEME_KEY } from './theme-boot';

export type Theme = 'light' | 'dark' | 'system';

const KEY = THEME_KEY;

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** The person's theme choice, stored on this device. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>('system');
  useEffect(() => setThemeState(read()), []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }, []);
  return [theme, setTheme];
}
