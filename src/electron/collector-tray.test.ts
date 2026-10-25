import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLLECTOR_TRAY_LEASE_MS, createCollectorTrayOwnership } from './collector-tray';

afterEach(() => vi.useRealTimers());
describe('collector tray ownership', () => {
  it('hides while the cloud owner renews, then restores after an unannounced crash', async () => {
    vi.useFakeTimers(); const visible = vi.fn(), lease = createCollectorTrayOwnership(visible);
    lease.update({ owner: 'cloud', active: true }); expect(visible).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(COLLECTOR_TRAY_LEASE_MS - 1);
    lease.update({ owner: 'cloud', active: true });
    await vi.advanceTimersByTimeAsync(COLLECTOR_TRAY_LEASE_MS - 1); expect(visible).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(visible).toHaveBeenLastCalledWith(true); lease.close();
  });
  it('restores immediately on release and ignores a stale owner after takeover', async () => {
    vi.useFakeTimers(); const visible = vi.fn(), lease = createCollectorTrayOwnership(visible);
    lease.update({ owner: 'old', active: true }); lease.update({ owner: 'new', active: true });
    lease.update({ owner: 'old', active: false }); expect(visible).toHaveBeenCalledOnce();
    lease.update({ owner: 'new', active: false }); expect(visible).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(COLLECTOR_TRAY_LEASE_MS); expect(visible).toHaveBeenCalledTimes(2); lease.close();
  });
  it('does not resurrect a tray after collector shutdown', async () => {
    vi.useFakeTimers(); const visible = vi.fn(), lease = createCollectorTrayOwnership(visible);
    lease.update({ owner: 'cloud', active: true }); lease.close();
    await vi.advanceTimersByTimeAsync(COLLECTOR_TRAY_LEASE_MS); expect(visible).toHaveBeenCalledOnce();
  });
});
