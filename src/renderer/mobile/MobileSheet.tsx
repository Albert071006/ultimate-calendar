import type { ReactNode } from 'react';
import { Sheet } from './Sheet';

/** Opens shared detail content in a phone sheet; `bare` when the content already shows its own title and close button. */
export function MobileSheet({ title, children, close, bare = false }: { title: string; children: ReactNode; close: () => void; bare?: boolean }) {
  return <Sheet title={title} onClose={close} bare={bare}>{children}</Sheet>;
}
