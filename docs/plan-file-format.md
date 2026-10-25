# 计划 JSON 文件标准 v1

外部 agent 可以直接生成 `*.calendar-plan.json` 文件。用户在 Windows 终极日历点击 **导入计划 → 选择 JSON 文件 → 核对预览 → 确认导入**，一次导入目标、任务、学习时段及资料关联。应用直接解析文件，不调用 AI，不需要逐个操作任务编辑器。

- [完整可导入示例](examples/study-plan.calendar-plan.json)
- [JSON Schema](schemas/calendar-plan-v1.schema.json)（供编辑器和 agent 校验）
- [规划规则与高级接口](agent-planning-guide.md)

这与“导入消息”“课表导入”“恢复备份”是不同入口。当前文件入口在 Windows 桌面；云模式写入现有共用资料服务，手机随后看到已保存的结果。文件生成成功时应报告“文件已生成，尚未导入”。

## 给外部 agent 的指令

> 请按《计划 JSON 文件标准 v1》生成一份 UTF-8 的 `.calendar-plan.json` 文件。交付文件本身，不要只给 Markdown 或内部 mutate 请求。使用 `format:"ultimate-calendar-plan"`、`version:1`、`timezone:"Asia/Shanghai"`；为本次计划生成稳定唯一的 planId，每条目标、任务、时段也要有固定 id。用 goalRef、taskRef、resourceRefs 建立文件内关联，不要猜测日历数据库 ID。学习安排使用 kind:"work"，明确开始和结束时间；真实截止要求才写 deadline。网页资料放 resources，任务可继承目标资料。读取不到当前日历时请注明“未核对现有安排”，交给应用导入预览核对。输出只含数据，不包含 API Key、Cookie、确认令牌、脚本或数据库命令。失败重试必须使用原文件，不要更换 planId 再创建一遍。

## 最小任务文件

```json
{
  "format": "ultimate-calendar-plan",
  "version": 1,
  "timezone": "Asia/Shanghai",
  "planId": "reading-2026-11-02-unique-01",
  "title": "阅读计划",
  "tasks": [
    {
      "id": "read-01",
      "title": "阅读第一章并整理三条笔记",
      "description": "完成标准：能用自己的话解释三个概念。"
    }
  ]
}
```

文件可以只包含任务。未安排时段的任务会进入待安排；不能把截止时间当作执行时间。

## 顶层字段

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `format` | 是 | 固定 `ultimate-calendar-plan` |
| `version` | 是 | 数字 `1`，是文件格式版本，不是计划修订号 |
| `timezone` | 是 | 固定 `Asia/Shanghai` |
| `planId` | 是 | 本次计划的唯一固定编号，1–80 位字母、数字、点、下划线、短横线，首位为字母或数字 |
| `title` | 是 | 计划名称，1–500 字符 |
| `goals` | 否 | 目标数组，默认 `[]` |
| `tasks` | 否 | 任务数组，默认 `[]` |
| `blocks` | 否 | 执行时段或活动数组，默认 `[]` |
| `resources` | 否 | 资料引用数组，默认 `[]` |

采用 UTF-8 JSON（可有 BOM），最多 1 MiB。目标、任务、时段合计 1–500 条；资料最多 500 条。每组内 `id` 必须唯一，条目编号格式与 `planId` 相同。文件中的编号只是文件内关联键，由应用映射到真实记录 ID。未知字段会被拒绝；不要写入 `$schema`、`revision`、`operationId`、`confirmed` 或任意执行指令。需要 JSON Schema 校验时在编辑器配置关联 Schema 文件。

## 目标 `goals[]`

必填 `id`、`title`。可选字段如下：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `description` | `""` | 完成标准、说明，最多 100,000 字符 |
| `priority` | `"medium"` | `low` / `medium` / `high` |
| `targetDate` | `null` | `YYYY-MM-DD`，目标日期 |
| `status` | `"active"` | `active` / `completed` / `paused` |
| `color` | `null` | 建议省略，由应用分配；可选值见 Schema |
| `resourceRefs` | `[]` | 引用顶层资料的 `id`，最多 50 项 |

## 任务 `tasks[]`

必填 `id`、`title`。可选 `description`、`status`（`open` / `done`，默认 `open`）、`deadline`、`goalRef`、`goalId`、`courseId`、`reminders`、`resourceRefs`。

- `goalRef:"goal-01"` 关联本文件 `goals` 中的目标，应用自动取得真实 ID。
- `goalId` 仅用于关联**已读取并核实**的现有目标 ID；不能与 `goalRef` 同时填写。
- `courseId` 仅用于关联已读取并核实的现有课程 ID，默认 `null`。
- `deadline` 默认 `null`；有真实 DDL 时写 `{"date":"2026-11-04","time":"21:00"}`。仅知道日期时写 `time:null`，不要擅自补 23:59。
- 没有读取到真实 ID 时，使用文件内关联或留空，不能用课程名称冒充 ID。

## 时段 `blocks[]`

必填 `id`、`title`、`start`、`end`。可选 `kind`、`taskRef`、`taskId`、`location`、`reminders`、`resourceRefs`。

```json
{
  "id": "reading-session",
  "taskRef": "read-01",
  "title": "第一章阅读与笔记",
  "kind": "work",
  "start": "2026-11-02T19:10:00+08:00",
  "end": "2026-11-02T19:55:00+08:00"
}
```

- `kind` 默认 `work`（学习／执行）；固定活动使用 `event`。文件标准中两者都必须有明确 `end`，且结束晚于开始。
- 时间必须是有效的上海时间 ISO 字符串，带秒和 `+08:00`；不接受 `Z`、缺时区的时间、`24:00` 或不存在的日期。可含三位毫秒。
- `taskRef` 关联本文件任务；`taskId` 关联已核实的现有任务，两者互斥。都不填时创建独立时段。
- 一个任务可以有多个时段，分别使用不同 `id`。不要为每次学习重新创建同一任务。
- v1 不接受 RRULE 或循环表达式；有限重复安排请展开成各自的时段。它们是独立时段，没有重复系列的批量修改语义。
- `location` 默认 `""`，最多 2,000 字符；不要包含电脑文件路径。

## 资料与提醒

网页资料放在顶层 `resources`：

```json
{
  "id": "course-notes",
  "kind": "web",
  "name": "课程讲义",
  "url": "https://example.com/course"
}
```

在目标、任务或时段中写 `"resourceRefs":["course-notes"]`。网页仅支持 `http` / `https`，不接受账号密码、脚本或 `file://`。关联不会抓取网页，也不会把正文发给 AI。

电脑文件／文件夹须先通过应用的“关联资料”登记，再把返回的完整 `{id,name,kind,deviceId,deviceName}` 放入 `resources`，用返回的 `id` 引用。导入会核实引用属于本机已登记资料。v1 不接受原始 `path`，也不会扫描、上传或自动打开电脑文件。文件移动后在原电脑重新定位。公共资料挂在目标上即可，关联任务及其时段会继承显示。

任务和时段的 `reminders` 默认继承全局设置。明确要求准时提醒时可写：

```json
{"enabled":true,"leadMinutes":[0],"dateOnlyTime":null}
```

`leadMinutes:null` 继承全局；`[15]` 提前 15 分钟；`[]` 不产生提醒。任务 DDL 提醒和时段开始提醒相互独立，不要重复制造同一提醒。

## 预览、保存与失败续导

1. 选择文件时只校验和读取当前资料，不创建任务，不调用 AI。核对目标／任务关联、资料引用、字段、截止日期和时间。
2. 预览列出新增、已有、需要处理的条目；时间冲突单独列出。应用按当前课程教学周、调课／停课、已有活动与文件内时段检查重叠。边界相接不算重叠；DDL 不占用时间。
3. 默认遇到时间冲突需要核对后勾选继续；未勾选不会导入冲突计划。已删除、已修改的导入记录、缺失引用等阻止续导，不会覆盖或重新创建。
4. 确认后按目标 → 任务 → 时段保存并自动处理关联。整个文件由多个事务组成；中断会保留已成功部分，并显示剩余内容。不是失败后自动回滚整个计划。
5. 同一文件再次导入使用原计划和条目编号，已确认保存的部分不会重复创建。失败后保留原文件，在同一资料连接重新选择它，核对后继续剩余项；不要换 `planId` 重试。
6. 导入后文件保持不变。修改同一 `planId` 的内容会被拒绝；需要调整已安排内容时直接编辑现有任务／时段。只有确实独立的新计划才使用新的 `planId`，并只包含需要新建的条目。
7. 去重依据计划编号、条目编号和导入回执，不会仅凭同名合并手工创建的任务。需要关联现有目标或任务时使用真实 `goalId` / `taskId`。
8. 预览之后资料发生变化、云端身份／资料代际改变或操作结果尚未确定时会暂停。重新核对提示与原文件；不能把旧计划自动写到另一份资料。

导入进度保存在当前应用的私有资料目录；不要清理它来“修复”重复导入。不要改写本机旧数据库来替代云端导入。云模式需要连接当前共用服务；断网不会冒称已导入。普通文件导入无需 API Key、软件发布或重新安装。

JSON Schema 用于静态字段校验；引用是否存在、编号唯一、真实日期、时间先后和当前课表冲突仍由应用最终检查。
