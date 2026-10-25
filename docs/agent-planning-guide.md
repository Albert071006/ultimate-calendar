# 终极日历 Agent 规划与导入规范

适用对象：替用户制定学习、工作或生活计划，并将计划交给终极日历执行的外部智能体（agent）。核对日期：2026-10-26，依据当前本机 0.4.7 源码，涵盖 Windows 云端资料模式、本机独立模式和已配对网页。相同版本号可能包含不同的本机修复；本文不代表 GitHub 正式安装包或任意服务器均已更新。

**外部 agent 现在可以直接交付计划 JSON 文件。** 首选 [计划 JSON 文件标准 v1](plan-file-format.md)：生成 [可导入示例](examples/study-plan.calendar-plan.json) 所示格式，用户在 Windows 的“导入计划”入口选择文件、预览并确认，一次保存目标、任务、学习时段和资料关联，无需软件 AI 再解析。应用核对当前云端课表，并保存去重与续导回执。下文内部 `mutate`／RPC 示例仅供已有接口能力的高级客户端使用，不能当计划文件导入；仍不支持 ICS 或计划导入 CLI。

权威定义：[计划文件与示例](../src/shared/plan-import.ts)、[导入与续导服务](../src/plan-import/service.ts)、[实体与 mutation](../src/shared/contracts.ts)、[桌面内部接口](../src/electron/preload.ts)、[云端协议](../src/shared/remote.ts)、[RPC 方法](../src/server/protocol.ts)、[资料引用](../src/shared/resources.ts)、[规划服务](../src/domain/planner.ts)。云端接入细节见 [后端接口](backend-api.md)，Windows 模式见 [Windows 云端资料说明](windows-cloud-mode.md)。

## 可以直接交给其他 agent 的指令

> 请按《终极日历 Agent 规划与导入规范》为我制定并落实计划。
> 先确认当前北京时间、资料模式和真实可用的执行入口。云端模式以当前已配对服务的资料为准，不读旧本机采集库来代替正式计划。读取本次计划所需的已有任务、目标、课表和安排，将目标拆成有明确产出的小任务，区分真实 DDL、固定活动和可调整的执行时段，避开已有课程与活动。
> 未指定时长时默认 30 分钟；明确指定的时长、非整点时间必须保留。相对日期以我发出指令的日期为准，不能使用当前浏览的日历日期。
> 请优先输出符合《计划 JSON 文件标准 v1》的 `.calendar-plan.json` 文件，使用固定 planId 和条目 id，通过 goalRef、taskRef、resourceRefs 关联。生成文件后说明“文件已生成，尚未导入”，由我在“导入计划”选择并确认。失败续导使用原文件，不要更换编号创建一遍。如果另外获授权直接操作接口，则保存对象 ID、version 和回执，按实际预览完成确认流程。
> 已有部分计划时，先核对原目标、任务真实 ID、完成状态与已有时段，只生成增量内容。原任务补时段使用 taskId，同一目标下新增任务使用 goalId，不重新输出已有目标、任务和时段。新的补录或下周安排使用新的 planId；同批失败重试保留原文件。上下文文件只供阅读，不可当导入计划；专用“导出给外部智能体”按钮尚未实现。
> 网页资料使用 resources 关联；电脑文件先由 Windows 本机入口登记，再关联返回的引用，不把本机绝对路径写入云端描述。目标／课程的公共资料可由关联任务和时段继承显示，无需到处复制。
> 没完成的内容保留为原任务，后续调整其安排；不要把过期当完成，也不要重复生成一套任务。最后简洁报告已写入、未写入和待处理的部分。

## 先确认资料与执行入口

| 当前环境 | 正式计划从哪里读写 | 外部 agent 的执行方式 |
| --- | --- | --- |
| Windows 显示“当前使用云端共用资料” | 当前已连接服务，与手机共用 | 生成标准文件，使用“导入计划”；高级客户端可经受信任页面调用 `window.planner` |
| 已配对网页／获授权的服务客户端 | 对应 HTTPS 服务的当前资料实例 | 现有网页界面，或下文的已配对同源 RPC |
| 明确使用本机独立模式 | 该应用当前 profile 的本机资料 | 现有日历界面／该窗口的 `window.planner` |
| 只能聊天、生成文件或看源码 | 尚未取得正式资料写入能力 | 交付标准计划 JSON，注明尚未导入；用户无需再逐个录入 |

云模式下，本机 QQ 采集服务只负责采集、原文、附件等本机能力，旧本机日历库不能当作手机和电脑当前显示的正式资料。不要通过加启动参数、换 profile、另开本机编辑器或直接操作数据库来“导入计划”。已有正常连接时无需重配对或填写 API Key；接口不可达不等于资料为空。

Windows 现在使用单一托盘入口。菜单里的“打开终极日历”可回到主界面，“刷新共用资料”和“核对云端操作”用于云端刷新与结果核对。退出日历且保留采集时，托盘仍可打开日历；采集仍运行不表示云端日历窗口或提醒仍运行。

## 规划时需要的信息

- 本次目标、完成标准、计划起止日期，以及用户明确给出的 DDL、固定时间和提醒要求。
- 最新的相关任务与目标、计划区间内的课程和日历活动；课程要计入教学周、单双周、指定周与课程例外。
- 用户给出的可用时段、每天投入上限和休息要求。缺少一般偏好时可以提出并注明假设；缺少决定日期、对象或重大冲突的信息时才追问。

没有读取到日历时，写明“未核对现有课表和安排”，不能宣称已避开冲突。只读取完成本次规划所需的资料，不需要读取 API Key、账本或无关群消息。

## 在已有计划上补录或安排下一周

完整规则见 [计划文件标准：已有计划的增量补录与续排](plan-file-format.md#已有计划的增量补录与续排)，包括上下文内容、忙碌区间、当前能力与后续导出要求；可参考 [四个时段的补录示例](examples/supplement-existing-tasks.calendar-plan.json)。

- **上下文交接**：取得所选目标、其关联任务和时段的真实 ID、版本、状态、DDL、提醒及资料引用，同时提供规划区间展开后的课表和其他忙碌时间。`.calendar-context.json` 是供 agent 阅读的约定文件，当前没有专用导出按钮或导入入口。
- **增量保存**：只输出本次缺少的内容。原任务补时段仅生成 `blocks`，使用真实 `taskId`；新任务加入已有目标时使用真实 `goalId`。以原有 1 个目标、6 个任务、2 个时段为例，补录文件只新增 4 个时段，不重建完整计划。
- **独立批次与重试**：下周安排或另一次补录是新批次，使用新的 `planId`；同一批中断续导保持原文件和编号。标题相同不代表同一条记录，不能靠换编号去重。
- **旧安排修改**：移动、替换或删除已有时段不属于追加；当前 v1 文件不支持，需通过应用编辑器或获授权更新接口。未完成任务沿用原记录，已完成任务不应被重新当作待办排入。
- **时效核对**：上下文应附导出时间与规划范围，导入前尽可能重读完成状态和安排；无法重读则明确标注。现有导入器会检查引用存在、时间冲突和预览后的变动，但不会自动用导出版本校验旧任务状态。带原 ID／预期版本的更新协议和专用导出入口属于后续开发要求。

日常续排只交接所选目标及必要的忙碌区间。如利用用户指定的备份取得编号，在本地提取相关内容即可，不执行恢复、不把整库备份作为规划材料。不要在当前 v1 导入文件中加入上下文、版本前置条件或修改指令。

## 计划对象怎么选

| 对象 | 用途 | 是否占用日历时间 |
| --- | --- | --- |
| `goal` 目标 | 一个阶段要达到的结果，例如完成一轮复习 | 否；`targetDate` 是目标日期 |
| `task` 任务 | 可以独立判断是否做完的事情，有说明、真实 DDL，可关联目标 | 否；DDL 只显示截止标记 |
| `block`，`kind:"work"` | 为任务安排的执行时段，例如 19:10–19:55 做练习 | 是；必须提供开始和结束 |
| `block`，`kind:"event"` | 固定活动或定时提醒，例如线上讲座、某时提醒办事 | 是；结束未知时按 30 分钟处理 |
| `course` 课程 | 学校课表中的课程及教学周安排 | 是；不能拿课程导入冒充普通计划导入 |

每个任务写清“做什么、做到什么算完成、需要哪些材料、下一步是什么”。`description` 可写步骤清单、验收标准、进度和续做位置；这些步骤仍是文本，不是可勾选的子任务或自动依赖关系。文件、文件夹和网页已有独立的 `resources` 关联能力，见下文；云端描述不要包含电脑绝对路径。

一个大任务可以关联多个执行时段。不同日期做不同内容时，应拆成对应任务／时段；不要为了省事套成内容完全相同的重复活动。完成一个时段不等于完成整个任务，系统不会自动替 agent 判断验收结果或推进后续任务。

## 日期、时长与提醒

1. 时区固定 `Asia/Shanghai`。日期用 `YYYY-MM-DD`，时间用 24 小时制 `HH:mm`，完整时间用 `2030-04-15T18:00:00+08:00`。接口不接受直接传入 `Z` 时间，需先正确转换。
2. “明天、后天、下周”先按消息发出时的北京时间展开为具体日期，并写进计划。对话跨日、补录或日期歧义要保留原指令的时间语境。本文示例日期只用于演示，执行时必须换成用户实际日期。
3. 精确到分钟，不吸附半小时或整点。未指定时长默认 30 分钟；明确 45、90 分钟等时长照原要求计算，不能截成半小时。
4. “周五前交作业”是 DDL，不能自动占用周五某个时段。“周五 18:00 提醒我交作业”是定时提醒，应创建对应日历活动。两者同时存在则分别保存。
5. 学习日期、计划复习日期不是硬 DDL。没有真实截止要求就用 `deadline:null`，不要为了让事项显示出来伪造 DDL。
6. 提醒结构为 `{"enabled":true,"leadMinutes":[0],"dateOnlyTime":null}`；`[0]` 为准时，`[15]` 为提前 15 分钟，`null` 继承全局设置，`[]` 不产生提醒。没有明确要求时沿用用户现有设置。
7. Task 的 DDL 提醒与 Block 的开始提醒是独立的。明确“某时提醒我”应把 `[0]` 设置在活动上；没有真实 DDL 时不要再创建一份同时间的截止提醒。
8. `deadline:{"date":"2030-04-19","time":null}` 表示日期明确、具体时刻未指定；不要擅自补成 23:59。仅日期的提醒使用 `dateOnlyTime` 或全局时刻，不要靠提前分钟数组表达精确 DDL。

规划时按实际区间检查重叠，也留出用户要求的通勤、休息时间。边界相接的两个区间不算系统时间冲突，但仍需判断实际是否来得及。不能为了排下新计划，擅自移动课程、固定活动或真实 DDL。

`snapshot.blocks` 不等于所有忙碌时间：还要按课程的教学周、`weeks`／`parity` 和 `courseExceptions` 展开课表。`cancelled:true` 的重复活动不占时；未接受的候选不算正式占时，但可能需要用户先决定；DDL 不占时。可参考 [buildCalendar](../src/domain/calendar.ts) 的统一展开规则。断网或读取失败时保留“未核对”状态，不能用空数组冒充成功读取。

## 交给用户和执行 agent 的计划模板

首选交付标准计划 JSON，并附简洁说明；以下文字表格只用于额外说明和高级接口交接，不替代可导入文件。文件 v1 没有修订号字段，同一 planId 的文件保持不变；后续编辑已有日历记录。

```text
计划名称：……
计划批次 ID：本批唯一标识；同批失败重试保留，新增补录／下周安排另建编号
说明修订号（仅文字交接）：1
生成时间／时区：……／Asia/Shanghai
资料模式／来源：云端共用资料或本机独立资料；已核对时间：……
云端 identity：dataInstanceId / generation（仅在本地回执记录，不含凭据）
计划区间：YYYY-MM-DD 至 YYYY-MM-DD
目标与完成标准：……
已核对的已有安排：……；未核对部分：……
假设与待确认项：……，没有则写“无”
写入状态：尚未导入／部分已导入／已导入

本地条目编号 | 动作 | 类型 | 标题 | 开始 | 结束 | 真实DDL | 提醒 | 关联目标/任务
P01 | 新建 | 执行时段 | …… | …… | …… | 无 | 继承 | ……

任务说明：步骤、材料、验收标准、当前进度、下次继续的位置
导入回执：执行后填入，不预先编造
```

计划文件中的 `planId` 和条目 `id` 用于关联与导入去重，由应用映射到真实记录 ID；文字交接中的修订号不是文件字段。这些字段也不能额外塞进下面的原始 mutation 请求。所有写入 schema 均拒绝未知字段。

## 当前可用的执行方式

### 通过应用界面

批量新建计划使用主导航“导入计划”，选择符合 [文件标准](plan-file-format.md) 的 JSON。先检查新增、已有和冲突预览，再确认；失败保留已保存部分，重选原文件继续。应用自动关联目标与任务，以及任务与时段，不调用 AI。已有记录的调整仍使用编辑器或下面的更新接口。

可以使用“新建任务”、日历创建／安排时段、重复安排及现有对话框。对话输入用具体日期和时间，例如“2030 年 4 月 15 日 18:00 提醒我提交报名表，持续 30 分钟，准时提醒”。只有用户已经要求执行时才提交；仅要求制定方案时不要发送会写入的命令。

对话框调用应用所配置的 AI，会产生相应调用费用。有可靠的结构化写入能力时，无需把外部 agent 已整理好的每条计划再次交给 AI 解析。

界面里的“导入消息”先产生消息来源／待判断内容；课表导入只处理课程；“恢复备份”会恢复数据，不是合并计划。不要用这三个入口冒充通用计划导入。

### 通过 Windows 应用内部接口

只有在工具确实提供了对**本机应用受信任页面**的操作能力时，才能调用该页面中的 `window.planner`。它是 Electron preload 暴露的内部接口，不是任意网页、Node 进程或远程 agent 都能访问的服务。没有该能力就走界面或交付待执行清单，不能编造 HTTP 地址、CLI，或擅自开启生产资料的远程调试端口。

可用调用包括：

```javascript
const snapshotResult = await window.planner.snapshot();
// 先检查 snapshotResult.ok；成功时 snapshotResult.data 为最新快照。
const result = await window.planner.mutate(request);
// 先检查 result.ok；成功时还要区分 result.data.status。
```

同一个 `window.planner` 在云端模式读写的是正式云端资料，在本机独立模式才读写本机资料；无需自行改为另一份数据库。云端 Windows 已在主进程管理传输回执和待核对写入，不要绕过它另开未经授权的 HTTP 客户端。仅有 Node／文件读写权限不等于能访问这个 preload 接口；网页端也不保证存在 `window.planner` 全局对象。

请求形状：

```json
{
  "operationId": "example-plan-r1-batch-01",
  "origin": "ai",
  "confirmed": false,
  "mutations": [
    {
      "type": "createScheduledTask",
      "values": {"title": "提醒提交报名表", "deadline": null},
      "start": "2030-04-15T18:00:00+08:00",
      "end": null,
      "reminders": {"enabled": true, "leadMinutes": [0], "dateOnlyTime": null}
    }
  ]
}
```

这项操作原子创建一个任务和一个关联 `event`，结束时间落为 18:30。`createScheduledTask` **不能创建 `work` 类型**，也不能用来给已有任务再建一个同名任务。

[完整请求示例](examples/agent-plan.request.json) 包含定时提醒、带网页资料的 DDL 任务和每周重复活动。它使用虚构数据；不要直接提交示例日期。以下执行规则同样适用于该文件。

### 任务、目标与执行时段的关联

- 新建目标使用 `{"type":"create","entity":"goal","values":{"title":"完成第一轮复习"}}`。可选字段为 `description`、`priority:low|medium|high`、`targetDate`、`status:active|completed|paused`、`color`。颜色只能使用程序预设值，不确定时省略。
- 新建任务使用 `{"type":"create","entity":"task","values":{"title":"完成阅读练习","deadline":null}}`。可选 `description`、`status:open|done`、`goalId`、`courseId`、`candidateId`、`reminders`。普通计划不要伪造候选通知关联。
- 关联新目标／新任务时，先保存它，从返回的 `changes` 和新快照取得真实 ID，再发下一批。不能在同一批里用临时 ID、标题或猜出的 UUID 关联尚未存在的对象。
- 给已有任务安排学习时间，使用普通 `create block`；这里的占位 ID 必须替换为最新快照中的真实任务 ID：

```json
{
  "type": "create",
  "entity": "block",
  "values": {
    "title": "阅读练习第一组",
    "start": "2030-04-15T19:10:00+08:00",
    "end": "2030-04-15T19:55:00+08:00",
    "kind": "work",
    "taskId": "REPLACE_WITH_EXISTING_TASK_ID",
    "location": ""
  }
}
```

普通 Block 请求必须给 `end`；`work` 不能为 null。Block 的提醒省略时继承全局设置，不会自动复制关联任务的提醒。`taskId:null` 为独立时段。`scheduleTaskEvent` 专用于已经接受的通知候选，不能作为普通任务排程接口。

### 通过已配对的云端 RPC

只有工具已获准访问用户当前资料服务，并具有合法会话时才用此方式。服务地址沿用现有已配对 origin，不能猜测公网域名、局域网端口或复制桌面加密凭据。已有服务支持此协议，不等于任意网页或远程 agent 都有访问权限；没有通用 Bearer Token 登录接口。

1. 在服务自己的 origin 读取 `GET /api/v1/session`。必须为 `paired:true`，取得当前 `identity`、`device.id` 和 `csrfToken`；会话凭据只留在客户端内存／既有凭据机制，不写进计划文件。
2. `POST /api/v1/rpc/snapshot`，JSON 包含新的 `requestId` 和完整 `identity`，省略 `input`。所有 RPC（包括读取用的 POST）都要合法 Cookie、精确同源 Origin、`Content-Type: application/json` 和 `X-CSRF-Token`。浏览器在同源请求中管理 Cookie／Origin，不把 HttpOnly Cookie 交给 agent 抄写。
3. 写入 `POST /api/v1/rpc/mutate`，将上文 `MutationRequest` 原样作为 `input`；先处理 HTTP 错误，再检查响应 `ok` 和 `data.status`。直接结构化 `snapshot`／`mutate` 不调用 AI；`command` 会使用应用配置的模型。
4. 预览到确认是两个不同传输请求。确认保留同一 `operationId` 和 mutations，但使用新的 `requestId`、实际预览的令牌和可信确认流程。传输 ID 不能与业务操作 ID 混用。

下例只展示 HTTP 包装层；所有示例 ID、identity 与计划内容都须替换，不可直接发往正式服务：

```json
{
  "requestId": "fictional-transport-plan-r1-01",
  "identity": {
    "protocolVersion": 1,
    "dataInstanceId": "11111111-1111-4111-8111-111111111111",
    "generation": 1
  },
  "input": {
    "operationId": "fictional-plan-r1-create-task-01",
    "origin": "ai",
    "confirmed": false,
    "mutations": [
      {"type": "create", "entity": "task", "values": {"title": "完成阅读练习", "deadline": null}}
    ]
  }
}
```

HTTP RPC 不提供电脑文件选择、路径登记、QQ 采集控制或任意文件读取。需要为已有任务撤销本次操作时，`POST /api/v1/rpc/undo` 的 `input` 是明确的 `transactionId` 字符串，不是“撤销最近一次”。完整鉴权与错误处理以 [后端接口](backend-api.md) 为准。

## 关联网页、文件和公共资料

任务、时段、课程和目标都支持 `resources`，每个实体最多 50 项，同一数组内 `id` 唯一。链接只是引用：关联电脑文件不会复制或上传文件本身，移除关联也不会删除原文件。

**网页：** 使用稳定唯一的资源 ID、可读名称和 HTTP(S) 地址；不接受 `file:`、脚本或带账号密码的 URL。可直接放在 create 的 `values.resources`，例如：

```json
{
  "id": "fictional-reading-guide",
  "name": "阅读练习说明",
  "kind": "web",
  "url": "https://example.org/reading-guide"
}
```

**电脑文件／文件夹：** 在 Windows 使用“关联资料”、拖入文件，或具备能力时调用 `window.planner.resourcePick({kind:"file"})`／`resourcePick({kind:"folder"})`。已由用户指定的现有路径可通过 `resourceRegister({paths:[...]})` 登记。先检查结果 `ok`，取消选择得到空数组；登记只保存本机位置，还没有关联到任务。将返回的完整 `{id,name,kind,deviceId,deviceName}` 引用用于下一次 mutation，不自行编造文件 ID、设备 ID 或把 `path` 加进共享对象。不要为获得路径去解密凭据或扫描无关文件。

**给现有对象增加资料：** 读取最新 `resources` 和 `version`，保留原有引用，合并去重后用 `type:"update"`、`values:{resources:[...]}` 提交。普通 update 会替换整个资源数组，不能只发新增的一项而意外删掉旧关联。其他字段不修改就省略；重复活动需走 `updateRecurringEvent` 和明确范围，追加资料可使用其 `resourceMode:"append"`，不能普通 update 重复 Block。

**公共资料放在上层：** 目标／课程保存公共资料，任务用 `goalId`／`courseId` 关联，时段再用 `taskId` 关联；详情会继承显示这些资料，无需给每个时段复制。单次活动特有材料才放在该 Block。现有继承规则见 [resources.ts](../src/domain/resources.ts)。

Windows 可打开本机已登记且仍有效的文件／文件夹，网页由 Edge 打开；手机可打开网页，但不能打开这台电脑的本地路径。文件移动后用原电脑的重新定位功能保留关联，不能宣称手机已取得文件。关联资料本身也不代表 AI 已读取过文件内容。

## 重复活动与后续调整

新任务连同重复活动使用 `createRecurringTask`，已有任务使用 `scheduleRecurringTask`，后者需最新 `id` 和 `expectedVersion`。规则字段：

```json
{
  "frequency": "weekly",
  "fromDate": "2030-04-15",
  "untilDate": "2030-05-12",
  "weekday": 2,
  "time": "20:10",
  "durationMinutes": 30,
  "termStart": null
}
```

- `weekday` 周一为 1、周日为 7；日期范围包含两端，最多相差 365 天，一次最多 100 次活动。
- `frequency` 仅支持 `weekly`、`biweekly`、`odd-weeks`、`even-weeks`。`biweekly` 从范围内第一个匹配星期开始每隔两周；教学单双周必须使用真实学期第一周的周一 `termStart`，不能用 ISO 周号代替。
- 不支持通用 RRULE、无限期、每日或每月重复。这类需求可在明确的有限区间内生成单独时段，但要说明它们没有系列批量修改能力。
- `createRecurringTask` 创建一个任务及多次 `event`；`scheduleRecurringTask` 复用已有任务，只安排或纳入发生次，不再新建任务。完成一次活动不应将整个系列任务标记完成。`recurrence`、`seriesId`、`occurrenceStart`、`cancelled` 由服务维护，不可塞入普通 create。
- 修改／取消系列使用 `updateRecurringEvent`／`cancelRecurringEvent`，传入所选发生次的 Block `id`、最新 `expectedVersion`，以及 `scope:"single"` 或 `"this-and-following"`。修改值放在 `values`；取消没有 `values`。不要绕过它直接 update/delete 重复 Block。
- 普通任务或时段修改使用 `type:"update"`、`entity`、`id`、`expectedVersion`、`values`；不是 `patch`。完成分别使用 `finishTask`／`finishBlock`，并传 `completed:true`。

漏学一天时，先读最新完成状态和已经存在的未来安排；保留未完成的原任务，仅提出受影响时段的调整。已完成内容不重建，未完成内容不自动勾成完成，不擅改真实 DDL。当前没有自动依赖调度器，顺延方案要由 agent 计算后按实际修改接口保存。

## 保存、确认与防止重复

1. **执行前已获得用户对本次导入／修改的授权。** `confirmed:false` 不是 dry-run：单项且无冲突的写入可能直接保存；只想展示方案时不要调用 `mutate`。
2. 每个批次使用稳定唯一的 `operationId`，请求最多 500 项。生成请求后保留原 JSON；超时重试保持相同 ID、相同内容及顺序。修改内容要生成新操作 ID。不要每重试一次就换 ID 重建对象。
3. `result.ok:false` 表示调用失败；`ok:true` 不一定代表已保存。`data.status:"applied"` 才是已提交，记录其 `transactionId` 和 `changes`；`preview` 仍未写入；`clarification` 要按返回问题处理。
4. 多项批量、重复安排、需核对的修改或时间冲突可能返回 `preview`。把实际 `details`、`conflicts` 给用户核对；由可信应用界面在用户确认后，使用原 `proposedRequest`、同一操作 ID 和 mutations，加上本次 `confirmationToken`、`confirmed:true`、`origin:"manual"` 提交。agent 不得自行把 AI 提案改成已确认请求；`origin:"ai"` 本身不能提交确认令牌。已有明确授权可继续按应用流程执行，不必再次询问同一个已确认决定；仍需用户选择的冲突不能擅自替选。
5. 预览令牌 10 分钟有效；期间日历实体／设置改变，或持有预览的规划服务重启，会使其失效。本机模式是本机规划进程，云模式是资料服务，不能把两者的重启混为一谈。内容改变时使用新操作 ID；仅令牌失效且内容不变可沿用业务 ID 重新预览，HTTP 层使用新的 requestId，不能重放旧预览的传输回执。
6. 应用只保证相同操作 ID 的幂等，不会自动按相似标题全面查重。执行前利用已有回执和快照判断“新建、修改、跳过”；同一标题的不同日期也可能是合法的不同安排。
7. 多阶段计划不是跨阶段的一个大事务。阶段一已保存、阶段二失败时，记录部分成功，继续或撤销对应阶段，不能把整个方案重新创建一遍。每个已提交批次可按返回的 `transactionId` 撤销；不要盲目撤销用户后来做的其他操作。
8. 保存后读取一次最新快照，核对本次产生或修改的 ID、时间、关联关系与提醒。普通计划导入不需要重新打包软件、全库备份、跑全量测试或逐表对账。

回执保存在本地交接记录中，至少包含：计划 ID／修订号、资料模式、每个批次的原始请求和操作 ID、执行状态、事务 ID、本地条目编号对应的实体 ID／version、仍未保存的项目。直接 HTTP 客户端另记录 origin、device ID、完整 identity、requestId 和与之对应的业务结果；不保存 Cookie、CSRF、配对码或 API Key。回执不属于应用 API 请求的一部分。

### 云端超时、断网与结果待核对

- Windows 界面提示上一项云端操作未核对时，使用托盘“核对云端操作”，或按原操作重试让现有客户端核对；不要删 `remote-write.json`、换 profile 或新建一套任务来绕过保护。
- 直接 HTTP 写入超时／连接中断后，在**同一设备、同一资料实例和 generation** 查询 `GET /api/v1/operations/{requestId}`。`completed` 要继续解析原 `result`，它可能只是 preview、clarification 或失败；`processing` 等待并核对原请求；`interrupted` 先核对最新资料和已有回执，不自动重发。
- `unknown` 只表示当前设备／代际没有这份回执。确认仍属原设备和资料、请求内容完全相同且确需重试时，保留原 requestId、operationId 和正文。不能据此推断另一设备或旧代际从未写入。
- 收到 401／403 或 identity／generation 冲突时，停止沿用旧授权写入并保留草稿。刷新会话和资料，重新核对；不要将旧计划改贴新 identity 后自动重放。云模式断网时没有自动写回最新云端资料的本地替代库。

同一个 requestId 不能换内容，**预览转为确认时也必须换 requestId**。业务已经返回明确终局错误时，反复发送原请求不会使它成功；修正后作为新操作提出。不要把 HTTP 200、进程退出码 0、文件生成成功或 `processing` 当作计划已导入。

最后回复示例：

> 已加入 4 个任务、6 个时段，日期为……；其中 2 个时段有冲突，尚未保存，等待确认。未改动现有课程和真实 DDL。

只能生成文件时回复“计划已生成，尚未导入”，不要回复“已安排”。

## 本地资料与工作范围

通过现有应用入口写入；不要直接 SQL 修改记录，不要在应用运行时替换 `planner.sqlite`，也不要把计划转换成“恢复备份”覆盖资料。不要修改 QQ 客户端或 QQ-agent。

真实计划、课表和导入回执属于用户资料，只保存到用户授权的当前应用／资料服务及私有交接位置，不进入公开源码仓库；电脑材料路径只留本机。只有用户明确要求上传或发布软件时才操作 GitHub。编写计划和正常导入不需要升级软件或做发布检查。
