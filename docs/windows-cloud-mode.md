# Windows 日历连接资料服务

这是已实现的显式云端资料模式：使用本机受信任的已打包界面，由 Electron 主进程访问同源 HTTPS API。不是在带 Electron 权限的窗口里打开远程网页；也不会把原 Windows 日历资料自动搬到服务中。

## 准备与启动

先部署并核验资料服务，再执行本机迁移核验或建立合成测试资料。正式资料迁移的冷副本要求见 [backend-api.md](backend-api.md)。本模式自身不导入数据库、API Key、备份、QQ 原文或附件。

准备两个显式绝对路径文件，示例均为虚构路径：

- 云模式独立 profile：`C:\Software\终极日历\cloud-profile`。不得与正式资料目录相同、互为父子，或已含 `planner.sqlite`。
- 配置 JSON：`C:\Software\终极日历\cloud-config.json`。内容示例：

```json
{
  "origin": "https://calendar.example.org",
  "deviceName": "Windows 日历",
  "pairingCodeFile": "C:\\Software\\终极日历\\pairing-code.txt"
}
```

origin 必须是 HTTPS 根地址，不含账号、密码、查询参数或额外路径；仅 localhost 测试可用 HTTP。配对码由服务管理员的 `pair` 命令产生，短期有效，放入只由当前用户访问的文件。不要把码放进启动命令、截图、日志或公开仓库。

以下 exe 命令只适用于已安装本分支新构建的情况；当前用户安装版尚未替换，不能用旧版测试这些参数。开发时先在源码目录运行 `npm run build`，再以 `node_modules/.bin/electron .` 代替下面的 exe。安装新构建后，使用实际 exe 路径，例如：

```powershell
& "C:\Software\终极日历\ultimate-calendar\终极日历.exe" "--planner-profile=C:\Software\终极日历\cloud-profile" "--planner-remote-config=C:\Software\终极日历\cloud-config.json"
```

如实际安装的可执行文件名不同，替换为本机实际文件。首次启动使用 pairingCodeFile 配对；以后读取独立 profile 下 safeStorage 加密的 `credentials/remote-device.bin`。系统加密不可用、解密失败、授权不符时会停止或报错，不会写明文凭据或退回读取正式本机数据库。确认配对成功后可自行妥善移走短期配对码文件；不需要重复提供或重新填写 DeepSeek Key。

不传 remote-config 参数仍走原本机模式。普通启动不应误指向云 profile。服务身份或 generation 改变后，旧凭据不会自动连接新资料；先核对遗留操作，新的配对需要新的独立 profile，不能直接编辑旧凭据文件冒充新授权。

## 可用范围与保存状态

此模式通过经过校验的 IPC 转发 9 个 RPC：snapshot、mutate、undo、command、importSource、analyzeSource、ledgerSnapshot、ledgerMutate、ledgerUndo；另提供用户明确点击的 PNG/JPEG 截图选择。源文件仍由本机主进程校验，截图经既有来源接口提交。

QQ 采集、备份/恢复、API Key 设置、应用更新、任意文件/课表文件导入等本机管理 IPC 不在转发白名单。现有界面若仍展示这些入口，调用会被明确拒绝；不能把入口存在当作云端实现完成。前端后续由 Claude 接手重做。

云模式不打开本机正式数据库或 QQ 采集连接。它不是 Windows 离线编辑模式：没有网络时不能声称已保存；资料由服务确认后才算提交。窗口聚焦或约 30 秒轮询触发刷新；不承诺毫秒级跨设备刷新。

## 丢失回执与“核对云端操作”菜单

每次写入前，独立 profile 的 `remote-write.json` 先持久保存原 requestId、业务 operationId、身份和请求指纹，不保存消息文本或图片。一个尚未核对的写入会阻止不同的新写入；重开应用仍有保护。

同一意图再次提交，即使界面临时生成新的 operationId，主进程会保留原操作编号。已完成的操作读取原回执；尚无回执的操作才按原编号重试。`processing` 或 `interrupted` 不会自动再次执行。

菜单 **云端资料 → 核对云端操作** 可查询原请求。先使用“刷新”核对安排或账本，再决定是否解除保护。默认按钮为“保留保护”。只有已完成或明确 interrupted 的状态，菜单才允许用户明确选择“已核对资料，解除保护”；会保留 `.last-acknowledged` 元数据。未知/处理中不能直接清除。解除 interrupted 保护前尤其要确认服务中是否已有结果，避免重新创建重复任务、账目或重复收费。

不要为解除保护手动删除 remote-write.json、换新 profile 后照抄提交，或强行修改 JSON 中的 requestId/generation。

## 凭据与验收边界

Cookie 与 CSRF 只在主进程使用，不下发界面；HTTP 重定向被拒绝，凭据固定到原 origin、设备与资料实例/代际。Windows 凭据依赖 safeStorage 和当前账户，不能当作可跨电脑复制的登录文件。私密文件拒绝符号链接及硬链接复用；请为独立 profile 和配对文件使用当前用户的 Windows 目录访问权限。

已完成代码层的白名单、独立目录保护、传输与写入回执测试。`npm run smoke:remote` 也已用编译服务、真实 Electron 预加载接口及网页会话验证配对、任务双向读写、账本读取、加密凭据、无本地正式数据库和正常退出。以上均为合成资料，不代表已安装或切换用户的正式日历，也不代替真实 iPhone 与云端网络验收；未经用户明确迁移和发布指令，不改正式资料、不上传或发布。

## QQ 采集专用模式与发送桥

迁移后，手机和 Windows 云模式共用资料服务作为唯一正式编辑入口。不要同时保留一个仍能编辑旧本机任务/课表/账本的普通桌面窗口，否则会形成两份独立资料；提炼发送桥不会合并这两份日历或账本。

含采集专用模式的新构建可显式使用 `--planner-capture-only`。它要求已有本机 planner.sqlite，不能与 remote-config 同时使用；不会自动新建空正式库或打开普通日历编辑窗口。先正常退出旧普通日历，再启动采集模式，QQ 和 QQ-agent 保持原样运行。本轮源码实现不等于已经替换用户安装包。

```powershell
& "C:\Software\终极日历\ultimate-calendar\终极日历.exe" --planner-capture-only
```

采集专用进程留在托盘，继续既有 QQ 本机采集与本机提炼，原文/附件留电脑。独立发送桥读取已经提炼的候选字段，使用自己的受控 outbox 和服务设备凭据去重上传；不上传原始 QQ 数据库，不把旧任务或账本当作同步源。发送桥的配置、配对凭据和 outbox 与云窗口 profile 分开；身份或代际变化时先停止并核对，不自动发送到另一份服务资料。

构建工具为 `npm run build:tools`，桥接配置使用已有 `src/bridge/config.ts` 的严格格式。先 `node dist-tools/bridge.mjs check --config "C:\Software\终极日历\bridge.json"` 检查，再显式运行 `once` 或 `run`；不要另启普通桌面来代替采集专用模式。服务或发送桥离线时保留本机提炼队列，恢复后按稳定提炼标识提交。

退出采集服务应使用托盘“退出采集服务（QQ 保持运行）”，等待正在处理的任务收尾和数据库关闭；不要强杀、直接替换数据库或关闭 QQ 来结束它。关闭云窗口不等于关闭采集或发送桥；各自按自己的退出方式收尾。
