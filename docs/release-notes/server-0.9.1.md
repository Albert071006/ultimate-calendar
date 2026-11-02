## 服务器版与手机端 0.9.1

需要自行部署并维护常在线的 Linux 云服务器，配置 Node.js 24、域名和 HTTPS。服务器保存资料并调用自己的 DeepSeek API；手机通过网页/PWA 使用，Windows 标准版连接同一服务。项目不提供公共托管账号。

### 本次修复

- Windows 生活助手输入框随多行或自动折行内容增高，最多显示约六行，更长内容可在框内上下滚动，清空后恢复紧凑高度。保留 Enter 发送、Shift+Enter 换行。
- 云端资料读取失败不再误报“写入结果可能尚未返回”；重新读取成功后自动清除读取错误。仍保留保存结果未知、校验错误和已保存回执，避免把连接恢复误当作保存成功。
- “记一笔”保持手动录入，分类可自行选择或输入新名称。本次没有添加手动录入自动分类，也不改动已有账目。

### 下载与升级

- `UltimateCalendar-Setup-0.9.1.exe`：Windows 标准版客户端，附同次构建的更新元数据、blockmap 和校验文件。
- `UltimateCalendar-Server-Mobile-0.9.1.tar.gz`：已构建的后端、手机网页/PWA、systemd 配置、NGINX 示例及部署说明，目标服务器无需运行 `npm ci`。
- `SHA256SUMS-server.txt`：服务器部署包校验文件。

保存草稿并正常退出后更新 Windows 客户端，保留资料、凭据和配对。部署方法见[服务器与手机指南](https://github.com/Albert071006/ultimate-calendar/blob/server-v0.9.1/docs/server-mobile-deployment.md)；更新手机静态资源时保留旧页面引用的指纹资源。本次没有数据迁移，发布下载包不等于已替使用者部署服务器。

无需服务器、仅在一台 Windows 电脑使用时，选择[纯本地桌面版 0.9.1](https://github.com/Albert071006/ultimate-calendar/releases/tag/v0.9.1)。两版的安装身份、资料目录与更新通道继续分开。
