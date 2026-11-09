# GitHub Pages 发布

仓库 main 分支推送后，GitHub Actions 安装锁定依赖、运行本地回归、构建联网和离线版本，再把联网版本 dist 发布到 GitHub Pages。Pull Request 执行构建检查，手动发布可在 Actions 中运行 Deploy GitHub Pages。

Vite 使用相对 base，首页、资源、动态模块和许可证链接支持 `https://用户名.github.io/CanoKeySigner/` 形式的项目路径。GitHub Pages 的 HTTPS 页面可以请求浏览器设备和摄像头授权，新来源需由操作者重新批准。

## 仓库配置

1. 打开仓库 Settings → Pages。
2. 在 Build and deployment 的 Source 中选择 GitHub Actions。
3. 打开 Actions → Deploy GitHub Pages，查看构建和部署结果。首次发布也可点击 Run workflow，分支选择 main。
4. 如 github-pages 环境要求人工批准，在对应部署任务中批准后继续。

工作流通过 GitHub 自动提供的 GITHUB_TOKEN 和 OIDC 部署，deploy 任务授予 pages:write 和 id-token:write。环境或组织策略若限制 Actions，应允许本仓库工作流和固定版本的官方 actions。[GitHub 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## 可选 RPC 来源

在 Settings → Secrets and variables → Actions → Variables 中配置 CANOKEY_EVM_RPC_ENDPOINTS 或 CANOKEY_SOLANA_RPC_ENDPOINTS，值沿用 RPC 文档中的 JSON 数组。留空使用内置公共端点，设为 `[]` 清空对应来源。

这些值会进入公开静态产物，应使用可以公开的端点配置。本地 .env 文件不随 Git 上传，CI 通过上述 Variables 取得自定义来源。WalletConnect Project ID 已内置。[RPC 配置格式](RPC_PROTOCOL.md)

## 本地 GPG 提交签名

本项目使用本地 OpenPGP 密钥签署 Git 提交，签名密钥指纹为 `C67A868FEB6F798A1762587DA98AAAAAAAAAAAAA`，长 key ID 为 `A98AAAAAAAAAAAAA`。

如 GitHub 的提交页面没有显示 Verified，在账户 Settings → SSH and GPG keys 中添加该密钥的公钥，并确认提交邮箱已在 GitHub 验证。可以在本机导出公钥。

```sh
gpg --armor --export C67A868FEB6F798A1762587DA98AAAAAAAAAAAAA
```

如 GPG 弹出本机口令窗口，由操作者在该窗口输入口令。仓库的签名配置仅用于本地 Git 提交。Pages 工作流不需要接收 GPG 私钥或口令。

检查本地提交签名可使用以下命令。

```sh
git log -1 --show-signature
git verify-commit HEAD
```

GitHub Pages 的页面 CSP 来自 HTML，Vite 本地服务配置的响应头仅作用于本地预览。服务器侧头部由托管服务控制。[Vite 部署说明](https://vite.dev/guide/static-deploy.html#github-pages)
