import { describe, expect, it } from 'vitest';
import { updateFailure } from './update-errors';

describe('safe update failure classification', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %s without exposing the response', statusCode => {
    expect(updateFailure({ statusCode, message: 'private response content' })).toEqual({ retryable: true, message: `GitHub 更新服务返回 HTTP ${statusCode}，请稍后重试。` });
  });
  it.each([401, 403, 404])('does not retry HTTP %s', statusCode => {
    expect(updateFailure({ statusCode }).retryable).toBe(false);
  });
  it.each(['net::ERR_CONNECTION_RESET', 'HttpError: 503 Service Unavailable', 'net::ERR_TIMED_OUT'])('recognizes provider-wrapped transient failures: %s', message => {
    const result = updateFailure({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED', message: `Cannot parse releases feed: Unable to find latest version on GitHub: ${message}; private response` });
    expect(result.retryable).toBe(true); expect(result.message).not.toContain('private');
  });
  it('keeps a malformed release feed nonretryable', () => {
    expect(updateFailure({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED', message: 'Cannot parse releases feed: malformed XML' }).retryable).toBe(false);
  });
  it.each(['net::ERR_CERT_DATE_INVALID', 'ERR_CHECKSUM_MISMATCH', 'ERR_UPDATER_INVALID_SIGNATURE'])('prioritizes safety failure %s over embedded network evidence', code => {
    expect(updateFailure({ code, message: 'also ERR_CONNECTION_RESET and HTTP_ERROR_503' }).retryable).toBe(false);
  });
  it('never copies arbitrary messages, URLs, tokens, paths or headers into UI output', () => {
    const message = 'https://example.invalid/?token=secret C:\\private\\file Authorization: secret';
    expect(updateFailure(Error(message)).message).not.toContain('secret');
    expect(updateFailure({ code: 'ERR_UPDATER_INVALID_UPDATE_INFO', message }).message).not.toContain('private');
    expect(updateFailure(null).retryable).toBe(false);
  });
});
