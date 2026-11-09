# CanoKeySigner 0.1.0 交付说明

交付日期为 2026-11-09。交付内容为本地运行或自托管的静态签名应用、源码、操作说明及发布记录。本轮测试已按用户要求停止，下述验收状态来自已有记录。

## 交付文件

当前发布标识为 `canokey-signer-0.1.0-8a76529e9a20`。发布环境为 macOS arm64、Node.js v22.23.1、npm 10.9.8。

| 交付项 | 位置与内容 |
| --- | --- |
| 联网应用 | `release/canokey-signer-0.1.0-8a76529e9a20/dist/` |
| 离线应用 | `release/canokey-signer-0.1.0-8a76529e9a20/dist-offline/` |
| 发布源码快照 | 发布目录内 `source/`，包含应用、测试、构建脚本、锁文件和当时的文档 |
| 构建记录 | `build-info.json`，记录版本、构建环境、源文件摘要和产物摘要 |
| 依赖清单 | `dependencies.json`，包含全部 272 个锁定包条目，其中本机安装 223 个 |
| 许可证副本 | `notices/`，包含已安装包随附的许可证及声明文件 |
| 文件校验和 | `SHA256SUMS`，覆盖发布快照中的文件 |

本文档随当前工作区交付。发布包内的文件以该包的构建记录和校验和清单为准。[构建记录](../release/canokey-signer-0.1.0-8a76529e9a20/build-info.json) · [依赖清单](../release/canokey-signer-0.1.0-8a76529e9a20/dependencies.json) · [校验和](../release/canokey-signer-0.1.0-8a76529e9a20/SHA256SUMS)

## 功能范围

首页按币种选择 OpenPGP 现有槽位和地址，再进入手动签名或 WalletConnect。EVM 链信息由交易、EIP-712 Domain 或 WalletConnect 请求提供，界面只读显示，并解析内置常见链名。WalletConnect Project ID 内置为 `d2a8b6044c46a77b4de519960103175c`。

| 币种 | 已实现能力 | 签名与导出 |
| --- | --- | --- |
| EVM | type 0/1/2 的 JSON/Hex，原生币与已知 ERC-20、ERC-721/1155 调用，personal_sign、EIP-712 v4 | secp256k1 硬件签名、low-S 和恢复账户核对，导出签名交易或消息签名 |
| Bitcoin | PSBT v0/v2，P2PKH、原生/包装 P2WPKH、标准 P2SH/P2WSH 多签，SIGHASH_ALL | 手动签名，保留其他签名和未知字段，导出部分签名 PSBT，签名齐备后可提取原始交易 |
| Solana | legacy/v0/v1，ALT 上下文，已知 System/SPL Token/Token-2022/ATA/Compute Budget/Memo 分支，受限 offchain v0/v1 消息 | Ed25519 精确原消息签名，核对其他已有签名，导出部分签名交易或消息签名 JSON |

WalletConnect 面向 EVM 和 Solana。EVM 实现 eth_signTransaction、eth_sendTransaction、personal_sign、eth_signTypedData_v4。Solana 实现 solana_getAccounts、solana_signTransaction、solana_signAllTransactions、solana_signAndSendTransaction 和受限 solana_signMessage。批量最多 8 笔，逐笔批准。

EVM 与 Solana 提供可选 RPC 状态读取、费用与执行检查，以及签名后的独立批准广播和状态查询。Bitcoin 采用手动签名流程。PIV 按本次要求暂留。[RPC 配置与行为](RPC_PROTOCOL.md) · [提交协议](BROADCAST_PROTOCOL.md)

## 启动方式

设备连接需要支持 WebUSB、Web Locks 的桌面 Chromium，以及 localhost 或 HTTPS 安全上下文。以下命令在工作区根目录执行。

```sh
npm ci
npm run preview -- --outDir release/canokey-signer-0.1.0-8a76529e9a20/dist --port 4173 --strictPort
```

联网页面为 `http://127.0.0.1:4173/`。离线版本使用以下命令。

```sh
npm run preview -- --outDir release/canokey-signer-0.1.0-8a76529e9a20/dist-offline --port 4174 --strictPort
```

离线页面为 `http://127.0.0.1:4174/`，其 CSP 使用 `connect-src 'none'`。已有预览服务可直接使用，端口由实际启动参数确定。

修改源码后可运行 `npm run build` 或 `npm run build:offline` 生成相应静态产物。自托管时将对应目录部署到来源根路径，并保留资源与许可证文件。[完整运行手册](../README.md) · [发布与自托管说明](RELEASE.md)

## 使用流程

1. 连接 CanoKey，完成浏览器设备选择，核对现有槽位、地址、算法和 PIN 剩余次数。
2. 选择币种、槽位与地址。Bitcoin 明确选择网络，Solana 明确选择 cluster。
3. 导入完整交易或消息，选择实际编码，解析并核对全部字段、金额、费用和授权效果。
4. 如需 RPC，核对来源后主动读取，并对补全或更新后的内容重新确认。
5. 勾选确认，只在本地页面填写 OpenPGP 用户 PIN，按设备策略触摸，等待验签与认证退出结果。
6. 下载签名结果。EVM/Solana 的广播另行批准，提交后保存交易标识和状态记录。

签名批准有效期为五分钟，RPC 上下文最多两分钟。设备发现、PIN 验证、签名命令与认证退出边界均检查有效期。输入、账户、来源变化或取消会作废当前审查。等待设备选择时可取消页面任务，系统选择窗口由操作者手动关闭。

PIN 不持久化，错误 PIN 单次尝试，失败后由操作者重新发起。页面在认证退出未确认时提示拔插设备。签名结果和提交记录保存在页面内存中，刷新前应下载保存。[签名与取消路径检查](SIGNING_REVIEW.md)

## 已有验证记录

| 验证项 | 已有结果与范围 |
| --- | --- |
| 本地自动化测试 | 390 项通过，包含格式、签名、批准、取消、过期、并发及模拟设备/RPC 路径 |
| 构建 | 严格 TypeScript、联网与离线构建通过，两种产物各连续构建两次，逐文件摘要一致 |
| WalletConnect relay | 33 项通过，使用官方 SignClient 2.26.0 和真实 relay，设备及 RPC 状态使用合成数据 |
| CanoKey 基础真机签名 | SIG Ed25519 的 98 字节消息、AUT secp256k1 的 32 字节摘要已完成硬件签名及 Node/OpenSSL 独立验签 |
| 实际 RPC | 已记录公共 Devnet/Sepolia 的只读查询及模拟错误路径，成功链上执行仍待验收 |
| 应用真机测试材料 | 已准备 9 组离线输入并核对参考摘要或序列化，实际设备签名未完成 |

9 组材料覆盖 EVM type 0/1/2、Bitcoin P2WPKH、Solana legacy/v0，以及 255/256/1331 字节完整离链消息。材料使用此前已验签公开证据中的公钥，本轮停止前未完成当前设备公钥的重新读取和匹配。[真机基础记录](hardware/OPENPGP_2026-11-09.md) · [relay 记录](walletconnect/relay-2026-11-09.json) · [应用验收材料](hardware/APPLICATION_ACCEPTANCE.md)

## 限制与未完成验收

- 真机应用交易、完整第三方 dApp 联合流程、真实节点广播与成功链上执行、Windows/Linux 设备权限及跨系统矩阵尚未完成。
- Solana 完整签名消息受 CanoKey 1331 字节容量限制。未知指令、无法解析的 ALT、未知 Token 扩展及 Hook 账户按当前策略拒签，普通 Token-2022 Transfer/TransferChecked 仍需扩展状态核对。
- Bitcoin 使用现有固定公钥，HD 私钥派生和 Taproot 输入签名超出当前支持范围。UTXO 当前是否未花费仍需链上核对。
- EVM ABI 解释和 RPC 模拟依赖已有规则与所选端点，合约实际行为及未来执行状态需要结合外部状态判断。
- 设备触摸确认人在场，交易内容核对依赖本地页面，浏览器与运行环境属于信任边界。
- 依赖清单标出了 6 个已安装包缺少独立许可证文件、1 个包缺少许可证元数据，具体项目及已有声明见 dependencies.json。

本轮测试在上述状态停止，未完成项按未完成交付记录，不计为真机或链上验收通过。[当前开发进展](APPLICATION_STATUS.md) · [原开发计划](DEVELOPMENT_PLAN.md)
