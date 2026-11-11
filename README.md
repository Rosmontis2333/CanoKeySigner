# CanoKeySigner

GitHub Pages 自动发布与本地 GPG 提交签名的配置步骤见发布文档。[GitHub Pages 配置](docs/GITHUB_PAGES.md)

使用 CanoKey 3.0.3 现有 OpenPGP SIG/AUT 密钥，在本地审查、签名、验签并导出 EVM、Bitcoin 和 Solana 交易。首页按币种选择兼容槽位与地址，提供手动签名和 EVM/Solana WalletConnect 连接。

当前版本为 0.1.0。已完成 SIG Ed25519 和 AUT secp256k1 的基础真机签名与独立验签。交易、批量签名及广播的自动化检查使用合成密钥和模拟设备，真实交易、第三方 dApp 及跨系统验收仍在进行。[当前开发进展](docs/APPLICATION_STATUS.md) · [基础真机证据](docs/hardware/OPENPGP_2026-11-09.md)

## 本地运行

使用 Node.js 22.12 或更新版本。本项目当前验证环境为 Node.js 22.23.1、npm 10.9.8、macOS arm64。设备连接需要支持 WebUSB 和 Web Locks 的桌面 Chromium，以及 localhost 或 HTTPS 页面来源。

```sh
npm ci
npm test
npm run build
npm run preview -- --port 4173 --strictPort
```

打开 http://127.0.0.1:4173/。开发模式使用 `npm run dev`，默认端口为 5173。页面底部显示来自 package.json 的构建版本。

离线产物单独构建和运行。

```sh
npm run build:offline
npm run preview -- --outDir dist-offline --port 4174 --strictPort
```

打开 http://127.0.0.1:4174/。离线构建使用 `connect-src 'none'`，适用于手动签名和导出。两种构建都是静态站点，需要通过本地 HTTP 或自托管 HTTPS 服务打开。

## 签名操作

1. 点击“连接 CanoKey”并选择设备。读取完成后检查槽位、公钥对应地址、触摸策略及 PIN 剩余次数。
2. 选择币种、已有槽位和地址。Bitcoin 另选 mainnet 或 testnet/signet，Solana 另选 cluster。EVM 链信息从交易或结构化消息内容读取。
3. 导入完整交易或消息，自动识别输入编码，点击解析。逐项核对账户、接收方、金额、费用、原始内容及授权效果。
4. 如需链上上下文，核对来源后主动读取 RPC。端点将收到相关账户和交易内容。更改输入或来源后重新审查。
5. 核对审查内容，只在本地页面填写 OpenPGP 用户 PIN，点击“批准并硬件签名”。根据设备策略触摸，等待签后验签完成，再下载结果。
6. EVM/Solana 的广播需对已签名结果另行批准。保存交易标识和状态记录，结果不确定时使用状态查询。刷新会丢失页面内的签名结果与提交记录。

错误 PIN 不会自动重试。认证退出失败、操作超时或取消后，按页面提示拔插设备并重新读取。签名期间切换账户、断开设备或退出页面会作废当前审查。

签名批准自确认起五分钟有效，RPC 上下文最多两分钟有效。设备读取、验证 PIN、等待触摸或退出认证期间过期时，本次结果作废，需要重新审查后批准。

设备选择器为空或接口被占用时，关闭其他页面及正在访问该设备的管理工具或 GnuPG/CCID 会话，再拔插并重连。同源标签页通过 Web Locks 串行访问设备，不同程序的设备占用需要在各程序中释放。

等待设备选择时可点击页面“取消操作”结束本次读取，再手动关闭仍打开的系统设备选择窗口。取消后迟到的选择结果会被忽略。

## 支持范围

| 币种 | 手动输入与输出 | 连接能力 | 当前边界 |
| --- | --- | --- | --- |
| EVM | type 0/1/2 的 JSON/Hex，personal_sign、EIP-712 v4，导出已验证签名 | eth_signTransaction、eth_sendTransaction、personal_sign、eth_signTypedData_v4 | 已知原生币、ERC-20、ERC-721/1155 调用，未知 calldata 和合约创建拒签 |
| Bitcoin | PSBT v0/v2 的 Base64/Hex/二进制，部分签名 PSBT，签名齐备后可导出原始交易 | 手动签名 | P2PKH、原生/包装 P2WPKH、标准 P2SH/P2WSH 多签，完整前序交易，SIGHASH_ALL |
| Solana | legacy/v0/v1 transaction/message，明确编码，受限 offchain v0/v1 消息 | getAccounts、signTransaction、signAllTransactions、signAndSendTransaction、signMessage，方法名前缀为 solana_ | 完整 ALT、已知指令，原始签名消息须在 1331 字节内，批量最多 8 笔并逐笔批准 |

固定槽位地址来自已有公钥。Bitcoin 的 BIP32 路径不触发卡内派生，Taproot 输入签名不可用。Token-2022 已实现部分操作，普通 Transfer/TransferChecked、未知扩展、额外 Hook 账户及未知程序保持只读。RPC 模拟成功后仍需满足相同的解析和签名策略。PIV 按当前要求暂留。[Solana 格式与操作](docs/SOLANA_PROTOCOL.md)

## WalletConnect 与 RPC

手动签名自动识别 EVM 交易 JSON / Hex、EIP-712 JSON 和可阅读文本。Solana 自动识别Base64、Base58、Hex 编码的 transaction / message、标准 offchain 消息，普通文本生成 offchain v1。纯 Hex、以 `0x` 开头或具有编码特征的输入按编码数据处理，编码数据损坏时需修正后重新解析。BTC 自动识别 Base64 / Hex PSBT。文件导入自动识别 UTF-8 文本与二进制交易，沿用同一审查规则。广播仍需单独批准。

在 EVM 或 Solana 中点击左侧“连接 WalletConnect”，在弹窗输入 dApp 的 v2 连接地址，也可点击“启动摄像头扫码”。识别后确认连接，再通过请求弹窗批准链、账户及方法。连接后的交易与消息请求自动弹窗，逐笔审查并签名。关闭待处理请求弹窗会拒绝该请求。扫码优先请求 1080p 画面，支持的摄像头会启用连续对焦。浏览器原生二维码识别和本地解码配合中心区域、全帧多分辨率扫描，支持倒色二维码。连接多台摄像头时可在预览上方切换。将完整二维码放在画面中央，保留边缘空白并保持对焦清晰。摄像头画面在本地解析，关闭弹窗、切换账户或页面进入后台时停止采集。Project ID 内置为 `d2a8b6044c46a77b4de519960103175c`。连接批准后，每次请求仍核对会话、chainId、账户、方法和有效期。EVM 连接提案可包含未内置 RPC 的链，EIP-712 和可阅读消息在核对授权账户与请求链后签名。发送交易请求到达时检查 RPC，缺少来源会返回错误，后续消息请求可继续处理。广播要求独立批准。[提交操作与状态含义](docs/BROADCAST_PROTOCOL.md)

联网构建使用固定 WalletConnect relay 和 Verify 来源。RPC 默认包含 Solana 公共 cluster 端点、Ethereum、Base、Arbitrum One、BNB Smart Chain 和 Arc 主网端点，按签名内容或 WalletConnect 请求的 chainId 自动匹配。Solana 来源可通过 `.env.local` 的 `CANOKEY_SOLANA_RPC_ENDPOINTS` 配置，设为 `[]` 可清空。端点 URL 会进入静态产物，配置与页面来源的 CORS 权限需在构建前核对。[配置格式、数据披露和上下文限制](docs/RPC_PROTOCOL.md)

PIN 不进入日志、WalletConnect、RPC 或持久存储。JavaScript 会尽快清除引用与缓冲，无法保证物理内存擦除。WalletConnect SDK 可保留浏览器会话数据，应用在新页面初始化时断开恢复的旧会话，并重新要求硬件账户授权。

## 发布与复核

```sh
npm run release
```

该命令运行本地测试，对联网与离线产物分别构建两次并逐文件比较，再在 `release/canokey-signer-0.1.0-<摘要>/` 生成静态站点、源码快照、依赖及许可证记录和 SHA-256 清单。它验证当前工具链与配置下的重复构建一致性，跨平台和全新安装的结果需单独比较。生成的目录可供本地复核或交付。[发布包内容与核验方法](docs/RELEASE.md)

`npm run test:relay` 通过官方 SDK 验证真实 relay 互操作，设备和 RPC 使用合成数据。`npm run test:rpc` 与 `npm run test:rpc:evm` 对公共测试网络执行只读查询及模拟。发布仍需完成真机交易、实际第三方 dApp、跨系统设备矩阵和测试网络执行验收。[开发计划与验收条件](docs/DEVELOPMENT_PLAN.md)

已有固定的三链交易与 255/256/1331 字节消息材料，可在重新读取并匹配设备公钥后逐项验收。[应用真机验收材料](docs/hardware/APPLICATION_ACCEPTANCE.md)
