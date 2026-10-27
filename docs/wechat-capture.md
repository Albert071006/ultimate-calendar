# Windows 微信群采集

0.6.0 的两个 Windows 桌面版都可以选择微信群，自动收集本机消息，并把文字、已下载图片和文档交给日历的任务提炼流程。手机端查看同步后的事项，不运行微信采集器。

这是可选的本机只读适配器，**需要单独配置 Python 读取环境**；日历安装包没有捆绑 Python 或 FFmpeg。未配置时，日历其他功能正常使用，微信页会提示“组件尚未配置”。支持 Windows 64 位、已登录的微信 4.x；微信数据库格式可能随客户端版本变化，不能保证所有版本均兼容。

## 1. 准备 Python

从 [Python 官方 Windows 下载页](https://www.python.org/downloads/windows/)使用完整的 Windows 安装器安装 64 位 Python 3.12 或更新版本（已测试 3.12、3.14），保留 pip 和虚拟环境组件，可选择安装到 `C:\Software\Python`。记下实际 `python.exe` 路径；不要使用 Windows Store 的占位别名或 `py.exe`。用于本节的安装方式不是缺少 `venv` 的 embeddable ZIP；已经准备好依赖的便携运行时可用后面的 `-UseExistingRuntime`。

下面的脚本默认在 `C:\Software\UltimateCalendarWeChat\calendar-runtime` 创建独立虚拟环境，只在其中安装固定版本的 `cryptography` 和 `zstandard`，不修改原 Python 的包。系统 Python 必须保留，虚拟环境依赖它。

## 2. 下载配置脚本

在 PowerShell 运行以下命令，从本项目固定的 0.6.0 发布标签下载脚本和依赖清单。也可以直接下载该版本源码，用其中的 `scripts/wechat/setup.ps1` 和 `requirements.txt`。

```powershell
$setupDirectory = 'C:\Software\UltimateCalendarWeChat\setup-0.6.0'
New-Item -ItemType Directory -Force -Path $setupDirectory | Out-Null
Invoke-WebRequest 'https://raw.githubusercontent.com/Albert071006/ultimate-calendar/v0.6.0/scripts/wechat/setup.ps1' -OutFile (Join-Path $setupDirectory 'setup.ps1')
Invoke-WebRequest 'https://raw.githubusercontent.com/Albert071006/ultimate-calendar/v0.6.0/scripts/wechat/requirements.txt' -OutFile (Join-Path $setupDirectory 'requirements.txt')
```

可先在文本编辑器查看脚本。然后从托盘正常退出日历，把下一条命令中的 Python 路径改为自己的实际安装位置。无需退出或重启微信、QQ。

**纯本地桌面版：**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Software\UltimateCalendarWeChat\setup-0.6.0\setup.ps1' -Edition Local -PythonPath 'C:\Software\Python\python.exe'
```

**服务器版的 Windows 客户端：**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Software\UltimateCalendarWeChat\setup-0.6.0\setup.ps1' -Edition Server -PythonPath 'C:\Software\Python\python.exe'
```

`ExecutionPolicy Bypass` 只作用于这次 PowerShell 进程，不修改系统执行策略。安装过程需要联网下载 Python 依赖。若选择的 `C:\Software` 目录不可写，可以用 `-RuntimeDirectory` 指定自己可写的独立目录。

脚本按 Windows 实际“文档”位置写入一个只有 Python 路径的 `wechat-runtime.json`：

| 桌面版本 | 配置所在目录 |
| --- | --- |
| 纯本地版 | 文档\终极日历本地版\数据 |
| 服务器版 Windows 客户端 | 文档\终极日历\数据 |

脚本不会读取、修改或迁移日历数据库、群选择、API Key、微信账号与微信密钥。已有 `wechat-runtime.json` 一律保留，已有运行时目录也不会被覆盖。若安装中断，保留的目录可用于检查；修复依赖后按下面方式使用它，或选择新的空目录重试。

### 使用已经准备好的运行时

若已有独立的 64 位 Python，并安装了 `requirements.txt` 中的依赖，可跳过虚拟环境创建和依赖下载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Software\UltimateCalendarWeChat\setup-0.6.0\setup.ps1' -Edition Local -PythonPath 'C:\Software\UltimateCalendarWeChat\calendar-runtime\Scripts\python.exe' -UseExistingRuntime
```

同时使用两个日历版本时，第二次执行改成另一个 `-Edition`，加 `-UseExistingRuntime` 并指向同一个虚拟环境的 `Scripts\python.exe`；两份资料与采集设置仍各自独立。高级用户的 `--planner-profile` 独立资料目录可用 `-DataDirectory` 明确指定，不要指向其他版本或其他人的资料目录。

## 3. 可选：识别 HEVC 图片

部分微信图片使用 `wxgf` / HEVC 容器，需要 FFmpeg 解码；普通已支持图片和文档不依赖这一项。

从 [FFmpeg 官方下载页](https://ffmpeg.org/download.html#build-windows)选择 Windows 64 位构建，解压后将 `ffmpeg.exe` 放到**上一步输出的 Python 文件旁边**。默认虚拟环境对应：

```text
C:\Software\UltimateCalendarWeChat\calendar-runtime\Scripts\ffmpeg.exe
```

不需要修改 PATH。保留所下载构建的许可证和说明；不同构建的授权可能不同。本项目不分发 FFmpeg 二进制，也不自动下载或代替用户接受其分发条件。没有 FFmpeg 时，相关图片会提示需手动查看，不会把未读取图片当成已分析。

## 4. 在日历中启用

重新打开日历，进入“我的 → 微信采集” → “连接本机微信” → “读取群列表”，勾选需要的群并“保存群选择”，再分别打开“开始收集”和“自动分析”。默认没有选群，也不会自动开始收集。

AI 沿用日历中自己的 API Key 与模型，会产生对应 API 费用；图片需要模型支持图片输入。采集只读选定群，不发送微信消息。可读取的范围是已经同步到电脑的记录，不代表完整微信云端历史。服务器版的原消息与附件保留在 Windows 采集电脑；任务提炼由桌面采集器按已配置模型调用 AI，生成的候选事项再同步到资料服务器。

附件必须已在电脑微信中缓存或下载。缺少附件时，先在微信打开图片或下载文件，再到日历对应分析批次点击“重试此批”；临时缺失也会稍后自动复查。“补采最近 7 天”可重新检查该范围的记录。单个附件上限 25 MiB；语音、视频、压缩包和暂不支持的格式需手动查看。

## 常见提示

- **组件尚未配置**：确认使用了对应版本的 `-Edition`，配置脚本成功后重新启动日历。脚本不会覆盖已有配置；已有配置失效时，在日历退出后先备份该 JSON，再由维护者修正其中的 Python 路径。
- **组件未能启动或已退出**：确认 Python 文件仍在、固定依赖可导入，微信已登录。微信格式发生变化时需要等待适配更新；不要清空日历资料或重填有效 API Key。
- **账号已变化**：在日历解除旧微信绑定，再连接并重新选群；原资料仍保留。
- **图片或文件尚未下载**：先在电脑微信完成下载，再重试；只有缩略图时不会冒充完整图片。

第三方来源与 Apache-2.0 许可证说明见 [微信适配器 NOTICE](../scripts/wechat/NOTICE.md) 和 [上游许可证](../scripts/wechat/vendor/LICENSE)。运行时不会保存微信数据库密钥；用于读取的解密副本位于本机私有缓存，正常退出采集进程时清理。
