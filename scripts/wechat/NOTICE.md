# 微信只读适配器

`vendor/db.py` 来自 [fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)，固定提交 `6e603974bbac3bda93d88bbd6995510ae2547f5c`（1.2.8.1），原文件未修改，Apache-2.0，许可证见 `vendor/LICENSE`。

日历仅加载这个数据库模块，不导入上游包入口、UI 自动化、发送、媒体下载或监听线程。`worker.py` 是日历自有适配：限制只读请求、账号绑定、分页、错误输出、私有临时目录；禁用上游密钥落盘、账号自动切换与额外主密钥扫描。数据库密钥仅存于采集进程内存；解密副本位于本机私有缓存，正常退出删除。

运行依赖：64 位 Windows Python（已测 3.12 / 3.14）、`cryptography==50.0.2`、`zstandard==0.25.0`。微信数据库结构可能随客户端更新变化。当前读取文本和卡片标题；图片、语音、视频及文件正文不自动下载或识别，会显示未读取说明。仅本机已同步的消息可读取，不能把本地历史读尽当作完整微信云端历史。
