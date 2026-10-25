import { CalendarDays, FileInput, Inbox, Sun, UserRound, Wallet } from "lucide-react";

export type Page = "today" | "calendar" | "inbox" | "ledger" | "me";
const entries = [
  ["today", "今天", Sun],
  ["calendar", "日历", CalendarDays],
  ["inbox", "待判断", Inbox],
  ["ledger", "账单", Wallet],
  ["me", "我的", UserRound],
] as const;

export function Nav({ page, navigate, pending, importPlan }: { page: Page; navigate: (page: Page) => void; pending: number; importPlan?: () => void }) {
  return (
    <aside className="a2-nav">
      <div className="a2-brand">
        <span className="a2-brand-mark" aria-hidden="true">日</span>
        <span className="a2-brand-name">终极日历</span>
      </div>
      <nav aria-label="主导航">
        {entries.map(([id, label, Icon]) => (
          <button key={id} className={page === id ? "on" : ""} aria-current={page === id ? "page" : undefined} onClick={() => navigate(id)}>
            <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
            <span>{label}</span>
            {id === "inbox" && pending > 0 && <b aria-label={`${pending} 条待判断`}>{pending}</b>}
          </button>
        ))}
        {importPlan && <button className="a2-nav-import" onClick={importPlan}><FileInput size={18} strokeWidth={1.7} aria-hidden="true" /><span>导入计划</span></button>}
      </nav>
    </aside>
  );
}
