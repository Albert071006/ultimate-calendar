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

当前面向 Windows x64，以北京时间处理日程和账目。手机端、跨设备同步和微信采集尚未提供。

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

- 日程、任务、账单等保存在本机 SQLite 文件中，默认数据目录为 `%APPDATA%\终极日历`；备份、导出和历史操作可在应用中管理。
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

## 版本发布

每次功能修改通过检查后同步源码；需要向用户提供更新时再升版本和推送标签：

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
| `src/ai` | 模型请求、自然语言操作和记账解析 |
| `src/capture` | QQ 采集、附件下载与文档解析 |
| `src/ledger` | 账本、余额、汇总和更正逻辑 |
| `src/shared` | 数据类型与校验规则 |
| `scripts` / `tests` | 构建、验收和集成测试 |

## 贡献与许可

欢迎通过 Issue 描述问题，或提交 Pull Request。提交前请运行类型检查、测试和构建；复现材料请使用虚构数据并移除密钥、QQ 账号和私人账目。

项目采用 [MIT](LICENSE) 许可证。第三方依赖遵循各自许可证；Tabler 图标与界面宋体（Noto Serif SC 子集，SIL OFL 1.1）的声明保留在 [public/third-party](public/third-party)。宋体子集由 `npm run font:subset -- <Noto Serif SC 字体文件>` 生成。
