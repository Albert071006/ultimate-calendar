# 后端接口与离线迁移交接

供前端与 Windows 客户端接入时使用。核对日期：2026-10-25。本文记录源码契约，不代表某台生产服务已部署、正式资料已迁移，或 iPhone 提醒已验收。

## 代码与职责

| 内容 | 权威定义 |
| --- | --- |
| HTTP 路由、来源校验、Cookie、请求上限 | `src/server/http.ts` |
| RPC 输入与输出 Schema | `src/server/protocol.ts` |
| 身份、设备、回执 | `src/shared/remote.ts`、`src/server/state.ts` |
| 正式实体、修改、预览、助手、来源 | `src/shared/contracts.ts` |
| 账目及金额语义 | `src/shared/ledger.ts`、`src/ledger/service.ts` |
| QQ 提炼上传 | `src/shared/distilled.ts`、`src/server/distilled.ts` |
| 推送订阅与负载 | `src/shared/push.ts`、`src/server/push-http.ts` |
| 云端 API Key 配置 | `src/shared/ai-configuration.ts`、`src/server/ai-configuration.ts` |
| 采集电脑加密密钥同步 | `src/shared/ai-key-sync.ts`、`src/server/ai-key-receiver.ts`、`src/electron/collector-key-sync.ts` |
| 共享设置、账户、导出与受控恢复 | `src/shared/cloud-management.ts`、`src/server/service.ts`、`cloud-export.ts`、`cloud-restore.ts` |
| Windows 本机文件、采集控制与原文关联 | `src/electron/remote-files.ts`、`collector-control.ts`、`local-evidence.ts`、`src/bridge/evidence-index.ts` |
| 现有浏览器适配参考，不能当成 HTTP 接口 | `src/renderer/remote/client.ts`、`queue.ts`、`storage.ts`、`types.ts` |
| 冷副本导出及 manifest 核验 | `src/migration/export.ts`、`command.ts`、`cli.ts` |

所有日期/日历规则使用北京时间；带时刻的字符串采用含偏移的 ISO 时间，例如 `2030-01-10T15:10:00+08:00`。金额使用整数分；不能通过前端浮点加总代替服务端账本。

## 同源与配对

页面和 `/api/v1/` 部署在同一显式 HTTPS origin。只有 localhost 开发允许 HTTP。服务校验精确 Host、Origin，拒绝跨站请求；反向代理必须保留可信的外部 Host，不能把任意用户头当成可信来源。

生产 Cookie 为 `__Host-planner_session`，属性为 `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`。仅本机 HTTP 开发使用 `planner_dev_session`。前端使用浏览器 Cookie，不读取、复制或写入 localStorage；没有 Bearer Token 登录或公开注册接口。

1. `GET /api/v1/session`：未配对返回 `{ "paired": false }`；已配对返回：

```json
{
  "paired": true,
  "identity": {
    "protocolVersion": 1,
    "dataInstanceId": "11111111-1111-4111-8111-111111111111",
    "generation": 1
  },
  "device": {
    "id": "22222222-2222-4222-8222-222222222222",
    "name": "合成手机"
  },
  "csrfToken": "示例保护凭据",
  "aiConfigured": false
}
```

2. 管理者使用 CLI `pair` 生成随机 32 字节的 base64url 一次性配对码，10 分钟有效；每码最多 10 次尝试。
3. `POST /api/v1/pair`，JSON 为 `{ "code": "高熵一次性配对码", "name": "我的手机" }`。code 长 16–100，名称 trim 后长 1–80。此请求需要同源 Origin，但尚无 CSRF 凭据。成功设置 Cookie，并返回上面的已配对会话结构。
4. 此后所有非 GET/HEAD API 请求均需 `Content-Type: application/json`（有 JSON body 时）及 `X-CSRF-Token: <session.csrfToken>`。每次重新取得会话后使用最新凭据。Cookie 或 CSRF 不应进入缓存、隔离档案、导出文件或日志。

获取 `paired:false` 或 HTTP 401 后，不能因为之后手机断网而退回“仍有编辑授权”的状态。保留旧草稿用于恢复，但不再发送或新增原授权下的离线操作。

## RPC

统一使用 `POST /api/v1/rpc/{method}`，没有任意方法调用或文件系统接口。请求：

```json
{
  "requestId": "transport-id-unique-per-submission",
  "identity": {
    "protocolVersion": 1,
    "dataInstanceId": "11111111-1111-4111-8111-111111111111",
    "generation": 1
  },
  "input": {
    "operationId": "business-id-for-this-edit",
    "origin": "manual",
    "mutations": [
      { "type": "create", "entity": "task", "values": { "title": "合成任务" } }
    ]
  }
}
```

| method | input | 成功 data |
| --- | --- | --- |
| `snapshot` | 省略 `input` | `Snapshot`，含实体、设置、有限操作摘要、用量、密钥是否配置；不含密钥 |
| `mutate` | `MutationRequestSchema` | `MutationResult`：`applied / preview / clarification` |
| `undo` | 明确的 transactionId 字符串 | `MutationResult`；不允许无目标撤销 |
| `command` | `CommandRequestSchema` | `CommandResult`，可能附带 mutationResult，不等于一定保存 |
| `importSource` | `{ operationId, source }` | `Source`；source.kind 为 text 或 image |
| `analyzeSource` | `{ operationId, sourceId }` | `AnalysisResult`，可能需要进一步确认 |
| `ledgerSnapshot` | 省略，或 `{ month: "2026-10" }` | `LedgerSnapshot`；余额来自流水与余额快照 |
| `ledgerMutate` | `{ operationId, expectedRevision, changes, month? }` | `LedgerMutationResult`：`saved / already_saved` |
| `ledgerUndo` | `{ operationId, expectedRevision, month? }` | `LedgerMutationResult` |
| `saveSettings` | `{settings,expectedSettings}`，均为完整 `SettingsSchema` | 保存后的共享 `Settings` |
| `accountSnapshot` | 省略 | `AccountState`：是否配置、模型、余额、价格及各资源加载/错误状态 |
| `refreshAccount` | 省略 | 强制刷新后的 `AccountState` |
| `importCourses` | `CourseImportRequestSchema`，仅 text/image/source | `CourseImportResult` 预览；不直接写正式课表 |
| `ledgerExportData` | `{format:"csv"\|"json",month?}` | `{content,format}` |
| `backupExportData` | 省略 | `{content}`，完整安全备份 JSON 字符串 |
| `restorePreview` | `{content}`，安全备份 JSON 字符串 | 预览 token、digest、有效期、备份日期与实体计数 |
| `restoreConfirm` | `{token,digest}` | 新 `identity`、`backupCreated:true`、任务/课程/账目计数 |

RPC 响应为 `{ ok:true, data }` 或 `{ ok:false, error:{code,message,retryable} }`。HTTP 200 只表示收到业务响应，必须检查 `ok` 和 `data.status`。

正式 task、block、goal、course、courseException、候选接受/忽略/稍后/恢复、重复时段及完成状态由 `MutationSchema` 枚举。更新使用 `expectedVersion`；重复系列使用明确的修改范围。不要根据 UI 字段自行创造 mutation。DDL 不占时，执行时段与固定活动不同；分钟和用户指定时长不得被网格取整。

RPC 白名单不包含 `setApiKey`、本机文件对话框、软件更新、QQ 采集管理、空间清理或任意电脑文件读取。API Key 使用下述独立配置接口，`/api/v1/rpc/setApiKey` 仍被拒绝。Windows 的这些本机入口由主进程及采集控制管道实现，不是新增的 HTTP 权限；手机不能调用本机控制管道。

## 共享设置、账户与课表

`saveSettings` 要求带上打开表单时取得的 `expectedSettings`。服务器比较完整共享字段，并串行执行比较与保存；期间其他设备修改会返回业务 `CONFLICT`，不能先刷新期望值再静默覆盖。`closeToTray` 和 `autoLaunch` 是 Windows 设备设置，比较时忽略，云端保存时保留服务器原值；Windows 主进程另存本机 `device-settings.json`，界面快照再覆盖为本机值。

账户信息由云端复用 DeepSeek 账户服务获取：首次 `accountSnapshot` 启动并等待按 TTL 刷新，`refreshAccount` 强制刷新。响应分开表达 models/balance/prices 的数据、时间、加载与错误；不能把失败时的旧余额当成刚刷新成功。只有公开价格缓存落盘，不缓存余额或 Key。云端模型请求使用账户服务提供的价格及输入模态，账户服务启动后会在模型请求结束时刷新余额。Key 保存/清除会重置旧账户数据；单纯设置 Key 不执行收费模型测试。

Windows 的 CSV/XLSX 文件由主进程选择、限大小并在本机按最新云端学期设置解析，文件本身不上传。HTTP `importCourses` 不接受 `kind:"file"` 或文件路径；text 是明确提交的 CSV 文本，image 是用户明确选择的课表图片，source 只能指向仍可用的课表原图。所有导入均先返回待核对行、课程和不确定项，正式采用继续走带版本/确认的日历 mutation。

## 完整导出与受控恢复

`ledgerExportData` 调用完整账本导出，而不是把 `ledgerSnapshot` 当成备份。JSON 包含所有月份的流水、余额快照、规则、审计和来源字段；`month` 仅过滤 CSV。账本导出属于私密业务资料，JSON 来源字段不等于已经清理原文的安全迁移包，不能直接用来调用云端恢复。

`backupExportData` 先生成服务器内部安全备份，再返回 `ultimate-calendar-safe-backup` v1 完整 JSON。包含日历实体/关系、账本历史/余额/规则等正式资料；来源文本、图片、QQ 定位信息、候选引用及账目/审计的 `originalText` 会被清理。会话、Key、VAPID 和本机原文索引不在包内；接口不返回服务器路径。Windows 主进程再让用户选择保存位置。

导出 `content` 的 UTF-8 上限为 **8 MiB**，该字符串经 JSON 转义后的上限为 **16 MiB**。超限返回错误，绝不截断为一个“成功”的不完整文件。内部备份生成失败也不会返回成功导出。

恢复只接受上述安全备份格式，不能上传 SQLite、旧本机完整备份或 QQ 原文包。Windows 先在本机校验完整 Schema/关系/金额并清理来源与 `originalText`，再上传清理后的 JSON：

1. `restorePreview` 校验内容，不改正式资料；返回 `{token,digest,expiresAt,createdAt,taskCount,courseCount,goalCount,ledgerEntryCount}`。token 仅在服务内存保存 10 分钟，绑定设备、上传内容摘要、当前业务资料摘要和当前 identity；每设备新预览替换旧预览，全服务最多保留 3 个预览。
2. 用户核对后提交 `{token,digest}`。服务器再次核对绑定；预览后资料发生变化、token 失效、设备不符或有普通写入正在执行，均拒绝恢复。确认时不重新接收完整备份，客户端不能替换预览内容。
3. 确认先保存当前云端安全备份，再推进 generation、清理旧传输回执，并在单个 SQLite 事务内替换日历与账本，清除恢复包中的旧领域重放操作与提醒回执。配对会话及云端 Key 保留，不恢复备份中的凭据。
4. 只有明确成功的专用确认响应可让发起客户端采纳新 identity；代际必须仍属原资料实例且恰好增加 1。其他设备的旧 identity 返回 409，旧队列不得自动重放。服务端会丢弃跨恢复代际的在途读取结果。
5. generation 与业务库位于不同数据库，不能宣称两者原子提交。先推进代际可保证异常中断时最多保留旧资料和新代际，不会让旧队列写入已恢复资料。`/api/v1/status.restore` 的 processing 在下次启动转为 interrupted；失败或中断时需人工核对现有资料及恢复前备份，不能把它显示为恢复成功。

`restorePreview` 和 `restoreConfirm` 均不写普通 RPC 回执；确认只能调用一次，**不进离线队列，不自动重试**。超时或响应丢失时，token 已可能消费、代际已可能改变；按恢复结果待核对处理，不能用 `/operations` 的 unknown 推断未执行。原有 CLI `restore` 仍只恢复到新/空目录，和这套已配对设备明确确认的在线恢复是不同入口。

## 手机与 Windows 填写云端 API Key

手机和 Windows 管理同一份云端密钥配置，客户端只提交用户刚填写的密钥。云端工作流由资料服务调用 DeepSeek；QQ 提炼由获授权的采集电脑加密同步这份配置后在本机调用模型。所有已配对设备均视为同一用户的可信设备，可以管理全局配置；接收密钥另需服务器管理员预先绑定设备和公钥，普通配对不授予接收权限。Windows 的 `setApiKey` IPC 只调用下述独立配置接口，不转成 `/api/v1/rpc/setApiKey`，不写普通操作日志，也不把界面输入直接转交本机采集进程。

三种请求均需已有配对 Cookie。PUT／DELETE 还必须携带精确的 Origin、`Content-Type: application/json` 和会话中的 `X-CSRF-Token`，JSON body 上限 4 KiB。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/ai/config` | 无 body | `{ok:true,identity,configuration}` |
| `PUT /api/v1/ai/config` | `{identity,expectedRevision,apiKey}` | 与 GET 相同，返回新的 revision |
| `DELETE /api/v1/ai/config` | `{identity,expectedRevision}` | 与 GET 相同，configured=false，返回新的 revision |

GET 初始示例：

```json
{
  "ok": true,
  "identity": {
    "protocolVersion": 1,
    "dataInstanceId": "11111111-1111-4111-8111-111111111111",
    "generation": 1
  },
  "configuration": {
    "provider": "deepseek",
    "configured": false,
    "editable": true,
    "source": "none",
    "revision": null
  }
}
```

`source` 为 `managed`（手机与 Windows 共用的云端密钥）、`external`（管理员文件／环境配置）或 `none`。`configured` 仅说明已有密钥，**不表示供应商已验证有效、余额充足或出站网络正常**。配置接口从不返回密钥明文、部分字符或其哈希；页面不能回填旧密钥。

保存时，把刚读取的完整 `identity` 和 `configuration.revision` 原样带回。例如初次保存：

```json
{
  "identity": {
    "protocolVersion": 1,
    "dataInstanceId": "11111111-1111-4111-8111-111111111111",
    "generation": 1
  },
  "expectedRevision": null,
  "apiKey": "synthetic-example-key-do-not-use"
}
```

示例 Key 是虚构字符串。真实输入先 trim，随后必须为 16–512 个可打印 ASCII 字符，内部不能有空白或控制字符；未知字段被拒绝。保存只检查格式和文件写入，不发起模型请求或收费测试。保存成功后，新发起的 AI 工作流动态读取新密钥，无需重启；已经取得旧密钥的在途请求仍可能使用旧值。清除配置不会撤销供应商侧 Key，也不保证取消已发出的 AI 请求。本接口不修改模型、供应商或 API 地址。

每次保存或清除都会产生新的 UUID revision。清除后的 revision 仍保留，不能把 configured=false 当成 revision=null。若其他设备已改配置，或资料 identity／generation 发生变化，PUT／DELETE 返回 409；重新读取状态，由用户核对后决定是否再次提交，不能自动覆盖最新值。`editable=false` 表示服务器用了外部配置，此时 PUT／DELETE 返回 403；手机不能覆盖或清除管理员提供的密钥。

前端接入顺序：

1. 读取 session 和配置，显示“未配置／已配置／由服务器管理”，密钥输入框保持空白。
2. 仅在用户点击保存且在线时发送 PUT。输入内容只保留在当前页面内存；成功后清空输入框，并使用响应中的最新 revision。
3. 用户明确选择清除时，用最新 identity／revision 发送 DELETE；不要通过空字符串 PUT 代替清除。
4. 收到 401 刷新授权；403 检查会话保护和 editable；400／413／415 修正输入。409 刷新并提示冲突。
5. 超时、连接中断或 500／503 时提示“保存结果待核对”，待服务恢复后 GET 读取最新状态。revision 变化本身不能证明是本次请求成功，也可能是另一设备修改；无法确认时请用户核对，不自动重发。

配置请求不使用 requestId，不写入通用 RPC 回执，也没有 `/operations` 查询结果。**不要接入普通离线队列或自动重试中间件**；不要将 Key 放入 localStorage、IndexedDB、Service Worker 缓存、URL、日志、分析上报、隔离档案或导出文件。响应带 `Cache-Control: no-store`；客户端同样应跳过缓存。保存或清除成功会通过现有 SSE 发出 `changed` 事件，内容只有 `reason:'key'` 和 identity 等变更信息，没有 Key。其他设备收到后重读配置／session／snapshot；重新打开配置页也应 GET，不能把旧 revision 当成永久有效。

### 采集电脑加密同步

配置好 receiver 授权后，手机或 Windows 保存、轮换、清除云端 Key 都由采集进程自动同步，无需在电脑重复填写或保存。这个读取通道独立于用户的 PUT／DELETE 修改，不会重放配置写入，也不接入通用 RPC 回执。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/ai/receiver/sync` | `{identity,nonce,keyId}` | `{ok:true,identity,envelope}`，按 `AiKeySyncResponseSchema` 校验 |

请求需有效配对 Cookie、精确 Origin、JSON Content-Type 和 `X-CSRF-Token`，body 上限 32 KiB，响应禁止缓存。`nonce` 是每次请求新生成的 32 字节随机值，编码为规范的无填充 base64url；`keyId` 是接收公钥规范 SPKI DER 的 SHA-256，不是 API Key 哈希。客户端不能在请求中提交任意接收公钥。服务器从会话确定设备，核对完整资料 identity，再检查私密 `ai-key-receivers.json` 中预先登记的 `{deviceId,publicKeySpki,keyId,expiresAt?,revoked}`；注册文件外层为 `{version:1,receivers:[...]}`。该文件每次请求重新读取，支持撤销和到期，无 HTTP 注册入口。

信封包含 `version:1`、`deviceId`、`keyId`、`nonce`、`revision`、`wrappedKey`、`iv`、`ciphertext`、`tag`。服务器对原子读取的 `{apiKey,revision}` 使用 AES-256-GCM 加密，以 RSA-3072 OAEP-SHA256 包装一次性对称密钥；AAD 绑定资料 identity、设备、公钥标识、请求 nonce 和配置 revision。清除时加密负载的 `apiKey` 为 null，仍保留清除产生的新 revision。未获接收授权、授权被撤销／到期或外部管理员密钥不允许分发时返回 403；identity 改变返回 409；授权文件或加密存储异常返回 503。普通浏览器配置页面只能看到状态，没有解密私钥或接收明文的接口。

采集进程验证所有绑定与认证标签后，将 Key 存入本机系统加密的凭据存储，再按新 revision 通知 QQ 分析服务；接收私钥及绑定 identity／设备／revision 的同步收据也加密落盘。分析服务另在同一 SQLite 事务中记录来源／revision 已处理标记并更新暂停状态与待重试批次；同步收据写失败或进程重启产生重复通知，也不会再次恢复同一版本。启动、约 10 秒轮询及每次模型请求前触发同步；失败退避，最长间隔约 60 秒。同步网络、授权、校验或落盘失败时不继续使用旧 Key 发起新分析，原文与待处理进度保留；它不把网络失败误记为用户关闭分析。

只有因明确 `AUTH`／`NO_API_KEY` 自动暂停的分析，才在新 revision 成功同步后自动恢复并重试对应的明确失败批次。手动暂停及“停止等待密钥”会清除自动恢复意图；相同 revision 的轮询或重启不会反复唤起已拒绝的密钥。余额、限流和响应未知的失败不自动重试。清除密钥暂停新请求，QQ 继续收集，已发出请求的结果仍可保存。`CaptureSnapshot.analysisWaitingForKey` 与 `cloudKeySync` 只返回等待状态、revision、同步时间和错误说明，不返回 Key。QQ 原文、附件和本机来源索引不会随密钥同步上传资料服务。

## 更改预览与两种操作标识

`applied` 才代表正式日历修改成功，并给出 transactionId。`preview` 和 `clarification` 均尚未应用；后者含 questions，不能渲染成已完成。

`preview` 包括 `confirmationToken`、`expiresAt`、`proposedRequest`、`details`、`changes`、`conflicts`。用户核对后，以 proposedRequest 为依据发送 `confirmed:true` 和精确 confirmationToken。不要自行拼接一个“等价”预览，也不能让 AI 自行确认。

- `requestId` 是传输重试边界：同一设备、identity、方法和请求内容丢失回执时保留同一编号。
- `operationId` 是领域操作标识：预览到确认仍可保持同一业务 operationId，但确认是新的传输请求，必须换 requestId。
- 同一个 requestId 换参数、换设备或跨代际会被拒绝。明确失败已经是该请求的终局结果，原样重复不会变成功；调整内容必须走新的明确操作。
- 版本冲突不能默认覆盖。用户选择本机修改后，先取新快照，再基于最新版本重新提出；普通修改可能直接保存，需要预览的修改继续由服务返回预览，不能统一声称“只是预览”。

## 回执、事件与错误

`GET /api/v1/operations/{requestId}` 仅查询当前设备、当前 generation 的回执：

| status | 含义与客户端处理 |
| --- | --- |
| `unknown` | 当前设备/代际没有该回执；不能据此推断另一设备或旧代际没执行过 |
| `processing` | 尚在执行，继续查询同一操作，不新建重复指令 |
| `interrupted` | 服务重启时执行未结束；需要核对，禁止自动重复执行或收费 |
| `completed` | 带 requestId、method、原 result；按原 RPC Schema 解析 |

普通 RPC 写请求需要持久传输回执；`snapshot`、`ledgerSnapshot`、账户读取/刷新、账本导出、安全备份导出和恢复预览不写普通回执。连接中断、超时或 500 不能当作未执行。先查询原 requestId；确认结果以前保留草稿。独立 API Key 配置及特殊恢复确认不使用此回执机制，分别按配置状态和恢复状态核对，不能自动重发。

`GET /api/v1/events` 是同源 Cookie 的 SSE，不使用 query token。先发 `event: ready`，data 含 identity、sequence；变更使用 `event: changed`，含 reason 和 identity。约 20 秒一次注释心跳。事件用于提示重新读取，不是完整实体 diff 或永久事件日志；sequence 不是可依赖的跨进程历史游标。重连应重新核对 session/identity 并刷新快照。不要关闭 EventSource 后停止所有恢复尝试。

HTTP 层失败结构通常为 `{ok:false,error:{code,message}}`，**没有保证带 retryable**，也不保证 error.code 属于领域 ApiErrorSchema。401 的 HTTP code 为 `UNAUTHORIZED`；RPC 内的授权类错误可为 `AUTH`。前端应先处理 HTTP 状态，再解析 RPC 业务结果。

| HTTP | 常见原因 |
| --- | --- |
| 400 / 415 / 413 | Schema、JSON、Content-Type 或体积错误；改输入，不盲重试 |
| 401 / 403 | 会话失效、CSRF、Host/Origin 不匹配；重新检查授权 |
| 409 | 请求指纹不匹配、代际变化、中断操作或资源冲突 |
| 429 / 503 | 并发上限、退出阶段或暂不可用；可含 Retry-After，保留原请求身份 |
| 500 | 结果不确定；普通写 RPC 查回执，API Key 重新 GET，恢复确认核对服务状态/资料代际，不假定未写入 |

默认 RPC body 上限 15 MiB；恢复预览为 16 MiB + 64 KiB，仍受上述 content 大小校验。配对 1 KiB，API Key 配置 4 KiB，加密 receiver 同步 32 KiB，QQ 提炼 1 MiB，推送 JSON 16 KiB。并发上限还会单独限制设备和 SSE；允许的重试需要退避，不要并发轮询。API Key 配置修改及恢复确认不自动重试。

## 设备与服务状态

- `GET /api/v1/devices` → `{devices:[{id,name}]}`；当前接口不保证返回创建/到期时间，current 由前端与会话设备 ID 比较。
- `DELETE /api/v1/devices/{uuid}` → `{ok:true}`；撤销会话，关闭该设备事件流，运行时联动撤销推送。撤销当前设备前先处理手机未确认操作。
- `POST /api/v1/logout` → `{ok:true}`，清除此设备 Cookie 和服务会话。未提交队列属于客户端责任，后端不知道浏览器尚未发送了什么。
- `GET /api/v1/status`（已授权）→ lifecycle、activeWrites、backup、restore 和存储体积。restore 为 `{status:"never"|"processing"|"completed"|"interrupted",at,generation}`；at/generation 可为 null。备份或恢复异常应可见，不能把业务已提交的结果伪装成未执行或重复提交。
- `GET /healthz` 是活性；`GET /readyz` 是就绪检查，仍受 Host/Origin 边界，非配对 API。readyz 可反映存储不可用或备份降级，不代表 DeepSeek 或手机推送已验证。

## 来源与 QQ 隐私

QQ 采集仍在 Windows 电脑；服务只接受 `/api/v1/distilled` 的提炼字段。请求为 `{requestId,identity,items:[...]}`，items 使用 `DistilledItemSchema`，带稳定且非原始电脑标识的 distilledId，以及 title/action/benefit/deadline/eventStart 等字段。成功为 `{ok:true,data:{candidateIds,created}}`。同一提炼编号重复上传不重复创建候选；禁止上传群号、QQ 账户、原始消息、附件路径或原件。

来源占位须按真实语义展示：

- `label: "采集电脑提炼"`：QQ 原文和附件留在采集电脑，手机目前不能读取。不能显示“消息原件”或“再次分析”。兼容旧标签 `QQ提炼...`。
- `label: "手机导入（原文已清理）"` 或标准 SOURCE_PLACEHOLDER：分析输入已清理，正式提炼事项仍保留。不能再次分析这份输入。
- 普通尚保留输入的手机导入可以显式提交分析。文本/截图分析完成后清原文；失败输入至多暂存 24 小时，按维护检查清理。不能用缓存再次暴露已经清理的原文。

手机主动导入是独立授权，不能当成用户允许上传 QQ 原文。截图走浏览器 PNG/JPEG data URL，现有前端适配器限制 10 MiB；后端仍执行来源 Schema 和 HTTP body 限制。不要复用电脑文件选择或上传任意本地路径。

Windows 云窗口可以通过本机采集进程的受保护 named pipe 管理采集、查看原文及清理本机空间。发送桥另在本机建立 `credentials/qq-evidence-index.sqlite`，把稳定云端 sourceId 对应到本机候选/来源；这些关联只留本机，不进入 distilled 请求。`localSourceEvidence` 是本机 IPC，不是 HTTP RPC：旧迁移来源优先按相同 ID，提炼来源按索引精确查找，不按标题猜测；索引缺失或原文已清理必须显示找不到，不能从云端虚构原件。云窗口不另开本机正式数据库写入者，只有采集进程持有本机资料。

## Web Push

推送路由由运行时扩展安装，全部需要配对 Cookie；POST 仍需 CSRF。

| 路由 | JSON 与结果 |
| --- | --- |
| `GET /api/v1/push` | `{enabled,publicKey,subscriptions}`；publicKey 是公开 VAPID 公钥，不是 API Key |
| `POST /api/v1/push/subscribe` | `{subscription: browserSubscription.toJSON(),showDetails:false}` → `{subscription: summary}` |
| `POST /api/v1/push/unsubscribe` | `{subscriptionId}` → `{ok:true}`；只作用当前设备 |
| `POST /api/v1/push/test` | 显式用户测试，`{subscriptionId}` → `{accepted:true}`；不应页面初始化时触发 |

只有用户点击启用才申请 Notification 权限；需要 HTTPS、Service Worker 和目标平台支持。默认 showDetails=false；通知负载显式 showDetails=true 才可展示事项细节。订阅成功、浏览器权限允许和推送服务接受不等于 iPhone 已实际收到。生产 VAPID 联系地址、外网通达及真实 iPhone 安装/后台提醒仍需部署验收。

## 离线队列交接

HTTP 服务不返回 `queued`；它是现有浏览器 PlannerClient 适配器在 IndexedDB 已完成持久化之后产生的本机状态。只能写“仅在此手机暂存”，不能写“资料服务已保存”。正式账本余额不能叠加未提交账目。

现有适配器仅支持受限的普通任务/时段离线创建、修改、完成，以及新增的简单全额个人 expense 草稿。关联候选、复杂 AA/返款/退款、重复系列、删除、AI 分析等不能从此推导为离线可用；具体白名单见 queue.ts。全部请求仍在联网后由后端 Schema、版本、时间冲突和账目规则复核。

队列按 origin、dataInstanceId、generation、设备分区。先存出站记录再发送；本机新建 task/block 的依赖用临时 ID，在服务确认父记录后映射为正式 ID，再提交后续操作。重开网页保留原 requestId。sending/uncertain/interrupted 不能直接丢弃；blocked 只有确定从未形成 wireInput 才可丢弃。普通 queued/conflict/failed/review 的放弃也要检查依赖。

401、paired:false、代际变化时停止旧队列重放。重新配对不能静默丢失或自动迁入旧队列。现有适配器支持先导出私密本机 JSON，再经用户明确选择持久隔离为档案后换配对；档案仅人工核对。旧操作可能已执行，不能照抄重建。这些是浏览器本地能力，**没有对应的 HTTP 队列上传/隔离档案接口**。

## Windows 冷副本迁移准备

以下命令仅操作明确提供的冷副本和全新本机导出目录，不会搜索生产目录、读取凭据、连接服务或上传。必须先正常停止 Windows 日历，并通过既有安全备份或受控流程得到完整一致的独立 SQLite 副本。禁止运行中只复制主 sqlite 文件而漏掉 WAL 已提交内容；工具拒绝旁边仍有 -wal/-shm/-journal 的输入，不会替你截断边车或修复源库。

先构建工具：`npm run build:tools`。示例路径均为虚构，实际执行前由操作者明确指定：

```powershell
node dist-tools/migration.mjs export --source-db "C:\Migration\stopped-copy\planner.sqlite" --output-dir "C:\Migration\cloud-export-001" --stopped-copy-confirmed yes
node dist-tools/migration.mjs verify --bundle-dir "C:\Migration\cloud-export-001"
```

导出工具先对输入做流式 SHA256，在私有工作目录制作独立工作副本，仅对工作副本打开只读 SQLite 事务。这样避免 SQLite 即使 readOnly 打开 WAL 模式文件也在源目录创建边车。检查 user_version、integrity_check、planner/ledger Schema、关系和金额；前后再次核对源 hash，原源文件与源目录保持不变。

输出仅有 `safe-backup.json` 和 `manifest.json`。前者沿用现有 `ultimate-calendar-safe-backup` v1 格式；后者包含文件 SHA256/字节数、脱敏前后实体及账目计数、正式关联摘要，并明确目的地必须新服务实例、不复用旧设备/凭据/传输回执。保留 task/block/course/goal/candidate/source 的内部 ID 与关系、正式账目/AA 关联/账户资金变化/余额快照/审计结构；剥离 QQ 原文附件、captureRef 电脑标识、来源图片及文本、账目 originalText。正式事项与账目本身仍属私密文件，不能提交 GitHub。

verify 同时复用 validateSafeBackup 的 Schema/金额/关系校验，核对 manifest，并拒绝重新夹带的原始输入。checksum 只能检测包与 manifest 不一致，不是签名、网络授权或数据真实性认证。

只有核验后才可由操作者显式选择使用已有服务 restore 命令恢复到**新或空目录**；恢复创建新的 dataInstanceId/generation=1，旧浏览器必须重新配对。不能把 manifest 标记当成已经部署或完成迁移。本工具不提供自动上传、生产覆盖、双库拼接、API Key 迁移或 QQ 采集原文迁移。回退保留原冷副本和原 Windows 正式目录，不改写任何一份；恢复也不覆盖已有服务目录。
