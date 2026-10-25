import { createContext, useContext, useEffect, type ReactNode } from 'react';

const MobileContext = createContext(false);
export const MobileProvider = ({ mobile, children }: { mobile: boolean; children: ReactNode }) => <MobileContext.Provider value={mobile}>{children}</MobileContext.Provider>;
export const useMobile = () => useContext(MobileContext);

/**
 * Pins the phone shell to the visible part of the screen. When the iOS keyboard opens, Safari shrinks the
 * visual viewport and may scroll it down; `--mobile-top` / `--mobile-height` let fixed layers follow it
 * instead of sliding off the top of the screen.
 */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport, root = document.documentElement.style;
    const update = () => {
      root.setProperty('--mobile-height', `${viewport?.height ?? window.innerHeight}px`);
      root.setProperty('--mobile-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      root.removeProperty('--mobile-height');
      root.removeProperty('--mobile-top');
    };
  }, []);
}
