# 终极日历 · Ultimate Calendar

一个把日历、课表、任务、群通知和记账放在一起的 Windows 桌面应用。

**推荐使用「终极日历本地版」：下载安装即可使用，无需部署服务器、注册日历账号或进行设备配对。** 资料保存在自己的电脑上；需要 AI 时，填写自己的 DeepSeek API Key，由本机直接调用。它只提供桌面端，没有手机端或跨设备同步。

[下载本地版 0.5.0（Windows x64）](https://github.com/Albert071006/ultimate-calendar/releases/download/v0.5.0/UltimateCalendar-Local-Setup-0.5.0.exe) · [全部版本](https://github.com/Albert071006/ultimate-calendar/releases) · [使用说明](docs/local-desktop.md) · [反馈问题](https://github.com/Albert071006/ultimate-calendar/issues)

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

## 标准版与自托管

需要手机与电脑共用资料的开发者，可使用仓库中保留的标准版与资料服务。它们与独立本地版分别构建、安装和更新；标准版安装包名为 `UltimateCalendar-Setup-*.exe`，由 `npm run package` 构建到 `release/`，继续使用 `latest.yml`。

部署和配对说明已移至[手机网页与自托管资料服务](docs/self-hosted.md)。本地版使用者无需配置这些服务，也没有手机配对入口。

## 发布与贡献

发布前同步包版本和 `docs/release-notes/<version>.md`，完成类型检查、测试、构建及打包冒烟验证。推送 `v<version>` 标签后，Windows release 流水线构建两种桌面版，核对各自安装包、更新元数据和校验文件，上传草稿并验证全部附件后公开。两套更新文件均来自该标签的同次流水线。

普通本地构建不上传；已发布附件不覆盖。维护约定见 [AGENTS.md](AGENTS.md)。欢迎通过 Issue 或 Pull Request 反馈，复现材料请使用虚构数据并移除密钥、QQ 账号及私人账目。

项目采用 [MIT](LICENSE) 许可证。第三方依赖遵循各自许可证；图标与界面字体声明保留在 [public/third-party](public/third-party)。
