/** Short main-process leases let the collector recover its entry point after a cloud-window crash. */
export const COLLECTOR_TRAY_LEASE_MS = 15_000;
export const COLLECTOR_TRAY_RENEW_MS = 5_000;

export function createCollectorTrayOwnership(setVisible: (visible: boolean) => void) {
  let owner: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const restore = () => { owner = undefined; timer = undefined; if (!closed) setVisible(true); };
  return {
    update(request: { owner: string; active: boolean }) {
      if (closed) return;
      if (request.active) {
        if (timer) clearTimeout(timer);
        if (!owner) setVisible(false);
        owner = request.owner;
        timer = setTimeout(restore, COLLECTOR_TRAY_LEASE_MS); timer.unref();
      } else if (owner === request.owner) {
        if (timer) clearTimeout(timer);
        restore();
      }
    },
    close() { closed = true; if (timer) clearTimeout(timer); timer = undefined; owner = undefined; },
  };
}
