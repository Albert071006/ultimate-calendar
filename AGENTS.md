# 项目维护约定

- 本目录是公开源码。功能修改完成并通过检查后，同步提交到 `Albert071006/ultimate-calendar`；用户已要求后续更新持续同步 GitHub。
- 日常使用的软件和个人资料可能位于其他目录。不要把私人开发仓库的历史直接推到公开仓库，也不要上传真实账单、课表、QQ 账号、群消息、访问令牌、API Key、数据库或备份。示例与测试使用合成数据。
- 发布前更新 `package.json`、`package-lock.json` 的版本和对应的 `docs/release-notes/<version>.md`，执行类型检查、测试、构建及打包应用的隔离冒烟验证。
- 稳定版使用 `v<version>` 标签。推送版本标签会触发 Windows release 流水线；普通提交不发布安装包。
- `npm run package` 只打包，明确禁止隐式上传。安装包、blockmap、`latest.yml`、`SHA256SUMS.txt` 必须来自同一次构建并经校验；发布脚本先上传草稿，全部附件核验通过后才设为正式版本。
- 更新必须保留本机资料和加密凭据；保持应用标识、用户数据目录和既有迁移机制兼容。不要通过清空资料解决升级问题。
- 不在客户端嵌入 GitHub 发布凭据。GitHub Actions 仅在发布步骤使用内置 `GITHUB_TOKEN`，用户下载公开更新无需令牌。
