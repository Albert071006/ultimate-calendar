import {
  CalendarDays,
  CircleCheck,
  Inbox,
  Settings,
  Sun,
  Target,
  Wallet,
} from "lucide-react";

// Adapted from Tabler Icons brand-qq (eyes removed), MIT. See bundled third-party/tabler-icons-LICENSE.txt.
function QQIcon({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 9.748a14.716 14.716 0 0 0 11.995 -.052c.275 -9.236 -11.104 -11.256 -11.995 .052" />
      <path d="M18 10c.984 2.762 1.949 4.765 2 7.153c.014 .688 -.664 1.346 -1.184 .303c-.346 -.696 -.952 -1.181 -1.816 -1.456" />
      <path d="M17 16c.031 1.831 .147 3.102 -1 4" />
      <path d="M8 20c-1.099 -.87 -.914 -2.24 -1 -4" />
      <path d="M6 10c-.783 2.338 -1.742 4.12 -1.968 6.43c-.217 2.227 .716 1.644 1.16 .917c.296 -.487 .898 -.934 1.808 -1.347" />
      <path d="M15.898 13l-.476 -2" />
      <path d="M8 20l-1.5 1c-.5 .5 -.5 1 .5 1h10c1 0 1 -.5 .5 -1l-1.5 -1" />
    </svg>
  );
}

export type Page =
  "today" | "calendar" | "inbox" | "tasks" | "goals" | "ledger" | "capture" | "settings";
const entries = [
  ["today", "今天", Sun],
  ["calendar", "日历", CalendarDays],
  ["inbox", "待判断", Inbox],
  ["tasks", "任务", CircleCheck],
  ["goals", "目标", Target],
  ["ledger", "账单", Wallet],
  ["capture", "QQ 采集", QQIcon],
  ["settings", "设置", Settings],
] as const;
export function Sidebar({
  page,
  navigate,
  pending,
  onImport,
  hostPages = true,
}: {
  page: Page;
  navigate: (page: Page) => void;
  pending: number;
  onImport: () => void;
  /** Capture and settings run only on the Windows host. */
  hostPages?: boolean;
}) {
  return (
    <aside className="sidebar">
      <div className="wordmark">
        <span className="brand-mark">日</span>
        <div>
          终极日历<small>让时间有方向</small>
        </div>
      </div>
      <button className="new-button" onClick={onImport}>
        ＋ 导入消息
      </button>
      <nav aria-label="主导航">
        {entries.filter(([id]) => hostPages || (id !== "capture" && id !== "settings")).map(([id, label, Icon]) => (
          <button
            key={id}
            className={page === id ? "active" : ""}
            onClick={() => navigate(id)}
          >
            <Icon size={19} />
            <span>{label}</span>
            {id === "inbox" && pending > 0 && <b>{pending}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="live-dot" /> 本机保存
        <small>Asia/Shanghai · 周一开始</small>
      </div>
    </aside>
  );
}
