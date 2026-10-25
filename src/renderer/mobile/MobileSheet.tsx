import type { ReactNode } from 'react';
import { Modal } from '../components/Modal';

/** Uses the shared dialog's focus handling; the mobile stylesheet places it above the safe area. */
export function MobileSheet({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  return <div className="mobile-sheet"><Modal title={title} onClose={close}>{children}</Modal></div>;
}
