# 终极日历 · Ultimate Calendar

把群通知、课表、任务和日常记账放在一起的 Windows 桌面应用。用中文和时间助手对话，先看清需要做什么，再决定如何安排。

[下载 Windows 安装包](https://github.com/Albert071006/ultimate-calendar/releases/latest) · [反馈问题](https://github.com/Albert071006/ultimate-calendar/issues) · [MIT 许可证](LICENSE)

## 功能

- **日历与课表**：按分钟定位和调整时段，显示当前时间；支持教学周、节次、单双周和重复活动，以及“仅本次 / 本次及以后”的修改、取消。
- **通知整理**：手动导入消息，或选择 QQ 群在本机采集；AI 提取行动、收益、活动时间和截止时间，整理为待判断卡片，由你接受、忽略或稍后决定。
- **任务与目标**：固定活动和执行时段统一显示已有安排；超过截止或时段结束的未完成事项保留在待办中，以橙色提示调整时间、完成或移除，完成记录在日历中淡色保留。
- **中文时间助手**：结合对话上下文查询、创建和修改日程、任务与账目；需要核对的修改先展示预览。
- **本地记账**：账户总览、收支统计、明细和 CSV 导出；分别记录实际付款与个人开销，支持 AA、代垫、退款、报销、转账和余额快照。
- **AI 设置**：配置自己的 DeepSeek API Key，查看可用模型、价格、账户余额和调用记录。
- **应用内更新**：在设置中检查 GitHub 正式版本，下载完成后安装并重启；本机资料与凭据继续保留。
- **空间管理**：查看占用、调整备份和已处理 QQ 附件的保留规则，预览清理内容；正式账单、任务和课表保留。

已发布桌面版面向 Windows x64，以北京时间处理日程和账目。当前源码新增手机网页与资料服务的本地开发入口，尚未部署、迁移个人资料或随正式安装包发布，详见下文。微信采集尚未提供。

使用其他 agent 制定计划，可在 Windows“导入计划 → 导出忙碌时间”选择日期并导出课表、活动占用，让 agent 按 [计划 JSON 与上下文标准](docs/plan-file-format.md) 生成完整 v1 新目标（目标、任务、全部时段及资料一次导入）。已有目标可从列表或详情“导出给外部智能体”保存上下文，agent 返回携带原状态标记的 v2 增量文件。两种计划均从“导入计划”预览后保存，支持去重和失败续导；v2 还会检查来源与原计划状态变化，无需再次调用 AI。[完整计划示例](docs/examples/study-plan.calendar-plan.json) · [忙碌文件示例](docs/examples/planning.calendar-busy.json) · [v2 补录示例](docs/examples/guarded-supplement.calendar-plan.json) · [Agent 规划与高级接口规范](docs/agent-planning-guide.md)。

## 开始使用

1. 在 [Releases](https://github.com/Albert071006/ultimate-calendar/releases) 下载 `UltimateCalendar-Setup-*.exe`，安装时可选择目录。
2. 打开设置，填写自己的 AI 服务配置；不配置 API Key 也可手动管理日历、任务和账单。
3. 按自己的学期设置教学周、节次和课表。公开版本没有预置私人课表、账单或群名单。
4. 如需 QQ 自动采集，另行准备本机 OneBot 兼容桥接服务，再在“QQ 采集”中连接并选择群。

0.3.2 及更早版本需要手动安装 0.3.3 或更高版本一次，之后可在应用内完成更新。更新安装会重启日历；QQ 客户端和桥接程序保持独立。安装包当前未购买代码签名证书。

QQ 桥接组件和 QQ 客户端不包含在安装包中。此功能依赖本机桥接服务及 QQ 版本的兼容性；连接使用本地地址和访问令牌，默认关闭采集。语音、视频不做内容分析。

文件支持 PDF、Word、Excel、PPT 和纯文本；旧版 DOC/PPT 需要额外安装 LibreOffice，可通过 `PLANNER_LIBREOFFICE_DIR` 指定其安装根目录或 `program` 目录。扫描件和图片依赖所选 DeepSeek 模型的视觉能力，没有本地 OCR；模型不支持或内容缺失时提示人工查看。详见 [附件解析说明](src/capture/documents/README.md)。

提醒需要应用保持运行；退出、关机或休眠期间无法即时通知。助手使用最近 20 条已完成的对话作为上下文，重启后聊天显示会清空；已保存的日程和账目仍保留。账本目前提供六类预设账户，不包含完整的信用卡负债管理。AI 暂不支持任意自定义服务地址。

## 数据与隐私

- 日程、任务、账单等保存在本机 SQLite 文件中，默认数据目录为系统“文档”下的 `终极日历/数据`，备份默认为同级 `终极日历/备份`。旧 AppData 数据通过首次兼容迁移保留，避免不同启动环境读到两套资料；备份、导出和历史操作可在应用中管理。
- 自动清理只处理可识别的旧备份和不再被进行中事项引用的已处理 QQ 附件；必要的最新有效备份和正式记录保留。容量目标不会强制删除受保护资料。备份／恢复不再受 512 MiB 整体文件上限限制，详见 [空间管理说明](docs/storage-management.md)。
- API Key 和桥接令牌通过 Electron 的系统加密存储保存，不写入源码。请勿提交自己的数据库、凭据、备份或聊天附件。
- **本地保存不代表 AI 完全离线**：启用 AI 时，处理所需的消息、附件内容或相关日历、账本上下文会发送给 DeepSeek，产生相应 API 费用。
- 新账本不会自动生成生活费收入；周期收入需自行启用和配置。亲情卡额度不计收入或资产，未提供真实余额时显示未知。
- 本仓库只包含应用源码与合成测试数据；每位使用者从自己的空白资料开始。

## 本地开发

需要 Windows、Git 和 **Node.js 24 或更高版本**。

```powershell
git clone https://github.com/Albert071006/ultimate-calendar.git
cd ultimate-calendar
npm ci
npm run dev -- --planner-profile="$env:TEMP\ultimate-calendar-dev"
```

`--planner-profile` 将开发数据放入指定目录，便于和日常使用的数据隔离。不要在测试配置中填写真实密钥或连接真实群。

`npm ci` 会下载 Electron 运行时，需要能访问其官方发布源。如果安装时主动跳过了脚本，启动前运行 `node node_modules/electron/install.js` 补齐运行时。

```powershell
npm run typecheck
npm test
npm run build
npm run package
```

安装包和解包应用生成在 `release/`。同次构建还生成 `latest.yml`、`.exe.blockmap` 和 `SHA256SUMS.txt`，并校验版本、文件大小及 SHA-512/SHA-256。打包脚本始终只打包，即使环境中存在 GitHub 令牌也不会发布；可选用 `PLANNER_INSTALLER_COPY_DIR` 指定安装包额外复制目录，`ELECTRON_BUILDER_CACHE` 指定构建工具缓存。

应用冒烟测试使用独立临时资料和模拟 QQ 服务，不调用付费 AI：

```powershell
npm run build
npm run smoke
node scripts/document-smoke.mjs --no-legacy
```

部署 LibreOffice 后，可省略 `--no-legacy` 验证旧 Office 格式。报告保存在 `test-results/`。验证打包应用时，先设置 `PLANNER_SMOKE_EXE` 为 `release\win-unpacked\终极日历.exe` 的绝对路径，再执行 `npm run smoke`。

## 手机网页与资料服务（本地开发）

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

同一网页服务的两个浏览器／设备访问同一份日历与账本；生活助手在资料服务调用 DeepSeek。没有 API Key 时仍可手动管理资料。原生 Electron 默认继续使用本地资料，也可明确启动独立配置的云端模式：由主进程连接同一服务，不创建第二份正式数据库。QQ 提炼桥可把 Windows 已提炼候选可靠发送到服务，原文和附件留在采集电脑。所有切换、部署与历史资料迁移均需单独操作，构建不会自动执行。[架构决定](docs/adr/0001-always-on-planner-service.md)说明资料归属。

后端开发与前端交接入口：

- [后端 API、回执和离线规则](docs/backend-api.md)：前端接入时以实际 Schema 为准。
- [Windows 云端模式](docs/windows-cloud-mode.md)：独立 profile、加密凭据、丢失响应核对和本机能力边界。
- [QQ 提炼发送桥](docs/qq-cloud-bridge.md)：明确来源、隐私白名单、持久队列及自动重试。
- [服务运维](docs/backend-operations.md)：启动、健康检查、备份失败、正常退出和部署样例。

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
| `--api-key-file` | 可选，受限权限的绝对路径文件；否则从 `DEEPSEEK_API_KEY` 环境变量读取。密钥不进入网页、会话响应和安全备份。不要把密钥作为命令行实参。 |
| `--backup-dir` | 可选，安全备份的绝对目录；不能是资料目录或其上级。默认是资料目录同级的 `<资料目录名>-backups`。 |
| `VAPID_SUBJECT` | 可选，Web Push 所需的显式联系邮箱（`mailto:`）或 HTTPS 联系地址。未配置时推送明确禁用，不伪造默认地址。 |

服务严格核对 Host 和 Origin。所有业务接口先鉴权；写请求必须来自同一来源并携带 `x-csrf-token`，配对接口除外。仅开放日历、任务、候选、生活助手和账本的方法；更新、Windows 文件对话框、API Key 设置及本机备份恢复不开放给网页。普通 RPC 请求体限制为 15 MiB，提炼导入为 1 MiB。Linux 服务目录为 0700，服务自身数据库和安全备份为 0600；CLI 另设 umask 077。

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

## 版本发布

仅在明确要求上传或发布时执行以下流程；日常本机修改按影响范围验证，不自动推送或发布：

1. 同步修改 `package.json` 与 `package-lock.json` 的版本，编写 `docs/release-notes/<version>.md`，说明本次变化。
2. 执行类型检查、测试和打包验证，将源码提交到 `main`。
3. 给该提交创建 `v<version>` 标签并推送到 GitHub。标签必须与包版本一致，只支持正式版本。
4. Windows release 流水线再次检查、构建、执行隔离冒烟测试、验证附件，然后创建草稿。四个附件全部上传且与 GitHub 返回的校验值一致后，才公开为正式版。

流水线使用仓库内置 `GITHUB_TOKEN`，无需配置个人访问令牌。普通本地打包不会上传文件，已发布的安装包不覆盖；发布中断时草稿保留，重新运行同一标签可恢复。更新说明和测试数据不得包含私人信息。维护约定见 [AGENTS.md](AGENTS.md)。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `src/renderer` | React 界面、日历交互、对话与设置 |
| `src/electron` | 桌面窗口、IPC、凭据和系统集成 |
| `src/domain` / `src/application` | 日程、任务、重复活动与操作记录 |
| `src/storage` | SQLite 持久化与备份 |
| `src/server` | 常在线资料服务、配对与回执、提炼导入、推送及安全恢复 |
| `src/remote` / `src/bridge` / `src/migration` | Node 远程传输、QQ 提炼发送队列、冷副本迁移准备 |
| `src/ai` | 模型请求、自然语言操作和记账解析 |
| `src/capture` | QQ 采集、附件下载与文档解析 |
| `src/ledger` | 账本、余额、汇总和更正逻辑 |
| `src/shared` | 数据类型与校验规则 |
| `scripts` / `tests` | 构建、验收和集成测试 |

## 贡献与许可

欢迎通过 Issue 描述问题，或提交 Pull Request。提交前请运行类型检查、测试和构建；复现材料请使用虚构数据并移除密钥、QQ 账号和私人账目。

项目采用 [MIT](LICENSE) 许可证。第三方依赖遵循各自许可证；Tabler 图标与界面宋体（Noto Serif SC 子集，SIL OFL 1.1）的声明保留在 [public/third-party](public/third-party)。宋体子集由 `npm run font:subset -- <Noto Serif SC 字体文件>` 生成。
