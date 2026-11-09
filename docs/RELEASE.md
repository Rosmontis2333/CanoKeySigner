# 本地发布构建与核验

在源码根目录执行 `npm ci` 后运行 `npm run release`。该命令先执行本地回归，再使用同一 Node.js、依赖安装、进程环境和 Vite 配置，分别对联网与离线版本构建两次。文件路径、字节数和 SHA-256 全部相同后才生成发布目录。

发布目录使用版本号与内容摘要命名。准备期间的文件位于临时目录，检查通过后移入最终位置。重复生成完全相同的目录时核对已有文件，内容不一致时停止。失败时清理本次临时文件。

| 文件或目录 | 用途 |
| --- | --- |
| dist/ | 联网静态站点 |
| dist-offline/ | `connect-src 'none'` 的手动签名静态站点 |
| source/ | 应用、测试、脚本、锁文件及操作和协议文档快照 |
| build-info.json | 构建版本、Node/npm/系统/架构、源文件摘要、两种构建的逐文件摘要及重复构建结果 |
| dependencies.json | 全部锁文件包条目、版本、registry 来源、integrity、dev/optional 标志、安装钩子和许可证记录位置 |
| notices/ | 从当前安装中复制的 LICENSE、COPYING、NOTICE 和 COPYRIGHT 文件 |
| SHA256SUMS | 发布目录内所有其他文件的 SHA-256，包含源码、说明、依赖记录和许可证副本 |

在发布目录执行校验。macOS 使用以下命令。

```sh
shasum -a 256 -c SHA256SUMS
```

Linux 可使用 `sha256sum -c SHA256SUMS`。将收到的文件摘要与可信来源提供的同一清单比较。校验和可发现内容变化，发布者身份需通过清单的分发来源核对。

源码快照保留 package-lock.json 的精确包版本和 npm integrity。重新安装构建可在 source/ 下执行。

```sh
npm ci
npm test
npm run build
npm run build:offline
```

将两个产物目录的路径和摘要与 build-info.json 的 builds 字段比较。重复构建检查针对当前安装与工具链，全新安装、不同 Node/npm 或系统架构的比较应保存为独立证据。当前验证环境见构建记录。

Vite 会读取调用环境以及本地 `.env` 文件。发布包排除这些本地配置文件，其实际效果体现在最终 HTML、JavaScript 和对应摘要中。使用自定义 RPC 时，应在干净安装中明确提供相同配置后比较。需要原样复核时保留私下管理的配置副本，凭据不应写入公开源码。

依赖清单覆盖锁文件中的全部包，包含开发库和其他平台的可选二进制。installed 表示本机实际存在的安装，缺少安装的可选平台包只记录锁文件元数据。packagesWithoutNoticeFiles 与 packagesWithoutLicenseMetadata 分别列出缺少随包许可证文件或许可证字段的项目，源文件中的声明仍需按包核对。清单记录原有许可证文本和元数据，不统一改写许可证。WalletConnect Community License 副本也包含在静态产物与 notices 中。

锁文件标记的安装脚本记录在 hasInstallScript，当前实际安装钩子记录在 installScripts。esbuild 的 postinstall 会核对或获取平台二进制，node-gyp-build 可使用预编译二进制或本机构建。lockfile 的安装标记与当前 package.json 钩子可能不同，两者均保留以便核对。执行 `npm audit --json` 可单独保存当时的依赖安全公告结果。

静态站点默认部署在来源根路径，保留对应目录中的 index.html、assets 与许可证文件。自托管 HTTPS 服务应提供 `X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`X-Content-Type-Options: nosniff` 与 `Referrer-Policy: no-referrer`，与项目开发和预览服务保持一致。离线站点的 HTML 保留独立的严格 CSP。

发布脚本检查页面版本、离线 CSP 和已知网络实现标记，并逐字节比较两次构建。硬件兼容性、真实链上执行、第三方 dApp、操作系统权限和独立代码审查按开发计划另行验收。[开发计划](DEVELOPMENT_PLAN.md) · [当前进展](APPLICATION_STATUS.md)
