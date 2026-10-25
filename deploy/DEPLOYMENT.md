# 后端独立部署包

本包只含 Node 后端及部署／校验文件，不含前端、源码工作区、Windows 安装包、数据库、用户资料或任何密钥。包内域名均为占位值；安装命令必须明确提供实际来源，初始可使用回环 HTTP，远程使用须 HTTPS。不会自动修改 NGINX、Tailscale、防火墙或 QQ。

## 制品与首次安装

本地先 `npm run build:server`，再 `node scripts/package-backend.mjs`。制品在 `release/backend/`，旁边有 SHA256 文件和可审查清单。清单中的 releaseId 由所有载荷的路径和内容哈希决定；归档只含普通文件／目录，不允许链接或特殊文件。

目标是 Ubuntu 26.04.1、Node.js 24；默认可执行文件 `/usr/local/bin/node`，已知部署环境版本 24.22.1。安装器会现场核查 major=24，绝对路径可用 `--node-bin` 覆盖。以下命令是管理员审阅后在目标机执行的方案，打包脚本本身不会执行它们：

```sh
sha256sum <绝对路径/后端包.tar.gz>
# 必须与本地可信清单中的 SHA256 相同，再解包至管理员临时目录。
tar -xzf <绝对路径/后端包.tar.gz> -C <管理员临时目录>
bash <临时目录/backend-版本-摘要/deploy/install-backend.sh> \
  --bundle <绝对路径/后端包.tar.gz> --sha256 <可信SHA256> \
  --origin https://calendar.example.invalid --node-bin /usr/local/bin/node
```

把示例域名替换为实际入口。安装器重新验证压缩包 SHA256、归档路径与类型，以及全部文件的大小和 SHA256；单个包载荷预算 64 MiB。使用独立 `ultimate-calendar` 系统用户，代码放在 `/opt/ultimate-calendar/releases/<releaseId>`，通过 `current` 原子链接切换；持久数据在 `/var/lib/ultimate-calendar/data`，安全备份在同级 `backups`。代码与配置由 root 管理，数据仅服务用户可读写。旧 release、数据库和未知备份均不自动删除。

仅验证基础后端时可先用 `--origin http://127.0.0.1:3210`，仍只监听回环，不开放公网 HTTP。后续启用 Tailscale HTTPS，管理员在 `/etc/ultimate-calendar/server.env` 把 CALENDAR_ORIGIN 改为实际规范 HTTPS 来源，正常重启服务，再使用该 Host 检查就绪和实际 HTTPS 入口；不用更换数据目录或重装后端。回环开发 Cookie 不作为 HTTPS 配对凭据，需在最终入口重新配对。

systemd **没有 `--static-dir`**，只绑定 `127.0.0.1:3210`，不会替换前端。初始没有 DeepSeek Key 和 VAPID 联系配置也能启动，AI／推送明确未配置。`/etc/ultimate-calendar/server.env` 保存来源和可选推送联系地址，不能放真实 Key。

默认允许已配对手机通过 `GET／PUT／DELETE /api/v1/ai/config` 读取状态、保存和清除 DeepSeek Key。服务把密钥写入 `/var/lib/ultimate-calendar/data/ai-credentials.json`，由服务用户拥有、文件权限 0600、父目录 0700；文件权限保护不等于内容加密。接口只返回是否配置、来源和 revision 等状态，不回显密钥。保存只校验格式，不收费测试供应商；新 AI 工作流直接使用新 Key，无需重启。接口需要 Cookie、写入 CSRF、精确 Origin、identity 和 revision，具体契约见 `docs/backend-api.md`。

管理员也可另行供应可选的 root-owned 0600 `/etc/ultimate-calendar/secrets.env` 中的 `DEEPSEEK_API_KEY`，或显式传入有效的 `--api-key-file`。优先顺序为显式文件、非空环境变量、手机管理文件；外部文件／环境存在时接口 editable=false，手机不能覆盖或清除。想恢复手机管理须移除外部配置并正常重启，不自动复制外部 Key；之前的手机管理文件仍保留，切换后须核对。初始部署不需要 secrets.env，也不传不存在的密钥文件。任何凭据都不装入发布包、通用 RPC 回执、安全备份或日志。

针对 2 GiB 机器，样例使用 512 MiB V8 堆、768 MiB 内存软预算、1024 MiB 硬上限，留余量给系统与代理；这是待实测的初始配置，不是无限数据容量承诺。完整账本写回执仍可能放大存储量，需监视鉴权状态接口的 `storageBytes`。

## 验证与升级

先在目标机审阅并运行 `bash -n`、`systemd-analyze verify`；样例不代表已在目标环境安装。安装后探针只访问回环，并提供规范 Host：

```sh
/usr/local/bin/node /opt/ultimate-calendar/current/deploy/check-health.mjs \
  --url http://127.0.0.1:3210/readyz --host calendar.example.invalid
systemctl status ultimate-calendar.service --no-pager
ss -ltnp '( sport = :3210 )'
```

探针 0 表示就绪且备份正常，1 表示未就绪，2 表示可服务但备份降级；安装器只在 0 时认定成功并 enable 服务。健康响应不包含正式资料。另需由管理员验证实际 HTTPS 入口、证书、Origin／Host 与配对，但不会由安装器改动反向代理。

所有 CLI 配对／备份操作以服务用户运行，避免 root 创建 0600 状态库后服务用户无权读取：

```sh
runuser -u ultimate-calendar -- /usr/local/bin/node /opt/ultimate-calendar/current/dist-server/cli.mjs \
  pair --data-dir /var/lib/ultimate-calendar/data
```

一次性码只在私有管理员终端交给用户，不放日志或聊天记录。升级时先正常停止原进程，用原版后端做安全备份，再切换代码和 unit。持久目录及已有配置（包括 ai-credentials.json）不覆盖；HTTPS 来源若与现有配置不同，安装器停止，须单独审阅来源变更。

## 回滚与恢复边界

新版本健康失败时，安装器停止新进程并回到之前代码／unit；首次部署失败则停服并保留私有数据以便检查。成功升级会记录一个可回退 release，手动回滚方案：

```sh
bash /opt/ultimate-calendar/current/deploy/rollback-backend.sh /usr/local/bin/node
```

手动回滚先停止并备份当前正式资料，核验两版清单，再切换并重新检查健康。它只回退代码和 unit，不恢复数据库或丢弃期间已保存内容；只适用于清单声明的兼容存储版本 1。未来涉及不兼容存储迁移时必须独立设计受控恢复，不能靠软链接当作数据回滚。

本包已有 `restore --backup-file <安全JSON绝对路径> --data-dir <全新或空目录>`，父目录须存在；恢复采用校验、同级暂存和回读核对，新资料实例隔离旧队列。它不覆盖运行库、不恢复设备会话／AI Key／VAPID，也不上传 Windows 数据。恢复后需重新配对，由手机填写 Key 或管理员另行配置；需要切换恢复目录时另行核对权限、余额和关系后再改 unit。回滚到旧版代码会保留手机管理文件，但旧版可能尚不支持读取，不能把“文件仍在”当作 AI 已可用。
