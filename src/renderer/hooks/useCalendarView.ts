import { useState } from 'react';
import type { CalendarView } from '../calendar-layout';

export const desktopViewPreference = { key: 'ultimate-calendar:desktop-calendar-view', views: ['week', 'day', 'month'] } as const;
export const mobileViewPreference = { key: 'ultimate-calendar:mobile-calendar-view', views: ['day', 'three-day', 'month'] } as const;
export type DesktopCalendarView = typeof desktopViewPreference.views[number];

export function useCalendarView<T extends CalendarView>({ key, views }: { key: string; views: readonly [T, ...T[]] }) {
  const [view, setView] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return views.find(value => value === saved) ?? views[0];
    } catch { return views[0]; }
  });
  function selectView(value: T) {
    setView(value);
    try { localStorage.setItem(key, value); } catch { /* Keep the selection for this session. */ }
  }
  return [view, selectView] as const;
}
