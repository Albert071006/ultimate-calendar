# QQ 提炼发送桥

此工具把 Windows 采集端已经生成的候选摘要发送到资料服务。它不连接 QQ、不启动或修改 QQ-agent、不操作 QQ 客户端，也不调用 AI。采集、附件解析与 AI 提炼仍由 Windows 私有采集进程完成；云端原生服务不承担 QQ 采集。

桥只读打开明确配置的 SQLite 文件，不发现或猜测正式资料位置，不初始化、迁移、恢复或修改该文件。切换专用采集进程时，应先正常退出原桌面进程，并沿用采集端的单实例锁规则，避免两种业务模式同时编辑旧资料。桥本身不切换模式。

## 配置与运行

需要 Node.js 24 或更高版本，以及已经构建的 `dist-tools/bridge.mjs`。在源码目录执行 `npm run build:tools`；该命令不发布、不上传资料。

先使用远程客户端工具为采集设备单独配对，保存本机私有凭据文件。桥只读取已有凭据，不生成配对码、不自动重新配对，也不把授权 Cookie 放进发送队列。根据配对结果填写 `identity`、`deviceId`。

配置文件示例中的路径、域名和身份均为占位示例，必须显式替换；不要直接指向不准备发送摘要的资料文件。

```json
{
  "version": 1,
  "enabled": true,
  "sourceDatabase": "C:\\Software\\CalendarBridgeExample\\synthetic-local.sqlite",
  "outboxDatabase": "C:\\Software\\CalendarBridgeExample\\outbox.sqlite",
  "credentialsFile": "C:\\Software\\CalendarBridgeExample\\device-credential.json",
  "origin": "https://calendar.example.org",
  "identity": {
    "protocolVersion": 1,
    "dataInstanceId": "11111111-1111-4111-8111-111111111111",
    "generation": 1
  },
  "deviceId": "22222222-2222-4222-8222-222222222222",
  "pollSeconds": 30,
  "scanBatchSize": 200,
  "maxPagesPerTick": 20
}
```

三个文件路径必须为绝对路径且互不相同。远程地址必须是无路径、查询参数、凭据的 HTTPS origin；HTTP 只允许明确指定的本机回环测试地址。配置默认不启用，运行要求 `enabled: true`。

```powershell
node dist-tools/bridge.mjs check --config C:\Software\CalendarBridgeExample\bridge.json
node dist-tools/bridge.mjs once --config C:\Software\CalendarBridgeExample\bridge.json
node dist-tools/bridge.mjs run --config C:\Software\CalendarBridgeExample\bridge.json
```

`check` 只检查配置，不打开采集库或连接远端。`once` 扫描并尝试发送一轮，发生待处理问题时退出码为 2；启动失败退出码为 1。`run` 持续轮询，按 Ctrl+C 正常停止。输出只有数量、队列状态和固定问题代码，不输出候选正文、原始异常、URL、Cookie 或本机路径。

## 允许发送的数据

数据以 `src/shared/distilled.ts` 的严格白名单为边界：标题、行动摘要、收益及类型、潜在收益、条件、不确定信息、截止日期/时间、活动开始/结束及地点，外加稳定的提炼标识和目标资料身份。

只扫描 `pending` 候选，且至少有一个来源包含内部 QQ `captureRef`。手动导入、忽略、已接受的本机候选不作为新提炼输入。QQ 分析流程在同一个 planner 事务中保存来源、规范化候选和 `qq-apply` 回执，因此不需要等待事务之后的采集批次状态标记。

SQL 只投影白名单字段，不读取来源正文、图片、原文引用、时间证据引用、附件内容、来源标签或附件定位信息。账号/群号仅从来源引用中临时取出用于本机隐私检查，不写入 payload、日志或 outbox。

白名单中的自由文本仍可能包含私密信息。隐私检查保守拒绝含已知 QQ 账号/群号、本机路径、UNC 路径、file/data/blob/HTTP/WebSocket 链接、CQ 片段或常见附件文件名的候选；超出协议长度或数组上限的候选也拒绝，不截断条件或悄悄删改原文。拒绝只计数，不保存被拒内容。需要在采集端核对并改正摘要字段后再次扫描。此检查是工程保护，不应把任意自由文本都当成已经匿名化。

## 去重、重试和恢复

白名单字段经过 Unicode NFC、首尾空白和对象键顺序规范化后计算内容 SHA-256。`distilledId` 为 `qqd_` 加内容 hash，不含本机候选 ID、来源 ID、账号、群号或路径。相同摘要即使来自不同本机候选、不同扫描轮次或重建 outbox，也得到相同提炼标识。

独立 SQLite outbox 保存单条严格提炼请求、内容 hash、稳定 requestId、重试时间和租约。扫描游标和新请求在同一个事务中落盘；扫描完毕回到起点，后续摘要更新也会被发现。发送前检查当前资料身份和设备身份。每次 HTTP 请求由远程 transport 限制在最多 30 秒，outbox 租约为 120 秒。

- 网络中断、429 和服务端暂时错误保留同一 requestId，指数退避，尊重有限的 Retry-After；不生成新 ID 重试。
- 服务已接收但响应丢失时，重启后仍发送相同 requestId 和内容。云端同时使用批次回执和稳定 distilledId 去重。
- 明确的内容校验错误或条目标识冲突进入 `blocked`，不修改原请求或无限重试该条；其他有效候选可以继续发送。
- 已确认收据保留在 outbox，Windows 本机候选即使继续保持 pending，也不会重复上传。
- outbox 绑定采集库路径的不可逆 fingerprint、远程 origin、资料实例/generation 和设备。变更绑定会拒绝打开旧队列，不能通过重新配对悄悄把旧请求发往新资料。保留旧队列供核对，为新配置指定独立 outbox。

不要删除 outbox 来处理网络错误。备份正在使用的队列应使用一致的 SQLite 备份方式，或停止桥后备份；不要只复制运行中的主文件而遗漏 WAL。

**摘要内容更新会生成新的待判断候选。桥不会自动修改云端已接受任务，也不会把本机的接受、忽略或删除同步成云端操作。**这是一条提炼导入通道，不是日历数据库的双向同步。云端用户仍要判断和接受候选。

## 集成接口

```ts
const bridge = runBridge(config, remote, { onStatus: summary => observe(summary) });
// 或 await runBridgeOnce(config, remote)
await bridge.close();
remote.close();
```

`remote` 使用 `createNodeRemoteClient({ origin, credentialsFile })`，提供规范化的 `origin`、`getSession()`、`sendDistilled(request, { signal })`。`createQQCloudBridge` 也提供手动 `once()`、`start()`、`stop()`、`status()`、`close()`，便于宿主接入；测试可注入 transport 和时钟。宿主停止时先等待桥停止并关闭，再关闭 transport。

Linux 下新 outbox 目录使用 0700，SQLite 主文件、WAL、SHM 使用 0600。Windows 下请把配置、凭据与队列放入受当前用户 ACL 保护的本机目录。原始 QQ 资料、凭据和 outbox 均不应进入公开仓库。
