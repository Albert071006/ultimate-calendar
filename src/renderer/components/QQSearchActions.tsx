import { useState, type ReactNode } from 'react';
import { qqSearchInfo, type QQSearchEvidence } from '../qq-search';

/** This client has no verified exact-message navigation API. Say what copying actually does. */
export function QQSearchActions({ evidence, children }: { evidence: QQSearchEvidence; children?: ReactNode }) {
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState('');
  const search = qqSearchInfo(evidence);
  async function copy(value: string, name: string) {
    try {
      await navigator.clipboard.writeText(value);
      setManual(''); setNotice(`已复制${name}，请在 QQ 对应群的聊天记录中搜索。`);
    } catch {
      setManual(value); setNotice('未能复制，请选中下方文字手动复制。');
    }
  }
  return <div className="qq-search-actions">
    <div className="toolbar">
      {children}
      {search.keyword && <button type="button" className="ui-btn sm" onClick={() => void copy(search.keyword, '关键词')}>复制 QQ 搜索关键词</button>}
      <button type="button" className="ui-btn sm" onClick={() => void copy(search.information, '群与时间')}>复制群与时间</button>
    </div>
    <p className="fine-print">在 QQ 打开对应群 → 聊天记录，粘贴关键词或按时间查找。暂不支持直接定位原消息。</p>
    {notice && <p role="status" className="hint">{notice}</p>}
    {manual && <textarea aria-label="QQ 检索信息" readOnly value={manual} onFocus={event => event.currentTarget.select()} />}
  </div>;
}
