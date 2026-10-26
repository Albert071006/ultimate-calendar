# 手机公网 HTTPS 入口与私网并行部署

本方案让手机通过自有域名访问同一日历服务，Windows 和 QQ 采集保留原有私网/SSH 链路。双入口共用一个后端进程、正式数据库、AI 配置和提醒调度器。不要复制一个数据库给新域名，也不要启动第二个完整服务共同写正式库。

本文件和 `deploy/public-https/` 是待审阅模板，不代表已在任何服务器上启用公网访问。当前准备范围为代码、测试、域名筛选和本机部署材料；首年不超过 50 元的域名筛选预算不等于已确认某个具体订单。域名尚待选定，实名、备案核验及支付由域名持有人完成。本文所有域名、地址和路径均为合成示例，不含生产凭据。

## 入口与配置

```text
iPhone → 新公网域名 → Caddy HTTPS → 127.0.0.1:3210 → 同一资料服务
Windows / QQ 摘要桥 → 原 SSH/私网域名 ────────────────┘
```

- 原 `--origin` 保持不变，新增 `--public-origin https://calendar.example.org`。每个入口的 Host 必须与它自己的 Origin 精确匹配；不得把公网 Origin 改写成旧域名、启用通配 origin，或允许两个入口交叉使用 Origin。
- Caddy 仅绑定 ECS 主网卡**实际配置的内网地址**的 TCP 80/443。云平台公网 IP 若是 NAT 映射，不能直接作为主机 bind 地址。既有 Tailscale Serve 使用另一接口的 443；不得盲目绑定 `0.0.0.0:443`。模板显式声明 HTTP 与 HTTPS 两个 site，避免自动重定向监听器绕过 bind 设置。[Caddy bind](https://caddyserver.com/docs/caddyfile/directives/bind) · [default_bind 的边界](https://caddyserver.com/docs/caddyfile/options#default-bind)
- 后端仍只监听 `127.0.0.1:3210`。公网新增安全组/防火墙规则仅为 TCP 80、443；模板只启用 HTTP/1.1、HTTP/2，不需要 UDP 443。80 服务证书验证和 HTTPS 跳转，业务走 443。没有新增公网数据库、3210 或 Caddy 管理端口；Caddy 管理 API 仅在回环 2019。
- `--trust-loopback-proxy true` 只对 publicOrigin 启用。Caddy 从真实连接对端生成**单个** `X-Forwarded-For`，覆盖入站同名值；不配置 `trusted_proxies`，不接受用户传入 Forwarded/X-Real-IP。后端仅在直接连接来自 loopback 时接受此单地址，拒绝地址列表、端口或 zone；其他来源不得靠伪造 XFF 改变限流身份。[反代头部行为](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)
- 公网代理和后端均拒绝 `/api/v1/ai/receiver/sync`、`/api/v1/distilled`、`/api/v1/status`、`/healthz`、`/readyz` 及其子路径。手机所需的配对、共享资料、AI 设置、设备管理、提醒订阅和事件接口仍需要相应身份和 CSRF 保护。健康检查改用原私网入口或带原 Host 的本机探针。
- 原 SSH、Tailscale Serve、CGNAT 例外、Workbench、云助手和 DNS 不需改变。添加公网入口前应保存这些现状并验证新监听没有冲突；遇到冲突应修正新代理 bind，不能删除原管理规则解决。

公网限流、双 origin 和会话续期必须使用包含这些功能并通过测试的后端版本，不能把新代理直接放到旧版单 origin 后端前。Caddy 标准发行版模板没有依赖第三方限流插件；配对及未认证请求的有界速率限制由后端执行。不要把已有并发上限称作每 IP 请求速率限制。

当前后端默认公网预算为：单 IP 全部请求 240 次/分钟、未登录请求 60 次/分钟、配对 5 次/分钟，以及全局配对 30 次/分钟；IP 状态表最多 4096 项，满表时拒绝新 IP 分配。实际阈值以代码与测试为准，移动网络共享出口可能触发同一 IP 的预算，需实测正常浏览和后台请求不会持续被限流。续期入口要求有效配对、精确 Origin、CSRF。数据库有效期仅在剩余不超过 15 天时延长到 30 天；每次有效续期响应都按数据库实际剩余秒数设置 Cookie，因此响应丢失后的重试可以恢复 Cookie，而不会再次延长数据库有效期。过期或撤销会话不会复活。

## 证书与部署文件

| 文件 | 作用 |
| --- | --- |
| `deploy/public-https/Caddyfile.example` | 双端口明确 bind、自动 HTTPS、私网路由屏蔽、可信转发头 |
| `deploy/public-https/caddy.env.example` | 仅主机名、绑定地址与证书联系邮箱，无用户密钥 |
| `deploy/public-https/caddy-service-drop-in.conf.example` | 为官方 Caddy unit 注入环境文件与初始资源预算 |
| `deploy/public-https/backend-arguments.example.txt` | 追加到原有效 ExecStart 的参数，不覆盖既有静态前端等设置 |
| `deploy/public-https/check-template.mjs` | 用已验证的 Caddy 可执行文件离线适配模板，不启动监听或申请证书 |

从 Caddy 官方渠道安装并记录实际版本，先审阅其官方 systemd unit，再使用 drop-in。不要为了套用模板覆盖已有配置。Caddy 的证书目录必须持久、仅服务用户可访问；HTTPS 使用 Let's Encrypt 免费证书并自动续期。联系邮箱应可接收证书告警，不能当作监控已经完成。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https) · [Let's Encrypt](https://letsencrypt.org/about/)

本模板以官方 **Caddy v2.11.7**（2026-10-03 发布）为审阅目标；采用别的版本需重新适配与回归。可从官方 Release 获取本机平台的可执行文件，并在执行前核验官方资产摘要。模板本身不会自动下载或安装二进制。[官方 v2.11.7](https://github.com/caddyserver/caddy/releases/tag/v2.11.7)

代理不启用访问日志，运行错误日志过滤请求头、请求 URL 和响应头；不启用 `debug` 或 `log_credentials`，不记录请求体。不得将 API Key、配对码、Cookie、CSRF 或推送订阅写入日志、命令参数、模板、公开仓库。只有域名和普通证书公开信息可以公开。

192 MiB/256 MiB 是模板中的代理初始软/硬预算，**不是实测内存占用承诺**。部署前通过合成的并发、SSE、上传和证书加载测试记录峰值，并结合现有 Node、Tailscale、系统可用内存调整。预算过低导致代理重启时先核查测量，不修改日历数据库或关闭原管理服务。

## 分阶段实施

### 1. 域名与备案阶段

先核对域名可用性、实名主体、首年与续费报价及抵扣券适用范围，再确认具体订单。中国内地托管网站按接入商及所在地规则办理 ICP 备案；公网开放前完成所需备案并展示对应信息，按要求办理后续公安联网备案。审核期间继续用原私网日历，不用未备案的临时域名或 IP 变相开放。[阿里云个人网站备案流程](https://help.aliyun.com/zh/icp-filing/basic-icp-service/getting-started/quick-start-for-icp-filing-for-personal-websites)

备案前可在本机、隔离测试目录内完成代码及 HTTP 协议测试；不要在正式服务器开放 80/443、启动这个公网 Caddyfile、解析可供公网访问的新入口或签发测试域名的生产证书。使用合成数据和配对凭据，禁止拷贝真实业务库到公网测试站。

### 2. 备份与私有验证

记录当前 release、有效 systemd unit/drop-in、origin、前端目录、监听地址、服务健康与数据数量；记录安全组新增规则的计划，既有规则不删改。正常停止资料服务后做受保护的冷备份，并保存哈希；随后恢复原服务。运维冷备份含设备/AI 凭据，与不含密钥的业务导出不同，必须留在私有位置。

先在隔离数据库运行合成测试，验证原 origin 仍可用、新 Host 与自己的 Origin 可用、混用被拒绝，未配对看不到资料，公网私网专属路由为 404，伪造 XFF 无效，配对和未认证速率限制有边界，并发和请求体上限仍有效。续期必须拒绝过期或已撤销的会话，不复活旧设备、不重复业务写入。

模板审阅时可使用下面的本机命令，路径仍为示例：

```powershell
node deploy/public-https/check-template.mjs C:\Software\Caddy\2.11.7\caddy.exe
```

校验脚本只运行 `caddy version` 和 `caddy adapt --adapter caddyfile --config <模板> --pretty`，对子进程注入合成域名／地址，解析输出并检查两个精确监听地址、上游仅回环、保留 Host/Origin、覆盖 XFF 和私网路由屏蔽。它**不调用** `run`、`start`、`reload`、`validate` 或 `adapt --validate`，不进行 TLS 模块初始化、ACME 请求或端口绑定，也不会改变现有服务。通过仅代表目标版本可适配此模板，仍须在真实部署时检查监听、TLS、限流和现有链路。若尚无经过校验的二进制，应记录“CLI 适配待验证”，不能把静态审阅当作运行验收。[Caddy adapt](https://caddyserver.com/docs/command-line#caddy-adapt)

2026-10-25 已在 Windows amd64 本机完成上述离线适配。官方 `caddy_2.11.7_windows_amd64.zip` 下载后，SHA-256 与官方 GitHub Release API 的资产 `digest` 一致：`0a1edc0b799512051c57071ce0e798d3f2cf67dc98171366f1d2b326072e3b06`；同时与该 Release 的 `caddy_2.11.7_checksums.txt` 核对 SHA-512 一致（该文件使用 SHA-512，不应误当 SHA-256）。核验后解压到专用版本目录，仅执行 `version` 与 `adapt`。

适配结果通过：只声明合成地址 `10.0.0.10:80`、`10.0.0.10:443`，上游为 `127.0.0.1:3210`，Host/Origin 保留，XFF 覆盖及五类私网路由屏蔽均存在。解析中发现并修正了 ACME issuer 的参数名，使用 `issuer acme { dir ... }`。[ACME issuer 语法](https://caddyserver.com/docs/caddyfile/directives/tls#acme) 本次未启动 Caddy、未申请证书、未安装系统服务、未改生产服务器；实际 HTTPS、内存、双端同步和手机迁移仍待部署验收。

### 3. 公网启用阶段

备案完成、具体域名和配置确认后，将域名 A 记录指向该 ECS 的公网入口；仅在验证 IPv6 全链路时添加 AAAA。核对 CAA 不妨碍所选证书机构。Caddy 绑定主网卡内网地址，经过 NAT 接收公网请求。

先部署兼容双 origin 的后端，保留所有旧参数和原私网入口；检查原手机入口、Windows 和 QQ 摘要/Key 同步仍正常。再加载审阅后的 Caddy 配置和新增的 TCP 80/443 安全组规则，确认域名、证书链、HTTPS、反代与限流。证书签发失败时保留原私网访问，不关闭证书校验或退回公网明文。

启动时可以在短时间内做有限健康检查；长期监控应单独配置，不以手工检查冒充自动监控。记录新规则 ID、配置文件哈希、release、证书有效期和启动结果，供回退使用。

### 4. 手机入口迁移

先在旧域名连接正常时检查离线待提交、冲突和结果未知操作。已发送结果不明的操作先按原编号核对，不在新域名重复创建；保留无法完成的草稿，不能清缓存、删 IndexedDB 或先移除旧主屏图标。

Cookie、IndexedDB、Service Worker、主屏网页应用和推送权限都按 origin 隔离。新域名需要一次新配对，重新添加主屏图标，开启该入口的通知订阅；云端任务、账本、API Key 无需重新导入或填写。旧队列不能宣称自动搬到新域名。安全会话续期减少正常在线使用中的重新配对，过期、撤销、恢复资料身份变化仍需重新核对授权。

新订阅真实到时提醒验证成功后，再撤销旧手机订阅，避免两入口重复通知。不要撤销 Windows、摘要桥或密钥接收设备授权。保留原入口用于回退，待确认无旧草稿后再由用户决定移除旧图标。

### 5. 验收与费用

- iPhone 关闭 Tailscale，在 Wi-Fi、蜂窝数据下分别打开主屏日历；记录首次与重复打开耗时、路径及失败状态。
- 手机创建无提醒的合成任务，Windows 能看到；Windows 改名，手机能看到。按同一 ID 清理测试项，正常业务资料和备份保留。
- 任一端通过现有受控配置接口修改一次，另一端生活助手和 QQ 采集使用一致 revision；清除/撤销路径优先用合成测试，实机不要为了测试替换有效 Key。
- 新域名配对、续期、退出/撤销、旧域名来源隔离、SSE 更新、导出等受影响路径完成回归。清空浏览器资料和整机重启未实测时明确记录。
- 电脑关机且手机 Tailscale 关闭时，验证一条明确同意的测试提醒；恢复后核对只收到一次，点击落在新入口。未实测前不能声称通知迁移完成。
- 记录代理与后端峰值内存/重启次数、QQ 采集/摘要队列状态、证书与主网卡/Tailscale 双 443 监听、Workbench/云助手/DNS 可用性。
- 核对 CDT 免费额度确已开通且适用于当前实例，设置费用预算与流量告警；“开通免费额度”不等于无限免费。域名按实付及续费价格记账，AI 费用仍按供应商用量计算。证书自动续期需持续验证，不能在上线后删除证书存储或关闭所用验证端口。

## 回退

公网入口故障时，先保留失败状态记录，再停止新代理或仅关闭本轮新增的公网规则。iPhone 重新连接 Tailscale 使用原图标；Windows、QQ 和旧服务路径应继续可用。

需要回退程序时，正常停止后端，恢复记录的上一 release 和有效 ExecStart，移除新增 `--public-origin`／`--trust-loopback-proxy` 参数，启动并通过原 Host 检查健康。只回退程序和入口，不把冷备份数据库覆盖到当前正式库，不删除切换期间的新任务、账目或密钥配置。旧授权与当前有效 Key 保留。

停用新公网入口时同时核对新手机通知订阅，避免通知仍指向已停用入口；按用户实际回退目标重新启用原入口提醒。DNS、域名与证书文件保留用于恢复，Caddy 私钥只存于受限服务器目录。原 Tailscale、SSH、CGNAT、Workbench 和 QQ 组件不属于本次回退修改范围。
