# Windows QQ 采集安装指南

终极日历通过运行在同一台电脑上的桥接器读取你选定的 QQ 群。已有 NapCat 或 SnowLuma 且能收到群消息的用户，可以沿用现有配置。首次配置可以试用支持 OneBot 11 的 LLBot（LuckyLilliaBot）。以下步骤已核对公开下载包、协议配置和日历界面，尚未在全新 Windows 环境完成 LLBot 收信实测。

## 安装和配置 LLBot

1. 准备 Windows x64 和 64 位桌面 QQ。在 LLBot v8.3.2 发布页展开 **Assets**，下载 `LuckyLillia-Desktop-win-x64.zip`。解压到固定目录，打开桌面程序，点击启动，按提示登录能看到目标群的 QQ 账号。[LLBot 发布页](https://github.com/LuckyLilliaDev/LuckyLilliaBot/releases/tag/v8.3.2) · [上游 Windows 安装说明](https://luckylillia.com/guide/choice_install)
2. 在 LLBot 的「Bot 配置」中启用 **OneBot 11 → 正向 WebSocket（正向 WS）**。启用仅监听本机，设置一个空闲端口和自己生成的非空令牌（Token），保存配置。以端口 `3001` 为例，日历要连的地址就是 `ws://127.0.0.1:3001`。令牌仅填在本机两个应用里。[LLBot 协议配置说明](https://luckylillia.com/guide/config)

## 在日历里连接并验证收信

1. 打开 Windows 版终极日历的「我的 → QQ 采集」。使用 LLBot 时，在「日历专用桥接类型」保留 **NapCat**，这是当前版本使用的 OneBot 兼容选项。已有 NapCat 或 SnowLuma 的用户选择自己的桥接类型。
2. 在「本机桥接地址」填写桥接器的正向 WS 地址，在「桥接访问令牌」填写同一个令牌，点击 **连接此地址**。显示「QQ 已在线」后，核对页面上的账号昵称和 QQ 号。
3. 点击 **读取群列表**，勾选需要的群，点击 **保存群选择**，再点击 **开始收集**。让日历和桥接器保持运行。
4. 等所选群里有其他成员发来一条新消息，在「消息原文」点击 **刷新记录**。看到这条消息，就确认了从 QQ 到日历的收信过程。需要自动提炼成「待判断」事项时，再到「我的 → AI 与费用」配置自己的 DeepSeek API Key，并在「QQ 采集」开启分析。

## 遇到问题

- **连不上。** 确认 LLBot 已登录 QQ，开启的是正向 WS，并核对日历里的端口、令牌。地址使用同一台电脑的 `127.0.0.1` 和 WS 端口；LLBot 管理页面的 HTTP 端口用于打开配置界面。
- **显示在线，但看不到新消息。** 先检查群选择是否已保存、页面是否显示「正在收集选定群」。LLBot v8.3.2 在部分 Windows 桌面 QQ 组合上有过连接正常却无群消息的报告，可对照所用版本查看上游记录。[问题报告](https://github.com/LuckyLilliaDev/LuckyLilliaBot/issues/881) · [相关修复](https://github.com/LuckyLilliaDev/LuckyLilliaBot/pull/883)
- **急着整理一条通知。** 在日历的「待判断 → 导入消息」粘贴群消息原文即可，手动导入无需桥接器。
