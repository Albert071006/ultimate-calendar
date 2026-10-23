/** Isolated developer layout harness. Never imported by production main/build. All records are synthetic. */
import { createRoot } from "react-dom/client";
import { App } from "../src/renderer/App";
import {
  SnapshotSchema,
  BlockSchema,
  TaskSchema,
  CandidateSchema,
  type DesktopAPI,
} from "../src/shared/contracts";
import { todayDate } from "../src/renderer/calendar-layout";
import "../src/renderer/styles.css";
const date = todayDate(),
  metadata = {
    version: 1,
    createdAt: `${date}T08:00:00+08:00`,
    updatedAt: `${date}T08:00:00+08:00`,
  };
const snapshot = SnapshotSchema.parse({
  schemaVersion: 1,
  sources: [],
  candidates: [
    CandidateSchema.parse({
      ...metadata,
      id: "synthetic-candidate",
      title: "合成示例：报名讲座",
      action: "填写报名表",
      sourceIds: ["synthetic-source"],
      deadline: { date, time: null },
      uncertainties: ["仅用于布局检查"],
    }),
  ],
  tasks: [
    TaskSchema.parse({
      ...metadata,
      id: "synthetic-task",
      title: "合成示例：完成报告",
      deadline: { date, time: "18:00" },
    }),
  ],
  blocks: [
    BlockSchema.parse({
      ...metadata,
      id: "synthetic-block",
      title: "合成示例：专注学习",
      kind: "work",
      start: `${date}T09:00:00+08:00`,
      end: `${date}T10:30:00+08:00`,
    }),
  ],
  goals: [],
  courses: [],
  courseExceptions: [],
  preferences: [],
  feedback: [],
  settings: {},
  journal: [],
  tokenUsage: [],
  keyStatus: { configured: false, sessionOnly: false },
});
const error = async () => ({
  ok: false as const,
  error: {
    code: "INTERNAL" as const,
    message: "合成布局预览不写入正式数据。请在桌面应用操作。",
    retryable: false,
  },
});
const api: DesktopAPI = {
  accountSnapshot: error,
  refreshAccount: error,
  onAccountChanged: () => () => {},
  snapshot: async () => ({ ok: true, data: snapshot }),
  onChanged: () => () => {},
  onNavigate: () => () => {},
  selectImage: async () => ({ ok: true, data: null }),
  mutate: error,
  undo: error,
  importSource: error,
  analyzeSource: error,
  command: error,
  importCourses: error,
  saveSettings: error,
  setApiKey: error,
  backup: error,
  restore: error,
};
createRoot(document.getElementById("root")!).render(
  <>
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        textAlign: "center",
        fontSize: 9,
        color: "#966b24",
        background: "#fff3d8",
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      合成测试数据 · 布局检查专用 · 不连接正式存储
    </div>
    <App api={api} />
  </>,
);
