export interface UpdateFailure { retryable: boolean; message: string }

/** Recognize error categories, never expose raw server responses, paths or signed URLs. */
export function updateFailure(error: unknown): UpdateFailure {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; statusCode?: unknown } : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  // GitHubProvider wraps transport failures in its own error; inspect only known tokens.
  const evidence = `${code} ${message}`;
  if (/ERR_CERT_|ERR_SSL_|CERT_HAS_EXPIRED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID/.test(evidence))
    return { retryable: false, message: '更新服务器的安全连接验证失败，已停止更新。请检查系统时间和网络的证书设置后重试。' };
  if (/ERR_UPDATER_INVALID_SIGNATURE|ERR_UPDATER_INVALID_CHECKSUM|ERR_UPDATER_CHECKSUM_MISMATCH|ERR_CHECKSUM_MISMATCH|checksum mismatch|sha512 checksum mismatch|signature verification/i.test(evidence))
    return { retryable: false, message: '更新文件校验失败，未安装。请重新检查并下载官方更新。' };
  if (code === 'UPDATE_RELEASE_CHANGED') return { retryable: false, message: '正式版本已发生变化，已停止此次下载。请重新检查更新。' };
  if (code === 'UPDATE_INCOMPLETE') return { retryable: false, message: '更新服务器未返回完整结果，请重新检查更新。' };
  const status = typeof record.statusCode === 'number' ? record.statusCode
    : Number(evidence.match(/\bHTTP_ERROR_(\d{3})\b/)?.[1] ?? evidence.match(/\bHttpError:\s*(\d{3})\b/)?.[1] ?? evidence.match(/\bstatus(?:Code)?[\s:=]+(\d{3})\b/i)?.[1]);
  if (Number.isInteger(status) && status >= 400 && status <= 599)
    return { retryable: status === 408 || status === 429 || status >= 500,
      message: `GitHub 更新服务返回 HTTP ${status}，请稍后重试。` };
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_PROXY_AUTH/.test(evidence))
    return { retryable: true, message: '系统代理暂时无法连接 GitHub，请检查代理是否正在运行后重试。' };
  if (/UPDATE_NETWORK_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/.test(evidence))
    return { retryable: true, message: '连接 GitHub 更新服务超时，请检查网络后重试。' };
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ERR_CONNECTION_(?:CLOSED|RESET|REFUSED|ABORTED)|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_HTTP2_PROTOCOL_ERROR|Request has been aborted by the server/.test(evidence))
    return { retryable: true, message: '连接 GitHub 更新服务时中断，请检查网络后重试。' };
  if (/ERR_UPDATER_(?:INVALID_UPDATE_INFO|NO_CHECKSUM|NO_FILES_PROVIDED|INVALID_RELEASE_FEED|CHANNEL_FILE_NOT_FOUND)/.test(code))
    return { retryable: false, message: '官方更新信息暂不完整，未安装。请稍后重新检查更新。' };
  return { retryable: false, message: '更新未能完成，请重新检查更新；本地数据和当前版本保持不变。' };
}

export function updateError(code: 'UPDATE_NETWORK_TIMEOUT' | 'UPDATE_CANCELLED' | 'UPDATE_RELEASE_CHANGED' | 'UPDATE_INCOMPLETE') {
  return Object.assign(new Error(code), { code });
}
