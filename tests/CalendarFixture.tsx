import { useState, type ComponentProps } from 'react';
import { Calendar } from '../src/renderer/components/Calendar';
import type { DesktopCalendarView } from '../src/renderer/hooks/useCalendarView';

/** Component tests control the date directly and start each calendar in week view. */
export function CalendarFixture(props: Omit<ComponentProps<typeof Calendar>, 'view' | 'setView'>) {
  const [view, setView] = useState<DesktopCalendarView>('week');
  return <Calendar {...props} view={view} setView={setView} />;
}
