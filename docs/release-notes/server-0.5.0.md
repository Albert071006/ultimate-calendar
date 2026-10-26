## 服务器版与手机端 0.5.0

本 Release 面向希望手机和电脑共用一份日历、任务与账本的用户。需要自行维护一台常在线的 Linux 服务器，并配置域名与 HTTPS；它不是作者提供的公共托管服务。

### 下载内容

- `UltimateCalendar-Server-Mobile-0.5.0.tar.gz`：已构建的 Node 后端、手机网页/PWA、systemd 配置、NGINX 示例和部署说明。目标服务器需要 Node.js 24，无需在服务器运行 `npm ci`。
- `SHA256SUMS-server.txt`：服务器部署包校验文件。
- `UltimateCalendar-Setup-0.5.0.exe`：可选 Windows 标准版客户端，配置后连接同一资料服务；另有同次构建的更新元数据与校验文件。

### 如何运行

手机或 Windows 标准版通过 HTTPS 访问自己的资料服务。服务器保存日历、课表、任务、目标和账本，并调用用户自己的 DeepSeek API；Windows 电脑关机时，手机仍可使用。服务器停机或网络不可达时，共享读写和 AI 会受影响。

1. 核对 SHA256，解压部署包，在 Linux 上配置服务用户、持久资料目录与 systemd。
2. 配置自己的域名、证书和 HTTPS 反向代理；Node 服务仅监听回环地址，手机网页和 API 使用同一 HTTPS 来源。
3. 以服务用户运行 `pair` 生成一次性配对码，在手机网页输入后添加到主屏幕。
4. 在手机「我的 → AI 与费用」保存自己的 DeepSeek API Key。未配置 Key 时仍可手动管理资料。
5. 如需 Windows 客户端，安装本 Release 中的标准版，按连接说明配置同一服务。

完整步骤见 [Linux 部署与手机使用指南](https://github.com/Albert071006/ultimate-calendar/blob/server-v0.5.0/docs/server-mobile-deployment.md)。每个服务实例是一套共享资料，并非面向互不相识用户的多租户平台。

### 功能与资料边界

- 手机提供日历、任务、账本、生活助手与设备管理；支持图片输入、部分普通安排离线暂存和简单支出草稿。待提交草稿不等于服务器已保存。
- 资料和自动安全备份保存在服务器持久目录；AI Key 不随程序包或安全备份发布。
- 可选 QQ 采集仍在 Windows 电脑运行，只通过独立提炼桥发送摘要；服务器本身不登录 QQ，原文和附件留在采集电脑。
- 手机通知需要 HTTPS、平台支持、添加主屏幕和用户授权，并需服务器配置推送联系信息；后台送达取决于实际设备和网络。

本 Release 与仅在电脑保存资料的[本地版 0.5.0](https://github.com/Albert071006/ultimate-calendar/releases/tag/v0.5.0) 分开发布。发布包的构建与隔离验证不代表已替使用者部署或验收其 Linux 服务器。
