# 手机网页与自托管资料服务

这份说明面向需要手机与电脑共用资料、并自行维护服务的开发者。普通 Windows 用户请使用[本地桌面版](local-desktop.md)，无需执行本页命令。独立本地版不接入资料服务；下文的 Electron 云端能力由标准版提供。

**从发布包部署**请先读[Linux 服务器与手机端部署指南](server-mobile-deployment.md)。[服务器版与手机端 Release](https://github.com/Albert071006/ultimate-calendar/releases/tag/server-v0.6.0) 提供已构建的后端、手机静态页和可选 Windows 标准版；以下内容主要用于源码开发与进一步理解接口。

需要 Node.js 24 或更高版本。以下命令只使用独立演示目录；不读取已安装桌面版的资料，也不会部署云资源或上传资料。

```powershell
npm run build:mobile
npm run build:server
$demo = Join-Path $env:TEMP 'ultimate-calendar-cloud-demo'
$assets = (Resolve-Path '.\dist').Path
node .\dist-server\cli.mjs serve --data-dir "$demo\data" --origin http://localhost:3210 --static-dir "$assets"
```

服务默认只监听 `127.0.0.1:3210`。在另一个终端生成一次性配对码，然后用 **Microsoft Edge** 打开 `http://localhost:3210`，填写配对码和设备名称：

```powershell
$demo = Join-Path $env:TEMP 'ultimate-calendar-cloud-demo'
node .\dist-server\cli.mjs pair --data-dir "$demo\data"
```

配对码由服务端命令生成，约 43 个随机字符、10 分钟有效、只能使用一次；只持久保存哈希，最多尝试 10 次。不要把配对码贴进日志、反馈或仓库。配对会话最长 30 天，使用 HttpOnly、SameSite=Strict Cookie；HTTPS 下另加 Secure。手机第一次安装到主屏幕后，应在独立 PWA 中再核对配对状态。

同一网页服务的两个浏览器／设备访问同一份日历与账本；生活助手在资料服务调用 DeepSeek。没有 API Key 时仍可手动管理资料。标准版 Electron 默认使用本地资料，也可明确启动独立配置的云端模式：由主进程连接同一服务，不创建第二份正式数据库。QQ 提炼桥可把 Windows 已提炼候选可靠发送到服务，原文和附件留在采集电脑。所有切换、部署与历史资料迁移均需单独操作，构建不会自动执行。[架构决定](adr/0001-always-on-planner-service.md)说明资料归属。

后端开发与前端交接入口：

- [后端 API、回执和离线规则](backend-api.md)：前端接入时以实际 Schema 为准。
- [Windows 云端模式](windows-cloud-mode.md)：独立 profile、加密凭据、丢失响应核对和本机能力边界。
- [QQ 提炼发送桥](qq-cloud-bridge.md)：明确来源、隐私白名单、持久队列及自动重试。
- [服务运维](backend-operations.md)：启动、健康检查、备份失败、正常退出和部署样例。

`npm run build:tools` 构建 `dist-tools/remote.mjs`、`bridge.mjs`、`migration.mjs`。`npm run smoke:remote` 使用合成资料启动编译后的服务和真实 Electron，检查桌面与网页双向修改、加密凭据及独立资料目录；不接触安装版资料或真实 QQ。

### 本机手机界面预览与离线队列

`npm run preview:mobile` 构建网页并在 `http://127.0.0.1:3321` 启动独立的虚构资料预览，终端显示一次性配对码。使用 Edge 打开；资料只写入被 Git 忽略的 `test-results/mobile-preview-*`，不读取安装版资料、QQ 或凭据。预览未配置真实 AI 和推送，按 Ctrl+C 停止。

手机采用五项底部导航、今天的上下排列、日／三日／月视图、底部详情面板和全屏编辑；沿用纸色主题。应用壳由 Service Worker 缓存，API 响应不会进入静态缓存。正式资料缓存和待提交队列保存在按资料实例、恢复代际及设备隔离的 IndexedDB 中。

断网时可暂存普通任务、单次时段、完成状态和普通支出草稿；删除、重复系列、候选决定、关联账目和 AI 请求需要连接服务。界面区分待提交、已确认、冲突与结果未知。账目草稿不计入正式余额；恢复连接及重新进入前台时先核对会话和原回执。存储未完成不会显示保存成功；已知失效的设备授权不会因断网恢复。

授权失效或资料代际变化后，有待提交操作的旧分区不会自动重放。用户可先导出私密恢复 JSON，再明确选择保留本机隔离档案后重新配对；档案可查看和再次导出。结果未知的操作必须先在原资料服务核对，不能直接复制成新操作。有待提交操作时禁止退出或清理缓存。

### 服务选项与访问保护

| 选项／配置 | 行为 |
| --- | --- |
| `--data-dir` | 必填，磁盘根目录以外的绝对目录；保存日历、账本及独立设备会话／请求回执。不会猜测 AppData 或加载 Windows 凭据。 |
| `--origin` | 必填，浏览器实际访问的完整来源，无路径；非本机来源必须为 HTTPS。仅 localhost／回环地址允许 HTTP 开发。 |
| `--host`、`--port` | 默认 `127.0.0.1`、`3210`；不默认开放全部网络接口。 |
| `--static-dir` | 可选，已构建 `dist` 的路径；必须与私有资料目录分开，不能互为上下级。只提供网页资源。 |
| `--api-key-file` | 可选，受限权限的绝对路径文件；其次读取非空 `DEEPSEEK_API_KEY` 环境变量；两者均未设置时由已配对手机管理 Key。外部供应源存在时手机只可查看配置状态，不能覆盖。不要把密钥作为命令行实参。 |
| `--backup-dir` | 可选，安全备份的绝对目录；不能是资料目录或其上级。默认是资料目录同级的 `<资料目录名>-backups`。 |
| `VAPID_SUBJECT` | 可选，Web Push 所需的显式联系邮箱（`mailto:`）或 HTTPS 联系地址。未配置时推送明确禁用，不伪造默认地址。 |

服务严格核对 Host 和 Origin。所有业务接口先鉴权；写请求必须来自同一来源并携带 `x-csrf-token`，配对接口除外。网页可管理日历、任务、候选、生活助手、账本及云端共享设置，另有受保护的 AI Key 配置和云端安全导出／恢复接口；Windows 更新、本机文件对话框与本机整库恢复不会开放为网页接口。普通 RPC 请求体限制为 15 MiB，提炼导入为 1 MiB。Linux 服务目录为 0700，服务自身数据库和安全备份为 0600；CLI 另设 umask 077。

### HTTPS 与 Tailscale

远程使用时让静态页面和 `/api/` 保持同源。将 `--origin` 设为浏览器看到的 HTTPS 来源，后端继续监听回环地址；HTTPS 代理必须保留该来源的 Host，透传 Cookie／Origin，允许 SSE 并关闭变更事件的响应缓冲。不要把私有资料目录配置成代理静态根目录，也不要通过放宽 Origin 来接入 Electron 的 `file://` 页面。

可在常在线资料服务所在机器使用 Tailscale Serve，把私有 HTTPS 入口代理到 `http://127.0.0.1:3210`；无需让 Windows 采集电脑成为中转点。配置需按实际机器验证，不由本地构建脚本自动修改。Serve 限于 tailnet，Funnel 会公开到互联网，本项目不自动启用 Funnel。[Tailscale Serve 文档](https://tailscale.com/docs/reference/tailscale-cli/serve)

HTTPS 证书的机器名／域名会进入公开证书透明度记录，选择不含个人资料的中性名称。Tailscale 网络准入继续叠加日历自己的设备配对，不能代替它。[Tailscale HTTPS 说明](https://tailscale.com/docs/how-to/set-up-https-certificates)

### 撤销设备、请求重试与原文

在网页“我的”中查看设备并撤销访问，或使用设备列表给出的 ID：

```powershell
node .\dist-server\cli.mjs revoke --data-dir "$demo\data" --device-id '<设备ID>'
```

退出配对或撤销设备同时停止该设备的推送订阅。发送中的提醒仍有网络交付的时间边界，不能承诺收回已经送达的通知。

写请求使用稳定 `requestId` 和资料实例／代际标识；同编号同内容重试返回原结果，不同内容拒绝。日程按实体版本、账本按整体修订号及单笔版本校验，不能用旧值覆盖新值。预览确认使用新的请求编号并保留原业务操作和确认凭据；重启后已失效的预览必须重新核对。服务重启把未确认完成的请求标成 interrupted，不自动重调 AI；客户端查询原操作后再处理，不能笼统承诺任何崩溃时刻都不会重复计费。

Windows 采集端只向 `POST /api/v1/distilled` 提交白名单提炼字段及稳定提炼编号；接口拒绝原文、引用原句、图片、附件、群／账号标识、路径和 `captureRef`，以占位来源关联候选。同编号重试不会重复创建候选。手机主动粘贴或上传的原文供服务端分析，成功后转为占位来源；失败或未处理内容到期清理，保留窗口为 24 小时（服务运行时定期扫描，重启补扫）。请求回执与安全备份不保留这些原始载荷。这里的清理是应用层保留策略，不是磁盘取证级擦除承诺。

### 安全备份与恢复边界

云端路径关闭桌面式整库自动备份，改为写后及每小时导出脱敏 JSON：保留正式日程、任务、课程、目标、候选、操作历史，以及账本流水、余额快照、关联、更正历史和规则；移除原文、图片、群消息引用及账本导入原始内容，不包含设备会话、推送私钥或 API Key。仅轮换自己识别且校验通过的安全备份，保留 7 份；未知文件不动。备份仍含个人正式资料，应保存在私有目录。

停止服务后可手动导出；`backup` 和资料代际调整受目录锁保护，不能与运行中的同资料服务并行：

```powershell
node .\dist-server\cli.mjs backup --data-dir "$demo\data"
```

可将本格式恢复到**全新或空目录**，目标的父目录须已存在。程序先严格校验全部日历／账本结构与关系，在同级临时目录写入并回读核对，再移动到目标；发现已有资料、校验不通过或目标途中改变就停止，不覆盖正式库，也不修改原备份：

```powershell
node .\dist-server\cli.mjs restore --backup-file '<安全备份JSON绝对路径>' --data-dir "$demo\restored-data"
```

恢复保留正式记录及关联，生成新的资料实例；不会恢复设备会话、API Key、推送私钥或传输回执。账本审计与更正记录保留，但旧账本操作的逐次撤销链不在此 JSON 格式中；恢复后的新账本操作仍可撤销。启动新目录后需重新配置服务端密钥、配对并授权推送，旧手机队列不能自动重放。原文已经从备份移除，无法恢复或重新分析；仅在需要时重新提供原始输入。管理员命令 `advance-generation --data-dir <绝对资料目录>` 只增加现有实例的代际，不恢复资料。Windows 资料迁移准备使用 `dist-tools/migration.mjs export` 从明确指定的停止写入副本生成安全 JSON 与核验清单，再用 `verify` 核对；它不上传、不覆盖源库，也不能将 JSON 直接覆盖运行中的 SQLite，详见后端接口文档。

推送还需目标 iPhone 安装到主屏幕、浏览器支持和用户授权；资料服务及其网络须保持可用，Windows 采集电脑可关闭。后台推送可靠性、PWA 安装、软键盘和触摸需真实 iPhone 验证，本机测试不代表这些已通过。桌面浏览器可在 Edge 验证两个设备会话的资料一致性：

```powershell
npx vitest run src/server/http.test.ts src/server/distilled.test.ts src/server/backup.test.ts src/server/restore.test.ts
```

