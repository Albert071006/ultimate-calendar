import { describe, expect, it } from 'vitest';
import { formatFriendlyDate, formatFriendlyInstant, formatFriendlyRange } from './display-time';

describe('Beijing user-facing dates', () => {
  it('formats a date and supports an explicit year', () => {
    expect(formatFriendlyDate('2026-11-13')).toBe('周五 11月13日');
    expect(formatFriendlyDate('2026-11-13', { weekday: false, year: true })).toBe('2026年11月13日');
  });
  it('converts UTC to Beijing before selecting the day or clock', () => {
    expect(formatFriendlyInstant('2026-11-12T16:00:00Z')).toBe('周五 11月13日 00:00');
    expect(formatFriendlyInstant('2026-11-13 21:15')).toBe('周五 11月13日 21:15');
  });
  it('does not repeat a single day and preserves overnight and cross-year ranges', () => {
    expect(formatFriendlyRange('2026-11-13T21:15:00+08:00', '2026-11-13T22:00:00+08:00')).toBe('周五 11月13日 21:15–22:00');
    expect(formatFriendlyRange('2026-11-13', '2026-11-13')).toBe('周五 11月13日');
    expect(formatFriendlyRange('2026-12-31T23:00:00+08:00', '2027-01-01T01:00:00+08:00')).toBe('周四 2026年12月31日 23:00 至 周五 2027年1月1日 01:00');
    expect(formatFriendlyRange('2026-11-13T23:00:00+08:00', '2026-11-14T01:00:00+08:00')).toBe('周五 11月13日 23:00 至 周六 11月14日 01:00');
  });
  it('leaves invalid values readable rather than inventing a date', () => {
    expect(formatFriendlyDate('2026-02-30')).toBe('2026-02-30');
    expect(formatFriendlyInstant('待定')).toBe('待定');
  });
});
