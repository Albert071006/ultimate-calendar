import { SettingsSchema } from './contracts';

export const PROFILE_SETTINGS_HEADER = 'X-Planner-Profile-Settings-Version';
export const PROFILE_SETTINGS_VERSION = '1';
export const CaptureUserProfileSchema = SettingsSchema.pick({ campus: true, locationContext: true, personalContext: true });

/** Preserve the strict response shape understood by an older desktop or PWA. */
export function legacyProfileSettingsResult(method: string, result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('data' in result)) return result;
  const data = result.data;
  if (!data || typeof data !== 'object') return result;
  const omit = (value: object) => { const { personalContext: _context, ...rest } = value as Record<string, unknown>; return rest; };
  if (method === 'saveSettings') return { ...result, data: omit(data) };
  if (method === 'snapshot' && 'settings' in data && data.settings && typeof data.settings === 'object') return { ...result, data: { ...data, settings: omit(data.settings) } };
  return result;
}
