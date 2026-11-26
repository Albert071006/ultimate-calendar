import { createContext, useCallback, useContext, useState } from 'react';
import type { ToastNotice } from '../components/shell/Toast';

type Feedback = {
  setNotice: (text: string, undo?: () => void) => void;
  dismissNotice: (text?: string) => void;
  setError: (text: string) => void;
};
export const FeedbackContext = createContext<Feedback>({
  setNotice: () => {},
  dismissNotice: () => {},
  setError: () => {},
});
export const useFeedback = () => useContext(FeedbackContext);

export function useToastNotice() {
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const setNotice = useCallback<Feedback['setNotice']>((text, undo) => setToast(text ? { text, undo } : null), []);
  const dismissNotice = useCallback((text?: string) => {
    setToast(current => text === undefined || text === current?.text ? null : current);
  }, []);
  return { toast, setNotice, dismissNotice };
}
