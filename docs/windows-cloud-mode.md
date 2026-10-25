# Windows 日历连接资料服务

Windows 使用本机打包界面，由 Electron 主进程访问同源 HTTPS 资料服务。日历、课表、账本、共享设置和生活助手共用云端；QQ 采集、原文、附件及 Windows 系统功能继续由本机处理。云窗口不会加载带 Electron 权限的远程网页，也不会自动迁移原本机资料。

本文描述源码行为和通用配置，不证明某台机器已安装、迁移或完成真实手机验收。HTTP 契约见 [backend-api.md](backend-api.md)。

## 两条访问路径

| 能力 | 实际处理位置 |
| --- | --- |
| 日历/课表/任务、待判断、账本、助手、共享设置 | 云端正式资料服务，经主进程 HTTPS RPC |
| 云端 Key、模型、余额、价格 | 云端配置与账户服务；Key 不返回界面 |
| CSV/XLSX 选择与解析、截图选择、导出保存位置 | 本机文件对话框；课表文件本身在本机解析 |
| 安全备份导出及恢复 | 云端生成/替换共享资料，本机选择保存或上传经过清理的安全包 |
| QQ 连接、群列表、消息、批次、分析、清理 | 本机采集进程，经受保护的 named pipe |
| 来源原文与附件 | 本机采集进程按 ID/私有索引定位；不经过云端 |
| 本机空间策略和清理 | 本机采集进程；不会清理服务器资料 |
| 托盘、关闭到托盘、开机启动、Windows 提醒、应用更新 | Windows 主进程 |

云模式不再统一拒绝本机管理入口。它把本机请求交给已有采集进程，避免云窗口另开一个正式 SQLite 写入者或第二条 QQ 采集连接。界面到主进程仍经过 IPC 来源和参数校验；本机管道没有新增 HTTP 端口或任意文件读取接口。

## 配置与启动

先准备资料服务、显式迁移核验或合成资料，并安装含上述能力的构建。正式迁移仍应先备份和正常退出旧普通日历；不能运行中复制主 SQLite 而漏掉 WAL。

以下路径全部为通用示例，必须替换成操作者明确选择的实际路径：

- 独立云 profile：`C:\Software\CalendarExample\cloud-profile`。不得与本机正式资料目录相同、互为父子，或已含 `planner.sqlite`。
- 云配置：`C:\Software\CalendarExample\cloud-config.json`。

```json
{
  "origin": "https://calendar.example.org",
  "deviceName": "Windows 日历",
  "pairingCodeFile": "C:\\Software\\CalendarExample\\pairing-code.txt",
  "localDataDirectory": "C:\\Users\\Example\\Documents\\终极日历\\数据"
}
```

`origin` 必须是 HTTPS 根地址，不含账号、密码、查询参数或额外路径；仅 localhost 测试可用 HTTP。`localDataDirectory` 可省略；填写时必须精确指向这台电脑经应用解析的正式资料目录，用于连接本机采集服务，不能指向任意另一份数据库。已安装 Windows 构建配置此目录后启用托盘、系统提醒、更新及采集进程启动；隔离开发/冒烟 profile 不操作系统开机启动、不创建通知或采集后台进程。

管理员通过服务 CLI `pair` 生成短期配对码，放入只由当前用户访问的文件。不要把码放进命令参数、截图、日志或仓库。显式启动示例：

```powershell
& "C:\Software\CalendarExample\app\终极日历.exe" "--planner-profile=C:\Software\CalendarExample\cloud-profile" "--planner-remote-config=C:\Software\CalendarExample\cloud-config.json"
```

开发时可在构建后用 `node_modules/.bin/electron .` 代替 exe，但不应借开发启动验证真实系统功能。首次启动使用 `pairingCodeFile` 配对，以后读取云 profile 内 safeStorage 加密的 `credentials/remote-device.bin`。加密、解密、授权或目录核验失败会报错，不会改存明文凭据或退回旧本机正式库。确认配对后可移走短期配对码文件，无需重新填写有效的云端 Key。

### 通过已有 SSH 通道连接

已由操作者配置好 SSH 本地转发时，可在云配置中增加 `"localConnectAddress": "127.0.0.1"`。例如已有通道把本机 `127.0.0.1:443` 转发至资料服务器的 HTTPS 端口，此字段让 Node 客户端直接向该本机端口建立 TCP 连接，避免 DNS/hosts 的多个解析结果使请求选回另一条路径。它只接受字面值 `127.0.0.1`，且要求 HTTPS；连接端口仍取 `origin` 的端口，未填写则为 443。

`origin` 继续填写原服务的 HTTPS 域名，不能改成 `https://127.0.0.1`。请求 URL、HTTP Host、Origin、TLS SNI 和证书主机名校验均保留原域名；证书链和主机名验证不会关闭。Cookie、CSRF 和配对凭据仍绑定原服务，所有重定向均拒绝。这个选项只影响桌面 Node 客户端的 TCP 目的地址，不改变手机或浏览器的连接。

应用不会建立或修复 SSH 通道，也不修改 hosts、Tailscale Serve 或网络策略。通道未就绪、断开或证书验证失败时请求报错，不自动改走 Tailscale。恢复连接应先恢复已有通道；要回到普通域名解析连接，可移除此字段并正常重启云窗口，原配对和资料无需重建。

### 普通快捷方式与默认连接

应用在**没有任何显式 `--planner-...` 参数**时读取系统文档目录内 `终极日历/desktop-connection.json`，用于保留用户选择的资料来源，例如：

```json
{
  "profile": "C:\\Software\\CalendarExample\\cloud-profile",
  "configFile": "C:\\Software\\CalendarExample\\cloud-config.json"
}
```

两个值均须绝对路径，仍会经过云配置/目录校验。它只保存配置位置，不保存 Key、Cookie 或配对码。这样安装器重建无参数快捷方式、开机启动时仍选择云端；文件不存在且没有显式云参数时才走原本机模式。错误配置会明确报错，不应被当作自动退回旧库的理由。显式 profile、remote-config 或 capture-only 参数优先，不叠加默认连接。

## 共享设置与设备设置

设置保存发送 `{settings,expectedSettings}`，期望值来自打开表单时的原始共享快照。服务器串行比较共享字段；手机或另一窗口先保存后，旧表单返回冲突，需重新打开核对，不能静默覆盖。

`closeToTray`、`autoLaunch` 保存在云 profile 的 `device-settings.json`，不会作为跨设备设置覆盖另一台电脑。云端比较忽略这两项；Windows 快照显示本机值。其他模型、地点、学期、提醒规则等共享字段仍由云端保存。

生产 Windows 使用一个托盘入口：日历窗口运行时由云界面管理，菜单提供打开日历、采集状态及启动/停止采集。退出日历并保留采集时，入口交给采集进程，仍可从托盘重新打开日历。停止采集只退出日历自己的后台服务，不退出 QQ 客户端。云界面通过认证本机管道续租托盘归属；若云界面异常退出，采集进程在租约到期后恢复入口。托盘控制只供主进程使用，不向网页或 renderer 开放。

云窗口不是 Windows 离线编辑模式：断网不能宣称已保存，只有服务确认才算提交。聚焦及约 30 秒轮询触发共享快照刷新，不承诺即时跨设备同步。

## 云端 Key 与账户

「我的 → AI 与费用」管理与手机相同的云端配置。`snapshot.keyStatus.scope` 标识云模式；打开密钥面板、窗口重新聚焦、空闲时每 5 秒及手动刷新，通过 `retryApiKey` 读取 `/api/v1/ai/config` 的状态和 revision，不返回旧 Key。填写新 Key 或确认删除期间保留原先观察到的 revision，并发更改交由版本冲突保护。

`setApiKey` 必须带上已读取的 `expectedRevision`，由主进程发送 PUT 或 DELETE，保留会话、身份、CSRF、同源和 TLS 校验。它不调用旧 `/rpc/setApiKey`，不进普通写入日志；冲突不覆盖，结果不明先重读，不自动重发。云端确认成功后，主进程通过认证管道触发 `captureRefreshApiKey`，由采集进程读取获授权的加密配置；不会把界面输入直接交给采集进程。同步尚未完成时显示等待状态，云端修改不重发，用户无需重复保存。

`accountSnapshot` / `refreshAccount` 读取云端模型、余额和价格；首次读取等待账户刷新，资源错误单独显示。Key 已配置不等于供应商验证成功或余额充足。手机和 Windows 共用这一份云端配置；完成下述 receiver 授权后，从任一端保存、轮换或清除 Key，采集进程都会自动同步，本机副本由系统加密保存。QQ 原文、附件和来源索引保留在采集电脑，不会为获取密钥上传资料服务。

QQ 分析因明确 `AUTH`／`NO_API_KEY` 自动暂停时，会持久记录“等待密钥”；新 revision 同步并安全保存后清理旧错误、恢复分析，并只重试对应的明确凭据失败批次。手动暂停、点击“停止等待密钥”或解除账号绑定会取消自动恢复，后续密钥轮换不会擅自开启。余额、限流及结果未知的失败仍需人工核对，不自动重试；同一 revision 的轮询或重启不会重复唤起已拒绝的密钥。清除密钥只暂停新分析请求，QQ 继续收集，已发出请求的结果仍会保存。

采集快照通过 `analysisWaitingForKey` 和 `cloudKeySync` 提供等待标记、同步 revision、时间及状态；界面显示同步结果与等待原因，不显示密钥。云端桌面只在采集页挂载期间每 2 秒读取本机状态，离页停止；读取和操作响应有顺序保护，过期响应不能覆盖新状态。后台密钥同步由采集进程负责，不依赖采集页保持打开。

### 首次授权采集电脑接收密钥

receiver 是独立的密钥接收授权，普通设备配对和 `localDataDirectory` 配置不会自动授予它。管理员需在受控服务器目录中，按 `AiKeyReceiverConfigurationSchema` 为已配对采集设备登记 `deviceId`、RSA-3072 公钥及其 `keyId`，并可设置到期或撤销；没有供浏览器自行登记公钥的 HTTP 接口。服务器默认从资料目录的 `ai-key-receivers.json` 读取，修改授权无需重启。外部管理员文件／环境提供的 Key 不允许通过这个通道分发。

采集目录的 `credentials/cloud-key-sync.json` 指定同步服务及该采集设备已有的凭据文件。以下仍是通用路径示例，凭据文件需由受控配对流程准备，不能把浏览器 Cookie 填入配置：

```json
{
  "version": 1,
  "origin": "https://calendar.example.org",
  "credentialsFile": "C:\\Software\\CalendarExample\\collector-device.json"
}
```

采集进程首次创建本机 receiver 私钥和对应的 `credentials/cloud-key-receiver-public.json`。管理员只使用公钥文件中的公钥及 keyId 建立服务端绑定；`cloud-key-receiver.bin` 私钥文件、云端设备凭据及 `cloud-key-receiver-receipt.bin` 应用收据均不上传公开仓库。私钥和收据使用本机系统加密，不能当作可跨电脑复制的授权文件。密钥同步配置存在但无效时会明确报错，不回退到旧 Key 或明文存储。

启动、约 10 秒后台轮询及每次模型请求前，采集进程通过 `POST /api/v1/ai/receiver/sync` 获取加密信封。它校验资料 identity、设备、公钥标识、随机 nonce、revision 和认证标签，先安全落盘再通知分析服务；接收过程不会调用收费模型来测试 Key。网络或授权失败时保留原文件和待处理分片，停止发起新模型请求并退避重试，最长间隔约 60 秒；已完成的付费分片不重发。详细信封和错误契约见 [backend-api.md](backend-api.md#采集电脑加密同步)。

## 课表、导出与恢复

课表 CSV/XLSX 由本机主进程选择、最多读取 10 MiB，再按最新云端学期设置解析，文件本身不上传；显式选择的 PNG/JPEG 可以经既有来源接口上传分析。预览课程和不完整行仍需用户核对采用，不把解析成功当作正式课表已经保存。

账本导出取云端完整数据，不从界面快照拼装。JSON 含所有月份与完整余额/规则/审计，CSV 可按月筛选；用户选择本机保存位置。普通账本 JSON 可能含来源字段，本身不是安全恢复包。

「备份」下载完整 `ultimate-calendar-safe-backup` v1 JSON，去掉来源原文/图片/QQ 定位信息、候选引用及账目/审计 `originalText`，不含 Key、会话或本机原文索引。它包含私密正式日历和账本，仍不得上传公开仓库。内容上限 8 MiB UTF-8，JSON 转义后上限 16 MiB；超限失败，不截断。服务器路径保持内部使用，Windows 显示的是用户实际选择的导出路径。

恢复只接受安全备份 JSON。主进程先在本机校验、清理原文后才上传，旧本机 SQLite/完整备份不会上传。无待核对写入时先取得服务预览，再由用户确认；预览绑定当前设备、文件摘要、当前云端资料和 identity，10 分钟有效。预览后资料改变、还有写入正在执行或恢复前备份失败都会拒绝替换。

确认先在服务器保存当前资料备份，再推进 generation，并在一个业务库事务中替换日历和账本、清理旧重放操作。Key 和配对会话保留，本机原文/附件不变。只有成功的专用确认响应会更新发起电脑的身份；其他设备的旧代际/离线队列受保护，不会自动重放到恢复后的资料。

恢复确认不进入普通 write journal，也不能自动重试。超时或异常后先核对服务状态和现有资料；服务器以 processing/completed/interrupted 记录状态，重启时未完成的 processing 会变为 interrupted。代际与业务库不能跨数据库原子提交，异常时可能出现旧资料配新代际，不能假称恢复成功。详细契约见 [backend-api.md](backend-api.md#完整导出与受控恢复)。

## QQ 采集、原文与空间管理

迁移后，共享资料服务是正式任务/课表/账本的编辑入口。本机原库保留给采集和原文，不应另开一个仍编辑旧本机日历的普通窗口；提炼桥不会合并两份日历或账本。

采集专用模式 `--planner-capture-only` 要求已有本机 `planner.sqlite`，不能同时使用 remote-config，不会新建空正式库或打开普通日历窗口。云窗口配置 `localDataDirectory` 后连接现有采集进程；已安装 Windows 构建发现其未就绪时可启动同一程序的采集专用进程。

```powershell
& "C:\Software\CalendarExample\app\终极日历.exe" --planner-capture-only "--planner-profile=C:\Users\Example\Documents\终极日历\数据"
```

采集进程拥有本机数据库和 QQ 连接。云窗口通过随机实例 named pipe 调用采集状态、配置、连接、群/消息/批次、处理/清理、原文查看及空间策略；管道使用本机系统加密的端点描述符、请求 token 与服务证明核验，不开放 TCP 管理端口。空间页反映并清理本机采集/附件/备份，不表示服务器容量或删除云端资料。

Windows 端点描述符保存在本机采集目录的 `credentials/collector-control.bin`，使用当前 Windows 用户的 DPAPI 加密。采集进程和云窗口需由同一 Windows 用户运行；它们可以使用不同 Electron profile，不再依赖二者各自的 Chromium profile 加密密钥相同。这项调整只用于本机管道描述符，云端配对凭据及已有本机提炼 Key 仍沿用各自的凭据存储。

连接时主进程先验证采集服务的随机挑战证明，再发送管道请求 token 或用户填写的 QQ 连接 token；端点描述符和管道凭据不会返回界面或发送云端。本机采集请求只走这个受保护的管道，服务不可用时明确报错，不回退到云端 RPC；QQ 连接 token、本机提炼 Key、原文和附件不会因此进入云端。旧描述符不保证能跨 profile 解密，应正常退出原采集进程并由新构建重新启动，不能通过删除运行中端点文件或复制凭据绕过校验。

独立发送桥读取已提炼的候选字段，用独立 outbox 和设备凭据按稳定标识上传。配置/配对与云窗口分开；离线保留提炼队列，身份/代际改变时停止并核对，不自动迁入新代际。工具构建与检查示例：

```powershell
npm run build:tools
node dist-tools/bridge.mjs check --config "C:\Software\CalendarExample\bridge.json"
```

通过检查后再按操作者选择运行 `once` 或 `run`。桥接配置严格按 `src/bridge/config.ts`，不会上传 QQ 原始数据库、原文、附件、旧任务或账本。

发送桥在本机 `credentials/qq-evidence-index.sqlite` 保存云端 sourceId 与本机候选/来源的关联。Windows 查看依据时，旧迁移来源按相同 ID，新提炼来源按索引精确查找；这些私有 ID/关联不随提炼请求上传，不按标题猜测原文。索引未建立或原文已清理会明确显示找不到。手机仅能看到提炼结果，不能通过这个本机 IPC 读取原文。

退出采集服务应使用其托盘退出项或受控正常退出流程，等待正在处理的任务和数据库收尾；不要强杀、替换运行中的数据库或关闭 QQ 来结束采集。退出云窗口不等于退出采集或发送桥。

## 提醒和更新

Windows 提醒读取成功返回的云端快照，使用独立 profile 内按资料 identity 分区的游标和收据；不会打开本机正式日历库。通知经系统实际显示后才记已展示；网络/身份失败保留游标，后续成功读取时继续检查。此能力依赖 Windows 日历进程运行及系统通知支持，不替代手机 Web Push，也不承诺电脑关机时本机通知。

云模式提供检查、下载、安装更新入口，仍遵循现有更新状态与忙碌保护。安装前取得并核验当前云端安全备份、保存在独立 profile，再请求采集进程正常退出并等待完成；任何一步失败均不继续安装。更新过程不关闭 QQ；失败后按现有流程恢复采集。隔离 profile 不触发真实安装或系统功能。

## 丢失回执与身份保护

普通写入前，云 profile 的 `remote-write.json` 保存 requestId、业务 operationId、身份和请求指纹，不保存原文或图片；一个未核对写入阻止不同的新写入。重试同一意图保留原编号，已完成则取原回执；processing/interrupted 不自动再执行。

菜单「终极日历 → 核对云端操作」查询原请求，先刷新核对业务结果，再决定是否解除保护。只有已完成或明确 interrupted 才允许用户解除，并保留 `.last-acknowledged` 元数据；unknown/processing 不能直接清除。不要手工删除日志、修改 generation，或换新 profile 后照抄旧操作。

账户读取、导出和恢复预览不进普通写入日志；Key 配置及恢复确认使用独立、不自动重试的流程。Cookie/CSRF 只在主进程使用，重定向被拒绝，凭据绑定 origin、设备、资料实例与代际。safeStorage 凭据不能当作跨电脑登录文件复制；原文、凭据、备份、索引和诊断资料都应留在受限本机目录或受控服务存储中。

部署验收需分别确认 HTTPS/配对、任务与账本双向修改、本机采集和原文关联、设置冲突、导出恢复预览、系统提醒及更新保护。源码具备接口不等于这些环节已在用户设备上验收。
