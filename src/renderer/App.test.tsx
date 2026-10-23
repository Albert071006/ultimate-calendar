// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  SnapshotSchema,
  CandidateSchema,
  BlockSchema,
  CourseSchema,
  SourceSchema,
  MutationRequestSchema,
  type DesktopAPI,
  type MutationRequestInput,
  type ApiResult,
  type CommandResult,
} from "../shared/contracts";
import { App } from "./App";
import { todayDate } from './calendar-layout';
import { minutePosition } from './calendar-timeline';
afterEach(cleanup);
function fixture() {
  const snapshot = SnapshotSchema.parse({
    schemaVersion: 1,
    sources: [],
    candidates: [],
    tasks: [],
    blocks: [],
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
  const mutate = vi.fn(async (_request: MutationRequestInput) => ({
    ok: true as const,
    data: {
      status: "applied" as const,
      message: "已接受",
      changes: [],
      conflicts: [],
      transactionId: "tx",
    },
  }));
  const api = {
    snapshot: vi.fn(async () => ({
      ok: true,
      data: structuredClone(snapshot),
    })),
    onChanged: () => () => {},
    onNavigate: () => () => {},
    mutate,
    command: vi.fn(),
    undo: vi.fn(),
    selectImage: vi.fn(),
    importCourses: vi.fn(),
    setApiKey: vi.fn(),
  } as unknown as DesktopAPI;
  return { snapshot, api, mutate };
}
describe("desktop workspace interaction", () => {
  it('focuses the current time again when returning to the calendar from another page', async () => {
    const { api } = fixture();
    const date = todayDate();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(`${date}T15:20:00+08:00`));
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    try {
      const ui = render(<App api={api} />);
      await screen.findByRole('button', { name: '课表' });
      expect((ui.container.querySelector('.time-scroll') as HTMLDivElement).scrollTop).toBe(minutePosition(920) - 200);
      (ui.container.querySelector('.time-scroll') as HTMLDivElement).scrollTop = 140;
      fireEvent.click(screen.getByRole('button', { name: /^目标$/ }));
      expect(ui.container.querySelector('.time-scroll')).toBeNull();
      clock.mockReturnValue(Date.parse(`${date}T16:35:00+08:00`));
      fireEvent.click(screen.getByRole('button', { name: /^日历$/ }));
      expect(screen.getByRole('note', { name: '当前时间 16:35（北京时间）' })).toBeTruthy();
      expect((ui.container.querySelector('.time-scroll') as HTMLDivElement).scrollTop).toBe(minutePosition(995) - 200);
    } finally {
      clock.mockRestore(); height.mockRestore();
    }
  });

  it('shows deleted provenance as text and keeps only surviving source links enabled', async () => {
    const { snapshot, api } = fixture();
    snapshot.sources.push(SourceSchema.parse({ id: 'live', version: 1, createdAt: '2026-10-22T09:00:00+08:00', updatedAt: '2026-10-22T09:00:00+08:00', kind: 'text', text: '合成原文', label: '合成来源', importedAt: '2026-10-22T09:00:00+08:00' }));
    snapshot.candidates.push(CandidateSchema.parse({ id: 'notice', version: 1, createdAt: '2026-10-22T09:00:00+08:00', updatedAt: '2026-10-22T09:00:00+08:00', title: '合成来源删除', sourceIds: ['gone', 'live'] }));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /待判断/ }));
    expect(await screen.findByText('原文已删除')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看来源 · 原文' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看来源 · 合成来源' }));
    expect(await screen.findByText('合成原文')).toBeTruthy();
  });
  it("stacks new and existing course editors above their manager and restores focus on Escape", async () => {
    const { api, snapshot } = fixture();
    snapshot.courses.push(
      CourseSchema.parse({
        id: "course-1",
        version: 1,
        createdAt: "2026-10-22T09:00:00+08:00",
        updatedAt: "2026-10-22T09:00:00+08:00",
        title: "合成数学",
        weekday: 1,
        startTime: "08:00",
        endTime: "09:00",
        firstWeek: 1,
        lastWeek: 16,
        termStart: "2026-09-07",
      }),
    );
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "课表" }));
    const manager = screen.getByRole("dialog", { name: "课程与导入校对" });
    const create = within(manager).getByRole("button", { name: "＋ 新建课程" });
    create.focus();
    fireEvent.click(create);
    const child = screen.getByRole("dialog", { name: "新建课程" });
    expect(screen.getAllByRole("dialog").at(-1)).toBe(child);
    expect(child.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "新建课程" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "课程与导入校对" })).toBe(
      manager,
    );
    expect(document.activeElement).toBe(create);
    fireEvent.click(within(manager).getByRole("button", { name: /合成数学/ }));
    expect(screen.getAllByRole("dialog").at(-1)).toBe(
      screen.getByRole("dialog", { name: "编辑课程" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "编辑课程" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "课程与导入校对" })).toBe(
      manager,
    );
  });
  it("closes the course manager when navigating from its original screenshot to key settings", async () => {
    const { api, snapshot } = fixture();
    snapshot.sources.push(
      SourceSchema.parse({
        id: "course-source",
        version: 1,
        createdAt: "2026-10-22T09:00:00+08:00",
        updatedAt: "2026-10-22T09:00:00+08:00",
        importedAt: "2026-10-22T09:00:00+08:00",
        kind: "image",
        imageDataUrl: "data:image/png;base64,aGVsbG8=",
        purpose: "courses",
      }),
    );
    vi.mocked(api.importCourses).mockResolvedValue({
      ok: true,
      data: {
        sourceId: "course-source",
        courses: [],
        drafts: [],
        uncertainties: [],
        message: "请校对",
      },
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "课表" }));
    fireEvent.click(screen.getByRole("button", { name: "导入 CSV / XLSX" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "查看保留的课表原图" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "配置 DeepSeek 密钥" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "设置", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByLabelText("API Key")).toBeTruthy();
  });
  it("keeps Chinese composition Enter in the draft and sends only after a normal Enter", async () => {
    const { api } = fixture();
    vi.mocked(api.command).mockResolvedValue({
      ok: true,
      data: { reply: "查询完成", items: [], mutationResult: null },
    });
    render(<App api={api} />);
    const input = await screen.findByLabelText("自然语言指令");
    fireEvent.change(input, { target: { value: "明天下午学习" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(api.command).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("明天下午学习");
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    await waitFor(() => expect(api.command).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.command).mock.calls[0]![0].text).toBe("明天下午学习");
  });
  it("accepts a candidate through the API and refreshes the visible snapshot", async () => {
    const { snapshot, api, mutate } = fixture();
    snapshot.candidates.push(
      CandidateSchema.parse({
        id: "c1",
        version: 1,
        createdAt: "2026-10-22T09:00:00+08:00",
        updatedAt: "2026-10-22T09:00:00+08:00",
        title: "报告",
        action: "提交报告",
        sourceIds: ["s1"],
      }),
    );
    mutate.mockImplementation(async () => {
      snapshot.candidates[0]!.status = "accepted";
      return {
        ok: true,
        data: {
          status: "applied",
          message: "已接受",
          changes: [],
          conflicts: [],
          transactionId: "tx",
        },
      };
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /待判断/ }));
    fireEvent.click(await screen.findByRole("button", { name: "接受事项" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0].mutations[0]).toMatchObject({
      type: "acceptCandidate",
      id: "c1",
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "接受事项" })).toBeNull(),
    );
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });
  it("requires a real confirm click for a command preview even when model reply claims success", async () => {
    const { api, mutate } = fixture();
    const proposedRequest = MutationRequestSchema.parse({
      operationId: "command-1",
      origin: "ai" as const,
      confirmed: false,
      mutations: [
        {
          type: "create" as const,
          entity: "task" as const,
          values: { title: "新任务" },
        },
      ],
    });
    vi.mocked(api.command).mockResolvedValue({
      ok: true,
      data: {
        reply: "已经修改成功",
        items: [],
        mutationResult: {
          status: "preview",
          message: "请核对",
          changes: [
            {
              entity: "task",
              id: "t1",
              action: "create",
              beforeVersion: null,
              afterVersion: 1,
              title: "新任务",
            },
          ],
          conflicts: [],
          confirmationToken: "token",
          expiresAt: "2026-10-22T20:00:00+08:00",
          proposedRequest,
          details: [{ entity: "task", id: "t1", before: null, after: null }],
        },
      },
    });
    render(<App api={api} />);
    fireEvent.change(await screen.findByLabelText("自然语言指令"), {
      target: { value: "创建两个任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    expect(
      within(await screen.findByRole("dialog", { name: "更改预览" })).getByText(
        "尚未执行 · 请确认更改",
      ),
    ).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      origin: "manual",
      confirmed: true,
      confirmationToken: "token",
      operationId: "command-1",
    });
  });
  it("shows the sent message and clears the input immediately without losing a newer draft or duplicating requests", async () => {
    const { api } = fixture();
    let finish!: (result: ApiResult<CommandResult>) => void;
    vi.mocked(api.command).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(api.command).mockResolvedValueOnce({ ok: true, data: { reply: "后续已收到", items: [], mutationResult: null } });
    const { container } = render(<App api={api} />);
    const input = await screen.findByLabelText("自然语言指令");
    fireEvent.click(screen.getByRole("button", { name: "展开对话" }));
    const conversation = container.querySelector(".conversation") as HTMLDivElement;
    Object.defineProperty(conversation, "scrollHeight", { value: 800 });
    fireEvent.change(input, { target: { value: "把办借阅证标题中的去示例服务中心去掉" } });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));

    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("把办借阅证标题中的去示例服务中心去掉")).toBeTruthy();
    expect(container.querySelectorAll(".message.user")).toHaveLength(1);
    expect(container.querySelector('.message.assistant[aria-busy="true"]')?.textContent).toContain("正在处理…");
    expect(api.command).toHaveBeenCalledTimes(1);
    expect(conversation.scrollTop).toBe(800);

    conversation.scrollTop = 123;
    fireEvent.change(input, { target: { value: "下一条草稿" } });
    expect(conversation.scrollTop).toBe(123);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    expect(api.command).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, data: { reply: "标题已修改", items: [], mutationResult: null } }));
    expect(screen.getByText("标题已修改")).toBeTruthy();
    expect(container.querySelector('.message.assistant[aria-busy="true"]')).toBeNull();
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect((input as HTMLTextAreaElement).value).toBe("下一条草稿");
    expect(conversation.scrollTop).toBe(800);

    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    await screen.findByText("后续已收到");
    expect(vi.mocked(api.command).mock.calls[1]![0].history).toEqual([
      { role: "user", text: "把办借阅证标题中的去示例服务中心去掉" },
      { role: "assistant", text: "标题已修改" },
    ]);
  });
  it("retries a failed command in its original message using the same operation and preserving a new draft", async () => {
    const { api } = fixture();
    vi.mocked(api.command).mockResolvedValueOnce({
      ok: false,
      error: { code: "NETWORK", message: "连接失败，请重试", retryable: true },
    });
    let finish!: (result: ApiResult<CommandResult>) => void;
    vi.mocked(api.command).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { container } = render(<App api={api} />);
    const input = await screen.findByLabelText("自然语言指令");
    fireEvent.change(input, { target: { value: "明天下午安排学习" } });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    expect(await screen.findByText("连接失败，请重试")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(container.querySelectorAll(".message.user")).toHaveLength(1);
    expect(screen.getByText("明天下午安排学习")).toBeTruthy();
    fireEvent.change(input, { target: { value: "另一个正在写的想法" } });
    fireEvent.click(screen.getByRole("button", { name: "重试这条指令" }));
    expect(api.command).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.command).mock.calls[1]![0]).toEqual(vi.mocked(api.command).mock.calls[0]![0]);
    expect(container.querySelectorAll(".message.user")).toHaveLength(1);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.command).toHaveBeenCalledTimes(2);
    await act(async () => finish({ ok: true, data: { reply: "已收到原指令", items: [], mutationResult: null } }));
    expect(screen.getByText("已收到原指令")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试这条指令" })).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("另一个正在写的想法");
    expect(container.querySelectorAll(".message.user")).toHaveLength(1);
  });
  it("does not carry an unsuccessful instruction into a different command's history", async () => {
    const { api } = fixture();
    vi.mocked(api.command).mockResolvedValueOnce({
      ok: false, error: { code: "NETWORK", message: "合成网络失败", retryable: true },
    }).mockResolvedValueOnce({ ok: true, data: { reply: "第二条已收到", items: [], mutationResult: null } });
    render(<App api={api} />);
    const input = await screen.findByLabelText("自然语言指令");
    fireEvent.change(input, { target: { value: "尚未完成的修改请求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    await screen.findByRole("button", { name: "重试这条指令" });
    fireEvent.change(input, { target: { value: "查明天的安排" } });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    await screen.findByText("第二条已收到");
    expect(vi.mocked(api.command).mock.calls[1]![0].history).toEqual([]);
    expect(vi.mocked(api.command).mock.calls[1]![0].operationId).not.toBe(vi.mocked(api.command).mock.calls[0]![0].operationId);
    expect(screen.getByRole("button", { name: "重试这条指令" })).toBeTruthy();
  });
  it("forwards the original expense facts when a short reply clarifies bookkeeping after navigation and refresh", async () => {
    const { api } = fixture();
    const clarification = '“vpn14 支付宝”是要记账，还是安排日历事项？';
    const clarificationState = { domain: 'calendar', phase: 'clarification' } as const;
    const savedState = { domain: 'ledger', phase: 'saved' } as const;
    vi.mocked(api.command)
      .mockResolvedValueOnce({ ok: true, data: { reply: clarification, items: [], mutationResult: null, conversationState: clarificationState } })
      .mockResolvedValueOnce({ ok: true, data: { reply: '已收到这笔 VPN 消费', items: [], mutationResult: null, conversationState: savedState } })
      .mockResolvedValueOnce({ ok: true, data: { reply: '不客气', items: [], mutationResult: null } });
    api.ledgerSnapshot = vi.fn<DesktopAPI['ledgerSnapshot']>(async () => ({
      ok: false, error: { code: 'STORAGE', message: '合成账本暂未载入', retryable: true },
    }));
    render(<App api={api} />);
    fireEvent.change(await screen.findByLabelText('自然语言指令'), { target: { value: 'vpn14 支付宝' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
    await screen.findByText(clarification);
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.command).mock.calls[0]![0]).toMatchObject({ text: 'vpn14 支付宝', history: [] });

    fireEvent.click(screen.getByRole('button', { name: '收起对话' }));
    fireEvent.click(screen.getByRole('button', { name: '账单' }));
    await screen.findByRole('heading', { level: 1, name: '我的账单' });
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '记账' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
    await screen.findByText('已收到这笔 VPN 消费');
    expect(vi.mocked(api.command).mock.calls[1]![0]).toMatchObject({
      text: '记账', domain: 'ledger',
      history: [
        { role: 'user', text: 'vpn14 支付宝' },
        { role: 'assistant', text: clarification, outcome: clarificationState },
      ],
    });
    expect(screen.getByText('vpn14 支付宝')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '谢谢' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
    await screen.findByText('不客气');
    expect(vi.mocked(api.command).mock.calls[2]![0].history).toEqual([
      { role: 'user', text: 'vpn14 支付宝' },
      { role: 'assistant', text: clarification, outcome: clarificationState },
      { role: 'user', text: '记账' },
      { role: 'assistant', text: '已收到这笔 VPN 消费', outcome: savedState },
    ]);
  });
  it("retains an answered clarification while excluding an intervening failed instruction from a new request", async () => {
    const { api } = fixture();
    const clarification = '这笔 VPN 14 元、支付宝的记录是实际消费吗？';
    const clarificationState = { domain: 'ledger', phase: 'clarification' } as const;
    vi.mocked(api.command)
      .mockResolvedValueOnce({ ok: true, data: { reply: clarification, items: [], mutationResult: null, conversationState: clarificationState } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '合成网络失败', retryable: true } })
      .mockResolvedValueOnce({ ok: true, data: { reply: '查询完成', items: [], mutationResult: null } });
    render(<App api={api} />);
    fireEvent.change(await screen.findByLabelText('自然语言指令'), { target: { value: 'vpn14 支付宝' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
    await screen.findByText(clarification);
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '记账' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
    await screen.findByRole('button', { name: '重试这条指令' });
    fireEvent.change(screen.getByLabelText('自然语言指令'), { target: { value: '先查今天的安排' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));
    await screen.findByText('查询完成');
    expect(vi.mocked(api.command).mock.calls[2]![0].history).toEqual([
      { role: 'user', text: 'vpn14 支付宝' },
      { role: 'assistant', text: clarification, outcome: clarificationState },
    ]);
    expect(vi.mocked(api.command).mock.calls[2]![0].operationId)
      .not.toBe(vi.mocked(api.command).mock.calls[1]![0].operationId);
    expect(screen.getByRole('button', { name: '重试这条指令' })).toBeTruthy();
  });
  it("submits a date-only task with independently editable reminder settings", async () => {
    const { api, mutate } = fixture();
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 新建任务" }));
    const dialog = within(screen.getByRole("dialog", { name: "新建任务" }));
    fireEvent.change(dialog.getByLabelText("名称"), {
      target: { value: "只给日期的报告" },
    });
    fireEvent.change(dialog.getByLabelText("截止日期"), {
      target: { value: "2026-11-01" },
    });
    fireEvent.change(dialog.getByLabelText(/提前分钟/), {
      target: { value: "60,15" },
    });
    fireEvent.change(dialog.getByLabelText("仅日期事项的提醒时刻"), {
      target: { value: "10:30" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0].mutations[0]).toMatchObject({
      entity: "task",
      values: {
        title: "只给日期的报告",
        deadline: { date: "2026-11-01", time: null },
        reminders: {
          enabled: true,
          leadMinutes: [60, 15],
          dateOnlyTime: "10:30",
        },
      },
    });
  });
  it("keeps incomplete course cells editable and writes only after correction and confirmation", async () => {
    const { api, mutate, snapshot } = fixture();
    snapshot.settings.termStart = "2026-09-07";
    vi.mocked(api.importCourses).mockResolvedValue({
      ok: true,
      data: {
        sourceId: null,
        courses: [],
        drafts: [
          {
            row: 2,
            cells: ["合成课程", "1", "第1节", "", "1", "16", "单", "教室"],
            errors: ["时间不明确"],
          },
        ],
        uncertainties: [],
        message: "请校对",
      },
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "课表" }));
    fireEvent.click(screen.getByRole("button", { name: "导入 CSV / XLSX" }));
    const start = await screen.findByLabelText("第2行开始");
    expect((start as HTMLInputElement).value).toBe("第1节");
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(start, { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("第2行结束"), {
      target: { value: "09:00" },
    });
    fireEvent.change(screen.getByLabelText("第2行指定周"), {
      target: { value: "1,3,7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认校对，保存课程" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0].mutations[0]).toMatchObject({
      type: "create",
      entity: "course",
      values: {
        weeks: [1, 3, 7],
        startTime: "08:00",
        endTime: "09:00",
        parity: "odd",
      },
    });
  });
  it("moves a dragged block into the drop time while preserving its duration in an editable form", async () => {
    const { api, snapshot, mutate } = fixture();
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    snapshot.blocks.push(
      BlockSchema.parse({
        id: "b1",
        version: 1,
        createdAt: `${date}T08:00:00+08:00`,
        updatedAt: `${date}T08:00:00+08:00`,
        title: "专注",
        kind: "work",
        start: `${date}T09:00:00+08:00`,
        end: `${date}T10:30:00+08:00`,
      }),
    );
    const { container } = render(<App api={api} />);
    await screen.findByLabelText("自然语言指令");
    const day = container.querySelector(".today-column")!;
    const event = new Event("drop", { bubbles: true });
    Object.defineProperties(event, {
      clientY: { value: (14 * 60 + 25) / 60 * 96 },
      dataTransfer: {
        value: { getData: () => JSON.stringify({ kind: "block", id: "b1" }) },
      },
    });
    fireEvent(day, event);
    const dialog = within(
      await screen.findByRole("dialog", { name: "编辑时段" }),
    );
    expect((dialog.getByLabelText("开始") as HTMLInputElement).value).toBe(
      `${date}T14:25`,
    );
    expect((dialog.getByLabelText(/结束（/) as HTMLInputElement).value).toBe(
      `${date}T15:55`,
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});
