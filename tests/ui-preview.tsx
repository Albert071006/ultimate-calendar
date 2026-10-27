/** Isolated developer layout harness. Never imported by production main/build. All records are synthetic. */
import { createRoot } from "react-dom/client";
import { App } from "../src/renderer/App";
import { SnapshotSchema, type DesktopAPI } from "../src/shared/contracts";
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, LedgerSnapshotSchema, ledgerToday } from "../src/shared/ledger";
import { summarizeLedger } from "../src/ledger/summary";
import { emptyAccountState } from "../src/shared/account";
import { SpaceSnapshotSchema } from "../src/shared/space";
import type { ResourceReference } from '../src/shared/resources';
import "../src/renderer/styles.css";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const monday = new Date(today);
monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
const day = (offset: number) => { const d = new Date(monday); d.setDate(monday.getDate() + offset); return iso(d); };
const later = (days: number) => iso(new Date(Date.now() + days * 864e5));
const termStart = day(-7 * 7);
const at = (offset: number, time: string) => `${day(offset)}T${time}:00+08:00`;
const meta = { version: 1, createdAt: at(0, "08:00"), updatedAt: at(0, "08:00") };
const sampleResource: ResourceReference = { id: 'synthetic-resource', kind: 'file', name: '实验练习与参考答案.pdf', deviceId: 'synthetic-pc', deviceName: '示例电脑' };
const sharedResource: ResourceReference = { id: 'synthetic-web', kind: 'web', name: '课程资料与听力', url: 'https://example.org/course' };
// Colors mirror what the app assigns when it opens a profile; the preview never opens one.
const colors: Record<string, string> = { 高等数学: "#3b5b9a", 大学物理: "#b8611f", 线性代数: "#5d8a2e", 程序设计: "#7a5230", 大学英语: "#23807a" };
const course = (id: string, title: string, location: string, weekday: number, startTime: string, endTime: string) =>
  ({ ...meta, id, title, location, weekday, startTime, endTime, firstWeek: 1, lastWeek: 18, termStart, color: colors[title], resources: [sharedResource] });

const snapshot = SnapshotSchema.parse({
  schemaVersion: 1,
  sources: [
    { ...meta, id: "s1", kind: "text", label: "合成竞赛群", text: "合成通知原文", sentAt: `${iso(today)}T10:42:00+08:00`, importedAt: at(0, "08:00") },
    { ...meta, id: "s2", kind: "text", label: "合成图书馆群", text: "合成通知原文", sentAt: `${iso(today)}T09:15:00+08:00`, importedAt: at(0, "08:00") },
    { ...meta, id: "s3", kind: "text", label: "合成学生会群", text: "合成通知原文", sentAt: at(-1, "20:03"), importedAt: at(0, "08:00") },
  ],
  candidates: [
    { ...meta, id: "c1", title: "合成示例：建模校赛报名", action: "三人组队，在报名系统提交队伍信息和指导老师", benefit: "获奖可加综测分", benefitKind: "stated", sourceIds: ["s1"],
      deadline: { date: later(2), time: "22:00" }, eventStart: `${later(4)}T13:30:00+08:00`, location: "线上",
      sourceQuote: "合成示例：校建模竞赛开放报名，三人一队，请于本周五晚十点前提交队伍信息。比赛于下周一 13:30 开始，线上进行。获奖可加综测分。",
      temporalEvidence: [{ field: "deadline", basis: "relative", quote: "本周五晚十点前" }, { field: "eventStart", basis: "relative", quote: "下周一 13:30" }], uncertainties: ["报名系统网址未在消息中给出。"] },
    { ...meta, id: "c2", title: "合成示例：文献检索讲座", action: "现场参加", potentialBenefit: "写课程报告时用得上", sourceIds: ["s2"],
      eventStart: `${iso(today)}T19:00:00+08:00`, eventEnd: `${iso(today)}T20:30:00+08:00`, location: "合成报告厅" },
    { ...meta, id: "c3", title: "合成示例：志愿者招募", action: "填写问卷", sourceIds: ["s3"], uncertainties: ["时间未说明"] },
    { ...meta, id: "c4", title: "合成示例：跑步打卡", action: "每周打卡", sourceIds: ["s3"], snoozedUntil: `${later(2)}T09:00:00+08:00` },
  ],
  tasks: [
    { ...meta, id: "t1", title: "合成示例：实验报告", deadline: { date: day(2), time: "23:59" }, courseId: "k2", resources: [sampleResource] },
    { ...meta, id: "t2", title: "合成示例：英语模拟卷", deadline: { date: day(5), time: null }, goalId: "g1" },
    { ...meta, id: "t3", title: "合成示例：整理笔记", status: "done" },
  ],
  blocks: [
    { ...meta, id: "b1", title: "写实验报告", kind: "work", taskId: "t1", start: at(1, "19:00"), end: at(1, "21:00") },
    { ...meta, id: "b2", title: "合成例会", kind: "event", start: at(2, "18:30"), end: at(2, "19:30"), location: "合成活动室" },
    { ...meta, id: "b3", title: "健身", kind: "event", start: at(4, "16:30"), end: at(4, "17:30") },
    { ...meta, id: "b4", title: "背单词", kind: "work", start: at(0, "07:30"), end: at(0, "08:00"), completed: true },
  ],
  goals: [{ ...meta, id: "g1", title: "合成示例：通过英语考试", priority: "high", targetDate: day(50), color: "#9b3f8c" }],
  courses: [
    course("k1", "高等数学", "合成教室 101", 1, "08:00", "09:35"),
    course("k2", "大学物理", "合成教室 305", 1, "10:05", "11:40"),
    course("k3", "线性代数", "合成教室 204", 2, "08:00", "09:35"),
    course("k4", "程序设计", "合成机房", 3, "14:00", "15:35"),
    course("k5", "高等数学", "合成教室 101", 3, "08:00", "09:35"),
    course("k6", "大学英语", "合成教室 402", 4, "10:05", "11:40"),
  ],
  courseExceptions: [], preferences: [], feedback: [],
  settings: { termStart, termWeeks: 18 },
  journal: [], tokenUsage: [],
  keyStatus: { configured: true, sessionOnly: false },
});

const month = ledgerToday().slice(0, 7), stamp = `${ledgerToday()}T08:00:00+08:00`;
const entry = (id: string, date: string, title: string, category: string, amountCents: number, extra: Record<string, unknown> = {}) => LedgerEntrySchema.parse({
  id, kind: "expense", date, month: date.slice(0, 7), title, category, amountCents, personalCents: amountCents,
  cashflows: [{ accountId: "wechat", deltaCents: -amountCents }], version: 1, createdAt: stamp, updatedAt: stamp, ...extra,
});
const ledgerData = {
  revision: 1, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [],
  entries: [
    entry("l1", ledgerToday(), "合成午饭", "餐饮", 1450),
    entry("l2", `${month}-01`, "合成生活费", "生活费", 200000, { kind: "income", personalCents: 0, incomeCents: 200000, cashflows: [{ accountId: "wechat", deltaCents: 200000 }] }),
    entry("l3", `${month}-02`, "合成聚餐", "餐饮", 9000, { personalCents: 3000 }),
  ],
};
const ledgerSnapshot = LedgerSnapshotSchema.parse({ ...ledgerData, summary: summarizeLedger(ledgerData, { month }) });

const readOnly = async () => ({ ok: false as const, error: { code: "INTERNAL" as const, message: "合成布局预览不写入正式数据。请在桌面应用操作。", retryable: false } });
const ok = <T,>(data: T) => async () => ({ ok: true as const, data });
const quiet = () => () => {};
const update = { currentVersion: "0.0.0-preview", status: "unavailable" as const, latestVersion: null, releaseNotes: "", progressPercent: null, checkedAt: null, message: "布局预览不检查更新" };
const space = SpaceSnapshotSchema.parse({
  policy: {}, backupDirectory: 'C:\\Synthetic\\Documents\\终极日历\\备份', databaseBytes: 180 * 1048576, reusableBytes: 4 * 1048576, cacheBytes: 3 * 1048576,
  backupBytes: 600 * 1048576, managedBackupBytes: 400 * 1048576, unmanagedBackupBytes: 200 * 1048576,
  backupCount: 6, removableBackupCount: 2, removableBackupBytes: 100 * 1048576,
  attachments: { totalBytes: 160 * 1048576, eligibleBytes: 100 * 1048576, protectedBytes: 60 * 1048576,
    reclaimableBytes: 80 * 1048576, remainingBytes: 80 * 1048576, selectedAttachments: 4, protectedAttachments: 2, overBudgetBytes: 0 },
  lastRunAt: null, lastResult: null, warnings: [],
});

// Every bridge method is listed so the type checker flags new ones; reads return synthetic data and writes refuse.
const api: DesktopAPI = {
  resourcePick: ok([sampleResource]), resourceRegister: readOnly, resourceDrop: ok([sampleResource]), resourceOpen: readOnly, resourceRelocate: ok(null),
  resourceStatus: async request => ({ ok: true, data: request.resources.map(resource => ({ id: resource.id, status: 'available' as const })) }),
  localSourceEvidence: async request => ({ ok: true, data: { sourceId: request.sourceId, match: 'legacy-id', sources: [snapshot.sources[0]!] } }),
  snapshot: ok(snapshot), onChanged: quiet, onNavigate: quiet,
  spaceSnapshot: ok(space), spaceConfigure: readOnly, spaceCleanup: readOnly,
  mutate: readOnly, undo: readOnly, importSource: readOnly, analyzeSource: readOnly, command: readOnly, importCourses: readOnly,
  saveSettings: readOnly, setApiKey: readOnly, retryApiKey: readOnly, backup: readOnly, restore: readOnly,
  selectImage: ok(null),
  accountSnapshot: ok(emptyAccountState()), refreshAccount: ok(emptyAccountState()), onAccountChanged: quiet,
  updateSnapshot: ok(update), checkForUpdates: ok(update), downloadUpdate: readOnly, installUpdate: readOnly, onUpdateChanged: quiet,
  ledgerSnapshot: ok(ledgerSnapshot), ledgerMutate: readOnly, ledgerUndo: readOnly, ledgerExport: readOnly,
  wechatCaptureSnapshot: readOnly, wechatCaptureConfigure: readOnly, wechatCaptureConnect: readOnly, wechatCaptureGroups: readOnly, wechatCaptureMessages: readOnly,
  wechatCaptureBatches: readOnly, wechatCaptureAction: readOnly, wechatCaptureChunks: readOnly, wechatCaptureCleanup: readOnly, onWechatCaptureChanged: quiet,
  captureSnapshot: readOnly, captureConfigure: readOnly, captureConnect: readOnly, captureGroups: readOnly, captureMessages: readOnly,
  captureBatches: readOnly, captureAction: readOnly, captureChunks: readOnly, captureCleanup: readOnly, onCaptureChanged: quiet,
};

// ?page=today|calendar|inbox|ledger|me opens that page after the first render.
const labels: Record<string, string> = { today: "今天", calendar: "日历", inbox: "待判断", ledger: "账单", me: "我的" };
const page = labels[new URLSearchParams(location.search).get("page") ?? ""];
createRoot(document.getElementById("root")!).render(
  <>
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, textAlign: "center", fontSize: 9, color: "#966b24", background: "#fff3d8", zIndex: 100, pointerEvents: "none" }}>
      合成测试数据 · 布局检查专用 · 不连接正式存储
    </div>
    <App api={api} />
  </>,
);
const timer = setInterval(() => {
  const buttons = [...document.querySelectorAll<HTMLElement>('nav[aria-label="主导航"] button')];
  if (!buttons.length) return;
  clearInterval(timer);
  buttons.find(button => page && button.textContent?.startsWith(page))?.click();
}, 100);
