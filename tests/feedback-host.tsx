import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { FeedbackContext, useToastNotice } from '../src/renderer/hooks/useFeedback';
import { Toast } from '../src/renderer/components/shell/Toast';

export function FeedbackHost({ children }: { children: ReactNode }) {
  const feedback = useToastNotice();
  return <FeedbackContext.Provider value={{ ...feedback, setError: () => {} }}>
    {children}<Toast notice={feedback.toast} dismiss={feedback.dismissNotice} />
  </FeedbackContext.Provider>;
}
export const renderWithFeedback = (component: ReactElement) => render(component, { wrapper: FeedbackHost });
