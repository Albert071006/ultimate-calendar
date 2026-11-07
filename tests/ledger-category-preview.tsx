/** Isolated layout fixture. No production client, storage or model requests. */
import { createRoot } from 'react-dom/client';
import { EntryEditor } from '../src/renderer/components/ledger/editors';
import { Modal } from '../src/renderer/components/Modal';
import { MobileProvider } from '../src/renderer/mobile/layout';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, LedgerSnapshotSchema } from '../src/shared/ledger';
import { summarizeLedger } from '../src/ledger/summary';
import '../src/renderer/styles.css';
import '../src/renderer/theme/tokens.css';
import '../src/renderer/theme/base.css';
import '../src/renderer/theme/forms.css';
import '../src/renderer/components/LedgerPage.css';
import '../src/renderer/mobile/mobile.css';

const mode = new URLSearchParams(location.search).get('viewport');
const entries = [LedgerEntrySchema.parse({ id: 'fixture-postage', kind: 'expense', date: '2026-01-15', month: '2026-01', title: '合成寄件', category: '自定义寄件',
  amountCents: 1000, personalCents: 1000, cashflows: [{ accountId: 'alipay', deltaCents: -1000 }], version: 1, createdAt: '2026-01-15T04:00:00Z', updatedAt: '2026-01-15T04:00:00Z' })];
const snapshot = LedgerSnapshotSchema.parse({ revision: 1, entries, balanceSnapshots: [], audit: [], sources: [], rules: DEFAULT_LEDGER_RULES,
  summary: summarizeLedger({ entries, balanceSnapshots: [] }, { month: '2026-01' }) });
document.body.style.minWidth = '0';
createRoot(document.getElementById('root')!).render(mode ? <MobileProvider mobile={mode === 'mobile'}>
  <div className={`app-shell a2 ${mode === 'mobile' ? 'is-mobile' : ''}`}>
    <Modal title="记一笔 · 合成数据" onClose={() => {}}><EntryEditor snapshot={snapshot} busy={false} error="" save={async () => false} close={() => {}} /></Modal>
  </div>
</MobileProvider> : <main style={{ padding: 16, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'start' }}>
  {([['desktop', 780], ['mobile', 390]] as const).map(([viewport, width]) => <section key={viewport}>
    <p>{viewport === 'mobile' ? '手机宽度' : '桌面宽度'} {width}px · 合成数据 · 不保存</p>
    <iframe title={`${viewport}分类检查`} src={`?viewport=${viewport}`} style={{ width, height: 780, border: '1px solid #aaa', display: 'block' }} />
  </section>)}
</main>);
