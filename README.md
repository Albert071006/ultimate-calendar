# 终极日历 · Ultimate Calendar

一个把日历、课表、任务、群通知和记账放在一起的开源应用，提供本地桌面版，以及自行部署的服务器版与手机端。

**推荐使用「终极日历本地版」：下载安装即可使用，无需部署服务器、注册日历账号或进行设备配对。** 资料保存在自己的电脑上；需要 AI 时，填写自己的 DeepSeek API Key，由本机直接调用。它只提供桌面端，没有手机端或跨设备同步。

[下载本地版 0.5.0（Windows x64）](https://github.com/Albert071006/ultimate-calendar/releases/download/v0.5.0/UltimateCalendar-Local-Setup-0.5.0.exe) · [服务器版与手机端 0.5.0](https://github.com/Albert071006/ultimate-calendar/releases/tag/server-v0.5.0) · [反馈问题](https://github.com/Albert071006/ultimate-calendar/issues)

| 版本 | 适合谁 | 资料与 AI |
| --- | --- | --- |
| [本地版](https://github.com/Albert071006/ultimate-calendar/releases/tag/v0.5.0) | 只在 Windows 电脑使用，下载安装即可 | 资料在本机，AI 由本机调用自己的 DeepSeek API Key |
| [服务器版与手机端](https://github.com/Albert071006/ultimate-calendar/releases/tag/server-v0.5.0) | 希望手机与电脑共用资料，愿意维护常在线服务器 | 资料在自己的服务器，AI 由服务器调用，手机通过 HTTPS 网页/PWA 使用 |

## 开始使用

1. 下载 `UltimateCalendar-Local-Setup-*.exe`，按提示安装并打开「终极日历本地版」。使用安装包不需要安装 Node.js。
2. 直接添加日程、任务、课表和账目。这些手动功能不需要 API Key，也不依赖网络。
3. 如需 AI 助手，在「我的 → AI 与费用」保存自己的 DeepSeek API Key，然后选择可用模型。AI 请求需要联网，费用由自己的 API 账户承担。
4. 如需自动整理 QQ 群通知，可另行配置本机 OneBot 兼容桥接服务，再在「QQ 采集」中连接并选择群。也可以只使用手动导入消息。

本地版从空白资料开始，没有预置私人课表、账单、群名单或密钥。日程和账目按北京时间处理。安装包当前未购买代码签名证书。

## 可以做什么

- **日历和课表**：按分钟安排、拖动和调整时段，支持教学周、节次、单双周与重复活动。
- **任务和目标**：管理截止时间、目标及多个执行时段；完成一个时段与完成整项任务分别记录。
- **生活助手**：用中文查询和修改安排、任务及账目，支持添加或粘贴图片；需核对的操作先展示预览。图片分析取决于所选模型是否支持视觉输入。
- **通知整理**：从手动导入或本机 QQ 采集的消息、附件中提取事项，先进入待判断列表，再由你接受、忽略或稍后决定。
- **本地账本**：分别记录实际付款与个人开销，支持 AA、代垫、退款、报销、转账、余额核对和 CSV 导出。
- **资料关联**：给任务和日程关联网页、电脑文件与文件夹，查看仍保留在本机的通知原文和附件。
- **外部 Agent 计划**：导出忙碌时间或目标上下文，导入其他 Agent 生成的计划；支持新建、追加和修订已有计划，导入过程无需再次调用 AI。
- **提醒、备份与更新**：提供 Windows 提醒、本机备份恢复、空间管理和应用内更新。

QQ 客户端和桥接组件不包含在安装包中，微信采集尚未提供。提醒需要日历进程保持运行，关机、休眠或退出期间不能即时通知。附件格式与其他边界见[本地版说明](docs/local-desktop.md)。

## 数据与隐私

- 本地版资料默认保存在系统「文档/终极日历本地版/数据」，备份默认位于「文档/终极日历本地版/备份」。数据不会同步到日历服务器。
- API Key 和 QQ 桥接令牌由本机系统加密保存。仓库和安装包不包含任何人的真实资料或凭据。
- 使用 AI 时，完成请求所需的文字、图片、附件内容或相关日历、账本上下文会直接发送给 DeepSeek。手动管理资料无需调用 AI。
- 本地版与标准版使用独立的安装身份、资料目录和更新通道；安装本地版不会自动导入旧本地资料或云端资料。
- 自动清理保留正式记录及必要的最新有效备份。备份也包含私人资料，请妥善保存，勿上传到 Issue 或代码仓库。

详细规则见[本地版说明](docs/local-desktop.md)和[空间管理说明](docs/storage-management.md)。

## 用其他 Agent 制定计划

在「导入计划 → 导出忙碌时间」选择日期，让 Agent 避开现有课表和活动；已有目标可从目标列表或详情「导出给外部智能体」。生成的 `.calendar-plan.json` 在应用中预览后保存。

新目标用 v1，只追加用 v2，明确修改或删除已有内容用 v3。已有计划应先导出最新上下文，保留来源和版本核对信息。

[计划文件标准](docs/plan-file-format.md) · [Agent 规划指南](docs/agent-planning-guide.md) · [新计划示例](docs/examples/study-plan.calendar-plan.json) · [v2 追加示例](docs/examples/guarded-supplement.calendar-plan.json) · [v3 修订示例](docs/examples/revise-existing-plan.calendar-plan.json)

## 从源码构建

需要 Windows、Git 和 **Node.js 24 或更高版本**。

```powershell
git clone https://github.com/Albert071006/ultimate-calendar.git
cd ultimate-calendar
npm ci
npm run typecheck
npm test
npm run package:local
```

独立本地版安装包与解包应用生成在 `release-local/`。本地版使用 `local.yml` 更新元数据及 `SHA256SUMS-local.txt` 校验文件；打包命令只构建，不会上传 GitHub。

只构建本地版使用 `npm run build:local`。日常开发可运行：

```powershell
npm run dev:local -- --planner-profile="$env:TEMP\ultimate-calendar-dev"
```

该命令使用独立测试目录。开发环境请用虚构资料，不填写真实密钥或连接真实群。`npm ci` 会下载 Electron；若主动跳过了安装脚本，可运行 `node node_modules/electron/install.js` 补齐运行时。

应用冒烟测试使用临时资料和模拟 QQ 服务，不调用付费 AI。验证本地版安装包中的程序：

```powershell
$env:PLANNER_SMOKE_EXE = (Resolve-Path 'release-local/win-unpacked/终极日历本地版.exe').Path
npm run smoke
```

## 服务器版与手机端

[服务器版 Release](https://github.com/Albert071006/ultimate-calendar/releases/tag/server-v0.5.0) 单独提供 `UltimateCalendar-Server-Mobile-0.5.0.tar.gz`，内含已构建的 Node 后端、手机网页、systemd 配置、NGINX 示例与部署说明。目标 Linux 服务器安装 Node.js 24 后即可运行部署包，无需再执行 `npm ci`。管理员还需配置域名、HTTPS 和持久资料目录。

部署后，手机打开自己的 HTTPS 地址，输入服务器生成的一次性码配对，再添加到主屏幕。服务器持续运行时，Windows 电脑可以关机；服务器停机或不可达时，共享读写与 AI 会受影响。每个服务实例是一套共享资料，适合自己或可信设备使用。

同一 Release 还提供可选 Windows 标准版 `UltimateCalendar-Setup-0.5.0.exe`，可配置为连接该服务器；独立本地版不会连接服务器。两种桌面版分别安装、保存资料和更新，标准版继续使用 `latest.yml`。

[Linux 部署与手机使用步骤](docs/server-mobile-deployment.md) · [Windows 连接说明](docs/windows-cloud-mode.md) · [自托管开发与接口说明](docs/self-hosted.md)

## 发布与贡献

两种产品分成两个 GitHub Release：本地版使用 `v<version>` 标签与 `docs/release-notes/<version>.md`；服务器版与手机端使用 `server-v<version>` 标签与 `docs/release-notes/server-<version>.md`。发布前完成版本、类型检查、测试、构建和隔离冒烟验证；发布流水线分别核对安装包或部署包、更新元数据和校验文件，上传两个草稿并验证全部附件后公开。

普通本地构建不上传；已发布附件不覆盖。维护约定见 [AGENTS.md](AGENTS.md)。欢迎通过 Issue 或 Pull Request 反馈，复现材料请使用虚构数据并移除密钥、QQ 账号及私人账目。

项目采用 [MIT](LICENSE) 许可证。第三方依赖遵循各自许可证；图标与界面字体声明保留在 [public/third-party](public/third-party)。
