/** Search information for the official client, not a fabricated QQ deep link. */
export interface QQSearchEvidence {
  groupId: string;
  groupName?: string;
  senderName?: string;
  sentAt: string | null;
  text: string;
  attachment?: boolean;
}

export function qqSearchInfo(value: QQSearchEvidence): { keyword: string; information: string } {
  // Extracted attachment text may never have appeared in the group's message body.
  const keyword = value.attachment ? '' : value.text.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 80) ?? '';
  const information = [
    `QQ群：${value.groupName ? `${value.groupName}（${value.groupId}）` : value.groupId}`,
    `发送时间：${value.sentAt ? value.sentAt.slice(0, 19).replace('T', ' ') + '（北京时间）' : '未取得'}`,
    value.senderName ? `发送人：${value.senderName}` : '',
    keyword ? `关键词：${keyword}` : '请按发送时间查找原消息或附件。',
  ].filter(Boolean).join('\n');
  return { keyword, information };
}
