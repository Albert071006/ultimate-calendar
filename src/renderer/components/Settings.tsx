import { useRef, useState } from "react";
import {
  SettingsSchema,
  type RestoreResult,
  type Snapshot,
} from "../../shared/contracts";
import { displayInstant } from "../calendar-layout";
import type { PlannerUI } from "../hooks/usePlanner";
import { useAccount } from "../hooks/useAccount";
import { AccountPanel, AccountResourceStatus, OfficialPrices } from "./AccountPanel";
import type { AppUpdates } from '../hooks/useAppUpdates';
import { SoftwareUpdate } from './SoftwareUpdate';
import { SpaceManagement } from './SpaceManagement';
import './Settings.css';
export type SettingsSection = "ai" | "term" | "reminders" | "data" | "update";

/**
 * Settings share one form so saving never drops a field: with a section chosen, the others stay in the form
 * but hidden. Without one (tests, older callers) every group shows.
 */
export function Settings({
  snapshot,
  ui,
  courses,
  updates,
  section,
  onSection,
}: {
  snapshot: Snapshot;
  ui: PlannerUI;
  courses: () => void;
  updates?: AppUpdates;
  section?: SettingsSection;
  onSection?: (section: SettingsSection) => void;
}) {
  const hide = (key: SettingsSection) => section !== undefined && section !== key;
  const keyRef = useRef<HTMLInputElement>(null),
    s = snapshot.settings;
  const keyStatus = snapshot.keyStatus;
  const account = useAccount(ui.host);
  const [model, setModel] = useState(s.model),
    [manualModel, setManualModel] = useState(false),
    [pricingMode, setPricingMode] = useState(s.pricingMode),
    [pricingCurrency, setPricingCurrency] = useState(s.pricingCurrency),
    [modelNotice, setModelNotice] = useState('');
  const models = account.state?.models.data ?? [];
  const modelInfo = models.find(item => item.id === model);
  const quote = account.state?.prices.data?.entries.find(item => item.model === model && item.currency === pricingCurrency);
  function changeModel(next: string) {
    if (next !== model && pricingMode === 'manual') {
      setPricingMode('auto');
      setModelNotice('已切换模型，手动单价已停用。需要覆盖官方价格时，请为新模型重新填写。');
    }
    setModel(next);
  }
  const [error, setError] = useState(""),
    [restore, setRestore] = useState<Extract<
      RestoreResult,
      { status: "preview" }
    > | null>(null),
    [preference, setPreference] = useState(""),
    [editing, setEditing] = useState<string | null>(null);
  async function save(form: HTMLFormElement) {
    const data = new FormData(form),
      get = (key: string) => String(data.get(key) ?? ""),
      numbers = (key: string) =>
        get(key)
          .split(/[,，]/)
          .map((v) => v.trim())
          .filter(Boolean)
          .map(Number);
    try {
      const periodMap = get("periodMap")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [p, startTime, endTime] = line.split(/[,，\s]+/);
          return { period: Number(p), startTime, endTime };
        });
      const settings = SettingsSchema.parse({
        ...s,
        campus: get("campus"),
        locationContext: get("locationContext"),
        model: get("model"),
        showPending: data.has("showPending"),
        closeToTray: data.has("closeToTray"),
        autoLaunch: data.has("autoLaunch"),
        remindersEnabled: data.has("remindersEnabled"),
        courseReminders: data.has("courseReminders"),
        taskLeadMinutes: numbers("taskLeadMinutes"),
        blockLeadMinutes: numbers("blockLeadMinutes"),
        courseLeadMinutes: numbers("courseLeadMinutes"),
        dateOnlyReminderTime: get("dateOnlyReminderTime"),
        termStart: get("termStart") || null,
        termWeeks: Number(get("termWeeks")),
        periodMap,
        pricingMode,
        pricingCurrency,
        tokenPrices: pricingMode === 'manual'
          ? {
              model: get("model"),
              inputPerMillion: Number(get("inputPrice")),
              cachedInputPerMillion: get("cachedPrice")
                ? Number(get("cachedPrice"))
                : null,
              outputPerMillion: Number(get("outputPrice")),
              currency: get("currency"),
              updatedAt: new Date(Date.now() + 8 * 3600000)
                .toISOString()
                .replace("Z", "+08:00"),
            }
          : null,
      });
      await ui.run(
        () => ui.host!.saveSettings({ settings }),
        () => ui.setNotice("设置已保存"),
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "请校对设置");
    }
  }
  async function saveKey(clear = false) {
    if (!ui.host) return;
    const input = keyRef.current;
    if (!clear && !input?.value.trim()) return;
    const pending = ui.host.setApiKey({ key: clear ? null : input!.value });
    if (input) input.value = "";
    await ui.run(
      () => pending,
      (status) => ui.setNotice(clear ? "密钥已清除" : status.sessionOnly
        ? "系统加密暂不可用，密钥仅在本次运行有效"
        : "密钥已安全保存，重启和更新后会自动读取，无需重复填写"),
    );
  }
  async function retryKey() {
    const status = await ui.run(() => ui.host!.retryApiKey());
    if (status) ui.setNotice(status.configured
      ? "已恢复读取保存的密钥，无需重新填写"
      : status.loadError ? "暂时仍无法读取，原密钥文件已保留，请稍后重试" : "没有找到已保存的密钥");
  }
  async function restoreBackup() {
    const r = await ui.run(() => ui.host!.restore({ confirmed: false }));
    if (r?.status === "preview") setRestore(r);
  }
  async function savePreference() {
    if (!preference.trim()) return;
    const record = snapshot.preferences.find((p) => p.id === editing);
    const result = await ui.mutate([
      record
        ? {
            type: "update",
            entity: "preference",
            id: record.id,
            expectedVersion: record.version,
            values: { text: preference },
          }
        : {
            type: "create",
            entity: "preference",
            values: { text: preference, enabled: true },
          },
    ]);
    if (result) {
      setPreference("");
      setEditing(null);
    }
  }
  return (
    <div className="settings-page">
      {updates && !hide("update") && <div className="settings-card settings-group"><SoftwareUpdate updates={updates} plannerBusy={ui.busy} /></div>}
      <form onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}
        onInvalidCapture={e => {
          // Keep native validation usable when a required field is inside a collapsed group or another section.
          const owner = (e.target as HTMLElement).closest<HTMLElement>('[data-section]')?.dataset.section as SettingsSection | undefined;
          if (owner && hide(owner)) onSection?.(owner);
          let group = (e.target as HTMLElement).closest('details');
          while (group) { group.open = true; group = group.parentElement?.closest('details') ?? null; }
        }}>
        <section className="settings-card settings-group" aria-labelledby="settings-ai-title" data-section="ai" hidden={hide("ai")}>
          <div className="settings-group-heading"><h3 id="settings-ai-title">AI 与费用</h3><span>DeepSeek</span></div>
          <div className="settings-ai-overview">
            <div className="settings-account">{keyStatus.loadError ? <div className="warning" role="status">
          <p>{{ unavailable: '系统加密服务暂不可用', read: '暂时无法读取密钥文件', decrypt: '暂时无法解密已保存的密钥', invalid: '已保存的密钥内容无法识别' }[keyStatus.loadError]}。程序会自动重试，也可以点击下方按钮重新读取，无需先覆盖原密钥。</p>
          <button type="button" onClick={() => void retryKey()} disabled={ui.busy}>重新读取已保存密钥</button>
        </div> : <AccountPanel state={account.state} error={account.error} refreshing={account.refreshing}
          refresh={account.refresh} configured={keyStatus.configured} />}</div>
            <div className="settings-model">
              <h4>当前模型与连接</h4>
              <input name="model" type="hidden" value={model} />
          <div className="form-grid">
            <label>
              可用模型
              <select value={model} onChange={e => { setManualModel(false); changeModel(e.target.value); }}>
                {!modelInfo && <option value={model}>{model || '尚未填写'} · 当前填写，未在列表中发现</option>}
                {models.map(item => <option key={item.id} value={item.id}>{item.name ? `${item.name} · ${item.id}` : item.id}</option>)}
              </select>
            </label>
          </div>
          <button type="button" onClick={() => setManualModel(value => !value)}>{manualModel ? '收起手动填写' : '手动填写模型名称'}</button>
          {manualModel && <label>模型名称<input required value={model} onChange={e => changeModel(e.target.value)} maxLength={100} /></label>}
          {modelInfo && <p className="hint">上下文：{modelInfo.contextWindow?.toLocaleString() ?? '接口未提供'} · 最大输出：{modelInfo.maxOutputTokens?.toLocaleString() ?? '接口未提供'}
            {modelInfo.inputModalities?.length ? ` · 输入：${modelInfo.inputModalities.map(value => ({ text: '文本', image: '图片' }[value] ?? value)).join('、')}` : ''}</p>}
          <AccountResourceStatus resource={account.state?.models} label="模型列表" staleAfter={6 * 3_600_000} />
          <p className="fine-print">模型列表每 6 小时更新。新模型不会自动替换你的选择；修改后请保存设置。</p>
          {modelNotice && <p className="warning">{modelNotice}</p>}
              <p className={keyStatus.configured ? "success" : keyStatus.loadError ? "warning" : "hint"}>
          {keyStatus.configured
            ? keyStatus.sessionOnly
              ? "密钥已配置 · 仅本次运行"
              : "密钥已保存 · 系统加密保护 · 无需重复填写"
            : keyStatus.loadError ? "已保存的密钥暂未载入 · 原文件已保留"
            : "尚未配置密钥 · 本地手动功能可正常使用"}
        </p>
              <details className="settings-disclosure settings-key">
                <summary><strong>API Key</strong><span className="settings-summary">{keyStatus.configured ? '已配置 · 展开更换' : '展开配置或恢复'}</span></summary>
                <div className="settings-disclosure-body"><label>
          API Key
          <input
            ref={keyRef}
            type="password"
            autoComplete="off"
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); if (!ui.busy) void saveKey(); }
            }}
            placeholder={keyStatus.configured ? keyStatus.sessionOnly ? "本次运行已配置；填写可更换密钥" : "已保存，无需重复输入；填写可更换密钥" : keyStatus.loadError ? "可先重新读取已保存密钥" : "输入后立即交由桌面安全服务保存"}
          />
        </label>
        <div className="toolbar">
          <button type="button"
            className="primary"
            onClick={() => void saveKey()}
            disabled={ui.busy}
          >
            保存密钥
          </button>
          <button type="button"
            onClick={() => void saveKey(true)}
            disabled={ui.busy || (!keyStatus.configured && !keyStatus.loadError)}
          >
            清除密钥
          </button>
        </div>
        <p className="fine-print">
          密钥不进入数据快照、备份或操作历史。加密不可用时仅本次运行有效。
        </p></div>
              </details>
            </div>
          </div>
          <details className="settings-disclosure settings-pricing">
            <summary><strong>模型单价与调用费用</strong><span className="settings-summary">{{ auto: '同步官方价格', manual: '手动单价', off: '仅记录 token' }[pricingMode]} · {pricingCurrency}</span></summary>
            <div className="settings-disclosure-body"><div className="form-grid">
            <label>费率来源<select value={pricingMode} onChange={e => setPricingMode(e.target.value as typeof pricingMode)}>
              <option value="auto">自动同步官方价格（推荐）</option>
              <option value="manual">手动设置当前模型单价</option>
              <option value="off">仅记录 token 用量</option>
            </select></label>
            <label>估算币种<select value={pricingCurrency} onChange={e => setPricingCurrency(e.target.value as typeof pricingCurrency)}>
              <option>CNY</option><option>USD</option>
            </select></label>
          </div>
          <OfficialPrices quote={quote} state={account.state} model={model} currency={pricingCurrency} />
          {pricingMode === 'manual' && <div className="form-grid" key={model}>
            <label>
              输入 / 百万 token
              <input
                name="inputPrice"
                type="number"
                step="any"
                min={0}
                required
                defaultValue={model === (s.tokenPrices?.model ?? s.model) ? s.tokenPrices?.inputPerMillion ?? '' : ''}
              />
            </label>
            <label>
              缓存输入 / 百万 token（可空）
              <input
                name="cachedPrice"
                type="number"
                step="any"
                min={0}
                defaultValue={model === (s.tokenPrices?.model ?? s.model) ? s.tokenPrices?.cachedInputPerMillion ?? '' : ''}
              />
            </label>
            <label>
              输出 / 百万 token
              <input
                name="outputPrice"
                type="number"
                step="any"
                min={0}
                required
                defaultValue={model === (s.tokenPrices?.model ?? s.model) ? s.tokenPrices?.outputPerMillion ?? '' : ''}
              />
            </label>
            <label>
              手动单价币种
              <select
                name="currency"
                defaultValue={s.tokenPrices?.currency ?? "CNY"}
              >
                <option>CNY</option>
                <option>USD</option>
              </select>
            </label>
          </div>}
          <p className="hint">
            {pricingMode === 'manual' ? `手动单价仅绑定 ${model}，由你维护；缓存单价留空时按输入单价估算。` : pricingMode === 'off' ? '新的请求只记录 token 数，不计算费用。' : '官方价格未取得或已过期时，只记录 token 用量。'}
          </p></div>
          </details>
          <details className="settings-disclosure api-usage">
        <summary>
          <strong>API 使用记录</strong>
          <span className="usage-total">
            {snapshot.tokenUsage.length} 条记录 · 共{" "}
            {snapshot.tokenUsage
              .reduce((sum, r) => sum + r.totalTokens, 0)
              .toLocaleString()}{" "}
            tokens
          </span>
        </summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>用途 / 模型</th>
                <th>输入 / 缓存 / 输出</th>
                <th>估算</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.tokenUsage.toReversed().map((r) => (
                <tr key={r.id}>
                  <td>{displayInstant(r.createdAt)}</td>
                  <td>
                    {
                      { command: "指令", source: "消息", courses: "课表" }[
                        r.purpose
                      ]
                    }{" "}
                    · {r.model}
                  </td>
                  <td>
                    {r.inputTokens} / {r.cachedInputTokens} / {r.outputTokens}
                  </td>
                  <td>
                    {r.estimatedCost === null
                      ? "未估算"
                      : `${r.estimatedCost.toFixed(6)}${r.estimatedCostMax != null && r.estimatedCostMax !== r.estimatedCost ? ` – ${r.estimatedCostMax.toFixed(6)}` : ''} ${r.currency}`}
                    {r.pricingSource && <small className="usage-price-source">{r.pricingSource === 'official' ? '官方费率估算' : '手动费率估算'}{r.pricingUpdatedAt ? ` · 费率 ${displayInstant(r.pricingUpdatedAt)}` : ''}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
          <details className="settings-disclosure settings-preferences">
            <summary><strong>手动偏好与反馈</strong><span className="settings-summary">{snapshot.preferences.filter(p => p.enabled).length} 条启用 · {snapshot.feedback.length} 条反馈</span></summary>
            <div className="settings-disclosure-body"><p className="hint">只记录你明确填写的偏好，不会静默隐藏候选事项。</p>
        {snapshot.preferences.map((p) => (
          <div className="preference-row" key={p.id}>
            <label className="check">
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={() =>
                  void ui.mutate([
                    {
                      type: "update",
                      entity: "preference",
                      id: p.id,
                      expectedVersion: p.version,
                      values: { enabled: !p.enabled },
                    },
                  ])
                }
              />
              {p.text}
            </label>
            <button type="button"
              onClick={() => {
                setEditing(p.id);
                setPreference(p.text);
              }}
            >
              编辑
            </button>
            <button type="button"
              onClick={() =>
                void ui.mutate([
                  {
                    type: "delete",
                    entity: "preference",
                    id: p.id,
                    expectedVersion: p.version,
                  },
                ])
              }
            >
              删除
            </button>
          </div>
        ))}
        <label>
          {editing ? "修改偏好" : "新增偏好"}
          <textarea
            value={preference}
            onChange={(e) => setPreference(e.target.value)}
            rows={2}
          />
        </label>
        <div className="toolbar">
          <button type="button"
            onClick={() => void savePreference()}
            disabled={ui.busy || !preference.trim()}
          >
            {editing ? "保存修改" : "添加偏好"}
          </button>
          {editing && (
            <button type="button"
              onClick={() => {
                setEditing(null);
                setPreference("");
              }}
            >
              取消编辑
            </button>
          )}
        </div>
        <details>
          <summary>明确反馈记录（{snapshot.feedback.length}）</summary>
          {snapshot.feedback.toReversed().map((f) => (
            <p key={f.id}>
              {displayInstant(f.createdAt)} ·{" "}
              {snapshot.candidates.find((c) => c.id === f.candidateId)?.title ??
                "已删除事项"}{" "}
              ·{" "}
              {
                {
                  accepted: "接受",
                  ignored: "忽略",
                  snoozed: "稍后决定",
                  restored: "恢复",
                }[f.decision]
              }
              {f.reason && ` · ${f.reason}`}
            </p>
          ))}
        </details></div>
          </details>
        </section>
        <details className="settings-card settings-group settings-campus" data-section="term" hidden={hide("term")} open={section === "term" || undefined}>
          <summary><strong>日历与校园</strong><span className="settings-summary">{s.campus || '尚未设置学校'} · {s.termStart ? '学期始于 ' + s.termStart : '尚未设置学期'} · {s.termWeeks} 周 · {s.periodMap.length} 节</span></summary>
          <div className="settings-disclosure-body">
            <div className="settings-campus-grid">
              <section><h4>个人校园背景</h4><label>学校与校区<input name="campus" maxLength={200} defaultValue={s.campus} placeholder="例如：学校名称、所在校区" /></label>
          <label>地点理解补充<textarea name="locationContext" maxLength={2000} rows={3} defaultValue={s.locationContext} placeholder="可填写常用校园地点简称的背景" /></label>
          <p className="hint">用于理解消息中的校园地点；保留原文名称，不补造楼号或房间。留空时不假定你的学校。修改后用于新的分析，不会自动付费重读已有消息。</p></section>
              <section><h4>教学周与节次</h4><div className="form-grid">
            <label>
              第一教学周周一
              <input
                name="termStart"
                type="date"
                defaultValue={s.termStart ?? ""}
              />
            </label>
            <label>
              教学周数
              <input
                name="termWeeks"
                type="number"
                min={1}
                max={100}
                defaultValue={s.termWeeks}
              />
            </label>
          </div>
          <label>
            节次时间（每行：节次,开始,结束）
            <textarea
              name="periodMap"
              rows={5}
              defaultValue={s.periodMap
                .map((p) => `${p.period},${p.startTime},${p.endTime}`)
                .join("\n")}
              placeholder="1,08:00,08:45"
            />
          </label>
          <button type="button" onClick={courses}>
            打开课程与导入校对
          </button></section>
            </div>
            <div className="settings-calendar-options"><label className="check">
            <input
              name="showPending"
              type="checkbox"
              defaultChecked={s.showPending}
            />
            默认显示待判断截止层
          </label><span className="hint">时区：Asia/Shanghai（北京时间）</span></div>
          </div>
        </details>
        <section className="settings-card settings-group" aria-labelledby="settings-reminders-title" data-section="reminders" hidden={hide("reminders")}>
          <h3 id="settings-reminders-title">提醒与启动</h3>
          <div className="check-grid">
            {[
              ["closeToTray", "关闭窗口后留在托盘"],
              ["autoLaunch", "开机启动"],
              ["remindersEnabled", "启用全局提醒"],
              ["courseReminders", "启用课程提醒"],
            ].map(([key, label]) => (
              <label className="check" key={key}>
                <input
                  type="checkbox"
                  name={key}
                  defaultChecked={Boolean(s[key as keyof typeof s])}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="hint">
            托盘可明确退出。提醒在应用运行时工作；恢复运行会汇总漏过的提醒。
          </p>

          <details className="settings-disclosure settings-reminders">
            <summary><strong>提前提醒与提醒时刻</strong><span className="settings-summary">仅日期事项 {s.dateOnlyReminderTime} 提醒</span></summary>
            <div className="settings-disclosure-body"><div className="form-grid">
            <label>
              任务截止提前分钟
              <input
                name="taskLeadMinutes"
                defaultValue={s.taskLeadMinutes.join(",")}
              />
            </label>
            <label>
              时段提前分钟
              <input
                name="blockLeadMinutes"
                defaultValue={s.blockLeadMinutes.join(",")}
              />
            </label>
            <label>
              课程提前分钟
              <input
                name="courseLeadMinutes"
                defaultValue={s.courseLeadMinutes.join(",")}
              />
            </label>
            <label>
              仅日期截止提醒时刻
              <input
                name="dateOnlyReminderTime"
                type="time"
                required
                defaultValue={s.dateOnlyReminderTime}
              />
            </label>
          </div>
          <p className="fine-print">
            多次提醒用逗号分隔。留空表示不设置提前提醒，每项仍可独立调整。
          </p></div>
          </details>
        </section>
        <section className="settings-card settings-group" aria-labelledby="settings-data-title" data-section="data" hidden={hide("data")}>
          <h3 id="settings-data-title">数据与历史</h3>
          <SpaceManagement host={ui.host} active={!hide("data")} plannerBusy={ui.busy} />
          <details className="settings-disclosure settings-backup">
            <summary><strong>数据备份与恢复</strong><span className="settings-summary">导出本地备份或恢复已有数据</span></summary>
            <div className="settings-disclosure-body"><p>本地备份包含日历、账单和现存的 QQ 原文、附件。大备份按批校验和恢复，不再受 512 MB 限制；请留出备份、恢复暂存和安全备份所需的磁盘空间。</p>
        <p>导出包含原始文字、截图和操作记录，密钥不包含在内。</p>
        <div className="toolbar">
          <button type="button"
            onClick={() =>
              void ui.run(
                () => ui.host!.backup(),
                (r) => ui.setNotice(`备份已导出：${r.path}（包含来源资料）`),
              )
            }
            disabled={ui.busy}
          >
            导出本地备份
          </button>
          <button type="button" onClick={() => void restoreBackup()} disabled={ui.busy}>
            选择备份恢复
          </button>
        </div>
        {restore && (
          <div className="warning">
            <h4>尚未恢复 · 核对备份</h4>
            <p>{restore.message}</p>
            <p>
              {Object.entries(restore.counts)
                .map(([kind, count]) => `${kind} ${count}`)
                .join(" · ")}
            </p>
            <p>恢复前会另存当前数据。</p>
            <button type="button"
              className="danger"
              disabled={ui.busy}
              onClick={() =>
                void ui.run(
                  () =>
                    ui.host!.restore({
                      confirmed: true,
                      confirmationToken: restore.confirmationToken,
                    }),
                  (r) => {
                    if (r.status === "restored") {
                      setRestore(null);
                      ui.setNotice(
                        `${r.message}；恢复前备份：${r.safetyBackupPath}`,
                      );
                    }
                  },
                )
              }
            >
              确认恢复
            </button>
            <button type="button" onClick={() => setRestore(null)}>取消</button>
          </div>
        )}</div>
          </details>
          <details className="settings-disclosure api-usage operation-history">
        <summary><strong>持久操作历史</strong><span className="usage-total">最近 {snapshot.journal.length} 条 · 按时间倒序</span></summary>
        {snapshot.journal.length ? (
          snapshot.journal.map((j) => (
            <div className="history-row" key={j.id}>
              <div>
                <strong>{j.displayTitle ?? (j.changes.map(c => `${{ create: '新增', update: '修改', delete: '移除' }[c.action]}「${c.title || c.entity}」`).join('、') || j.message)}</strong>
                <small>
                  {displayInstant(j.createdAt)} ·{" "}
                  {j.origin === "ai" ? "AI 指令" : "手动操作"}
                  {j.undoneAt ? " · 已撤销" : ""}
                </small>
                {!!j.displayDetails?.length && <details className="history-change-details"><summary>查看具体变更</summary><ul>{j.displayDetails.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
              </div>
              <button type="button"
                disabled={ui.busy || !j.undoable || !!j.undoneAt}
                title={`撤销：${j.displayTitle ?? j.message}`}
                onClick={() => void ui.undo(j.id)}
              >
                撤销此操作
              </button>
            </div>
          ))
        ) : (
          <p className="hint">还没有操作记录。</p>
        )}
      </details>
        </section>
        {error && <p className="error prewrap" role="alert">{error}</p>}
        <div className="sticky-save" hidden={section === "update" || section === "data"}><span className="hint">切换分区或收起不会丢失修改</span><button type="submit" className="primary" disabled={ui.busy}>保存全部设置</button></div>
      </form>
    </div>
  );
}
