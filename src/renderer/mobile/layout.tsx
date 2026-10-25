import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const MobileContext = createContext(false);
export const MobileProvider = ({ mobile, children }: { mobile: boolean; children: ReactNode }) => <MobileContext.Provider value={mobile}>{children}</MobileContext.Provider>;
export const useMobile = () => useContext(MobileContext);

export function useMobileLayout(override?: boolean) {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    if (override !== undefined || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 760px)');
    const change = () => setMatches(media.matches);
    media.addEventListener('change', change);
    change();
    return () => media.removeEventListener('change', change);
  }, [override]);
  const mobile = override ?? matches;
  useEffect(() => {
    if (!mobile) return;
    const viewport = window.visualViewport;
    const update = () => document.documentElement.style.setProperty('--mobile-height', `${viewport?.height ?? window.innerHeight}px`);
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--mobile-height');
    };
  }, [mobile]);
  return mobile;
}
