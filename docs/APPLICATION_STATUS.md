# 实际应用开发进展

2026-11-09 交付说明。本轮测试已按用户要求停止，当前功能、运行方式、发布快照和未完成验收统一列入交付文档。[交付说明](DELIVERY.md)

2026-11-09。整体目标保持为开发计划中的三链签名应用。PIV 依照用户要求暂留。EVM 交易类型范围为 0、1、2。

界面按最新要求收敛为币种选择、槽位与地址选择、手动签名和 WalletConnect 两个入口。首页提供 EVM、Bitcoin、Solana 卡片。Bitcoin 仅提供手动签名，WalletConnect 入口适用于 EVM 和 Solana。侧栏显示解析得到的 EVM 链信息、兼容槽位、地址类型及可复制的地址。EVM chainId 从交易或 EIP-712 Domain 读取，页面提供只读显示。诊断测试入口已从产品页面移除，原有硬件回归测试保留在代码与测试中。

## 当前可运行流程

在本地运行 `npm run dev`，或先 `npm run build` 再运行 `npm run preview`。页面提供设备读取，以及 EVM、Bitcoin、Solana 交易导入、审查、确认、OpenPGP 硬件签名、验签和文件导出。

EVM 接受交易 JSON 或序列化 Hex，支持带 chainId 的 legacy、type 1/2。手动流程自动读取交易 chainId，粘贴或导入时显示链名和数字标识。JSON 必须明确给出 type、chainId、nonce、gasLimit、to、value、data 及对应费用字段，所有数值使用整数字符串。type 1/2 必须明确提供 accessList。签名策略支持原生币转账、ERC-20 transfer/approve/transferFrom、ERC-721 transferFrom/approve/两种 safeTransferFrom，以及 ERC-721/1155 setApprovalForAll、ERC-1155 safeTransferFrom/safeBatchTransferFrom。未知 calldata、未满足参数审查规则的调用和合约创建显示原始内容并拒签。已签名交易可检查并验证原有签名。

代币调用使用现有 micro-eth-signer 的公开 ABI 编解码接口。approve(address,uint256) 和 transferFrom(address,address,uint256) 的 ERC-20/ERC-721 编码相同，审查同时展示数量及 Token ID 两种含义，并要求核对目标合约。setApprovalForAll 展示 operator、授予/撤销和该合约内当前及未来持有资产的范围。ERC-721 payable 方法允许携带原生币，审查单列 wei 金额，包含共享编码的 approve/transferFrom。ERC-20 transfer、setApprovalForAll 和 ERC-1155 转移要求 value 为零。函数匹配只解释标准 ABI 参数，目标合约身份、实现、代理和实际行为仍需核对。[ERC-20](https://eips.ethereum.org/EIPS/eip-20)、[ERC-721](https://eips.ethereum.org/EIPS/eip-721)、[ERC-1155](https://eips.ethereum.org/EIPS/eip-1155)

动态回调 bytes 完整显示 Hex 和长度。ERC-1155 批量转移逐项显示 Token ID 与最小单位数量，保留重复 ID、零数量和原始顺序，要求两组数组长度相等，接受空批次。应用上限为每数组 128 项、回调数据 4096 字节和完整 calldata 16 KiB。通用解码前检查动态偏移和长度，解码后逐字节重编码核对。动态区段须连续、按参数顺序排列，地址/布尔/填充必须规范，重叠、间隙、截断和尾随数据均拒签。手动入口与 WalletConnect eth_signTransaction 共用该审查路径。[Solidity ABI](https://docs.soliditylang.org/en/latest/abi-spec.html)

EVM 手动签名中的“签名内容”可选择交易、可阅读 personal_sign 消息或 EIP-712 v4。personal_sign 接受 1–16384 字节的完整 UTF-8，审查展示 JSON 转义正文、精确 Hex 字节、字节数和跨网络复用范围。WalletConnect 按 `[hexMessage, address]` 接收同一能力，拒绝二进制、控制和隐藏字符以及账户不匹配的请求。

EIP-712 v4 接受完整 JSON，显示 domain、primaryType、全部类型、全部消息字段及摘要。手动流程从 domain 读取 chainId，WalletConnect 则额外核对它与已批准请求链的一致性。支持标准原子类型、动态/固定数组和嵌套结构。类型/字段上限为 64/256，数组上限 256，消息编码深度/节点上限为 20/2048。标识符上限为 64 字符，展开类型定义总字符上限为 524288。所有结构字段须明确提供，null/省略结构、未知类型及非标准 domain 字段会拒签。整数使用规范字符串或安全整数十进制 JSON 字面量。隐藏 Unicode 在审查中转义。WalletConnect 参数为 `[address, typedDataJsonOrObject]`。

消息使用独立的不可变审查对象与单次批准，经过相同的 OpenPGP 公钥/算法/触摸策略核对和认证退出流程。输出 low-S 的 65 字节 r/s/v，使用公开的 EIP-191/EIP-712 验证 API 再次复核。EIP-712 格式编码使用现有 Noble Keccak，按官方 Ether Mail 向量和公开 micro-eth-signer 签名 API 差分验证。标准和固定向量见 [ERC-191](https://eips.ethereum.org/EIPS/eip-191)、[EIP-712](https://eips.ethereum.org/EIPS/eip-712)、[官方示例](https://github.com/ethereum/EIPs/blob/master/assets/eip-712/Example.js)。

Bitcoin 接受 PSBT v0 / v2 的 Base64、Hex 和二进制文件，支持 P2PKH、P2WPKH / P2SH-P2WPKH，以及标准 P2SH / P2WSH / P2SH-P2WSH m-of-n 多签，签名模式为 SIGHASH_ALL。P2PKH 和旧式 P2SH 多签接受压缩及未压缩 SEC1 公钥，SegWit 多签要求压缩公钥。账户选择器提供两种 SegWit 地址及两种 P2PKH 地址。用户明确选择 mainnet 或 testnet/signet。全交易审查包含 outpoint、完整前序交易与 UTXO 一致性、脚本类型、所有权、所有输出、金额、矿工费、费率估计、locktime、sequence/RBF，以及每个已有签名的验证结果。多签展示门槛、有序参与公钥、完整签名脚本和本机实际使用的公钥编码。待签清单包含当前公钥参与、尚未签署且未达到签名门槛的输入。其他参与者的签名和未知 PSBT 字段在导出时保留，附签后核对完整字段集合。

多签模板允许 1 ≤ m ≤ n ≤ 16，并拒绝重复曲线点、非规范模板与错误脚本哈希。P2SH redeemScript 上限为 520 字节，具体可容纳公钥数量受编码长度约束。所有受支持模板可以混合在同一交易中，每项使用对应的 legacy 或 BIP143 摘要。Legacy SIGHASH_ALL 通过公开 RawOldTx coder 序列化完整交易，避免调用库的私有签名方法。vsize 估计包含各输入的最大 scriptSig/witness、push/CompactSize 开销和混合交易的空 witness。签名齐备按各脚本门槛判断。独立校验依据见 [BIP 174](https://bips.dev/174/)、[BIP 143](https://bips.dev/143/)、[BIP 16](https://bips.dev/16/)。

PSBT v2 展示 fallback locktime、原始可修改标志和每个输入的高度/时间约束，复用 BIP 370 锁定时间计算。SIGHASH_ALL 签名后清除输入/输出可修改位，保留其余已知标志。可修改标志中的保留位会拒签。原始 map 经公开 coder 附加签名并逐字段比较，保留可选字段省略、显式零值、其他签名及未知/proprietary 数据。v2 输入/输出数量在完整解码前限制为最多 128，签名后总大小限制为 1 MiB。[BIP 370](https://bips.dev/370/)

BTC 默认导出与输入同版本的部分签名 PSBT，结果文本可切换 Base64/Hex，也可下载二进制文件。全部输入达到各自签名门槛、已有签名全部验证通过且 PSBT 只包含批准签名变化后，才能导出 finalize 后的原始交易。普通 ECDSA 输入可以包含 Taproot 输出。Taproot 输入、未声明脚本模板、特殊 sighash 和已 finalize 输入会拒签。

Solana 接受明确标记的 Base64、Base58、Hex、二进制 transaction/message，支持 legacy/v0/v1。审查展示所有 signer、账户读写权限、fee payer、blockhash/nonce、指令账户索引、原始数据和已知操作解释。已接入 System、SPL Token 常见转移与授权/撤销/关闭/修改 authority/增发/销毁、已知 Token-2022 操作、ATA 创建、Compute Budget、Memo。未知指令保留完整结构并拒签。签名使用 Ed25519 精确原始消息，其他已有非空签名先验证后保留，仅替换当前 signer 的空签名槽。

Solana 受限消息签名支持标准 offchain v0/v1。手动可输入正文生成带当前 signer 的 v1 消息，或导入已有完整编码消息。WalletConnect solana_signMessage 接受 Base58 message 与匹配当前账户的 pubkey，按精确传入字节签名并返回 Base58 signature。审查展示全部 required signers、转义正文、完整 Hex 和网络复用范围。完整消息上限为 1331 字节，手动单 signer v1 正文上限为 1281 字节，v0 格式 0/1 另受 1232 字节规范约束。原始文本和交易字节会拒签。手动导出包含原消息和当前账户签名的 JSON。消息使用独立的不可变审查对象、单次批准和设备执行入口。[离链消息实现与限制](SOLANA_PROTOCOL.md)

v0 ALT 当前通过含 raw account data、owner、context slot、网络和明确来源的离线 JSON 快照解析。校验账户结构、激活边界、索引和地址顺序，快照明确标为未经链上验证。无法完整解析 ALT 时拒签。手动签名已支持可选可信 RPC 获取 ALT、费用与模拟，以及签名后的独立批准广播。所选 cluster 属于外部审查上下文，Solana 签名本身不携带该网络标识。[Solana 实现与限制](SOLANA_PROTOCOL.md)

审查绑定规范化交易、公钥、chainId 与完整字段。一次性批准绑定已有槽位，五分钟后过期。字段变更、设备重新读取、断连或页面退出会废弃审查，正在进行的任务会取消。设备签名前重新核对算法、公钥与触摸策略，签后验证签名、恢复账户和序列化交易的一致性。

默认联网构建仅在用户发起 WalletConnect 配对时动态加载官方 SignClient 2.26.0。内置用户指定的 Project ID `d2a8b6044c46a77b4de519960103175c`。SDK telemetry 已关闭，CSP 限制到 WalletConnect relay、Verify 服务与构建时配置的 RPC 来源，远程 dApp 图标不加载。用户填写 dApp v2 URI 后，先审查链、账户和方法的提案，再逐笔审查交易，使用相同的 OpenPGP 交易执行与验签路径返回签名结果。币种、槽位、地址变化和断连均使连接授权失效。BTC/Solana 的网络变化同样清除连接授权。EVM 根据 dApp 提案批准最多 256 条链，支持 accountsChanged / chainChanged 事件和已授权网络间的切换，每次请求均核对 namespace、链、方法与账户。

当前 WalletConnect 授予的能力为 EVM `eth_signTransaction` / `eth_sendTransaction` / `personal_sign` / `eth_signTypedData_v4`，Solana `solana_getAccounts` / `solana_signTransaction` / `solana_signAllTransactions` / `solana_signAndSendTransaction` / 受限 `solana_signMessage`。EVM 连接可授予未内置 RPC 的链及已实现方法，发送请求到达时检查 RPC，EIP-712 消息签名可直接进入审查。Solana 提交方法依照相应链的 RPC 配置授予。不满足 required namespaces 的连接提案会被拒绝。签名方法按协议返回消息签名或签名交易，EVM 提交方法返回交易哈希，Solana 提交方法返回第一签名。Bitcoin 的连接、bip122 namespace、账户与 PSBT 请求在协议入口拒绝，设备签名继续使用手动流程。

`npm run build:offline` 输出 `dist-offline/`，使用 `connect-src 'none'`，构建排除 WalletConnect SDK、RPC 传输、广播模块和 relay 代码。离线页面在 EVM/Solana 中提供两个模式入口，并明确提示 WalletConnect 需要联网构建。普通 `npm run build` 输出 `dist/`。两种构建都可本地运行，联网构建提供独立批准的广播。

## 验证

390 项测试、严格 TypeScript 检查、联网和离线生产构建通过。测试覆盖 EVM type 0/1/2、Bitcoin 单签与标准多签模板、多输入签名与整份 PSBT 字段保留、已有签名验证、完整前序交易与脚本拒绝路径、批准过期与单次消费、任务取消、完整签名后提取与篡改拒绝，以及独立广播和 WalletConnect EVM/Solana 提交。BTC vsize 估计也与完成签名的交易大小比较。

EVM 代币调用新增 18 项测试，使用开发参考依赖 Ox 的公开 ABI 编码器构造八种函数编码，核对 selector、完整参数、签名摘要绑定和导出交易。覆盖共享 selector 的多种解释、无限额度、撤销、payable 原生币金额、批次重复/空/零数量、最大 uint256、回调 bytes 长度与 128 项边界、地址和布尔填充、动态偏移别名/溢出/重排、尾随和截断拒绝。全部八种调用通过生产 OpenPGP 模拟设备与 WalletConnect 模拟会话逐笔签名，字段变更使旧签名无效。浏览器已检查能力说明且无控制台错误，实际硬件与第三方 dApp 验收仍待完成。[界面验收图](screenshots/evm-token-calls-2026-11-09.png)

Bitcoin v2 测试覆盖 BIP 370 官方的 24 个无效、14 个有效、10 个锁定时间向量，以及 native/wrapped SegWit、多输入、可修改标志更新、可选字段省略、显式 v0 版本、完整字段保留、截断、超大 count 和格式转换拒绝。模拟 OpenPGP 已贯通 v2 手动签名和同版本导出。新增 v2 尚需真机与独立工具端到端验收。

Bitcoin 新增 21 项测试，使用固定开发依赖 bitcoinjs-lib 7.0.5 构造并预先协签独立 PSBT，分别核对 v0/v2 的 P2PKH（两种公钥编码）、P2SH 多签（两种编码）、P2WSH 与 P2SH-P2WSH 的完整摘要及最终交易字节。覆盖六种输入混合、其他签名和未知字段保留、签名门槛不足/已满足、伪造 UTXO/脚本/签名、重复曲线点、非压缩 witness 公钥、非规范脚本和 P2SH 容量拒绝，以及 15-of-15 P2SH 和 16-of-16 P2WSH 的 CompactSize/vsize 边界。模拟 OpenPGP 对混合 v2 PSBT 连续签署六个已批准摘要，并验证逐项认证退出与最终导出。浏览器验证 BTC 能力说明和仅手动签名模式，控制台无错误，实际设备交易流程仍待验收。[界面验收图](screenshots/bitcoin-multisig-2026-11-09.png)

bitcoinjs-lib 7.0.5 默认 PSBT finalizer 会将多签脚本内的公钥压缩后再匹配，无法完成含未压缩公钥的 P2SH 多签参考交易。该用例仍通过它的公开 payments.p2ms/p2sh 构造最终 scriptSig，并与应用导出的完整交易逐字节比较。参考库仅用于测试，不进入应用构建。[参考库](https://github.com/bitcoinjs/bitcoinjs-lib)

EVM 自动链测试覆盖 type 0/1/2 的 JSON/Hex、常见与未知 chainId、EIP-712 Domain 识别、提案多链批准、逐笔请求网络匹配、namespace 方法边界，以及 SDK 初始化使用内置 Project ID。

EVM 消息测试覆盖官方 Ether Mail 摘要、全部整数位宽边界、bytes1–32、动态/固定数组、嵌套结构、递归和数量上限、重复字段、精度和隐藏 Unicode、错误账户/链和 high-S 规范化。SIG/AUT 模拟设备贯通两种方法的批准、精确摘要签名、认证退出和单次消费。WalletConnect 模拟生命周期验证消息审查、硬件执行和标准 65 字节响应。新消息流程尚需真机与真实 dApp 验收。

WalletConnect 模拟 SDK 会话覆盖连接提案批准、真实交易审查对象与 OpenPGP 模拟设备签名返回、重复/并发请求、错误 topic/chainId、过期请求、账户变化、提案确认迟到，以及签名期间取消后不返回结果。策略测试覆盖 EVM/Solana namespaces、参数与账户校验，以及 Bitcoin 配对/提案/请求在进入 SDK 或设备前被拒绝。已在浏览器检查币种切换和两个签名模式。内置 Project ID 已通过官方 SignClient 2.26.0 的双端真实 relay 验收，当前共 33 项。覆盖 EVM 与 Solana 的配对/批准、已声明签名方法、账户读取、拒绝的 4001 错误码和断连通知。EVM 交易分别验证 type 2，以及 setApprovalForAll 和 ERC-1155 safeBatchTransferFrom，dApp 端核对返回的原始 calldata。Solana 分别验证 legacy/v0 交易、ALT 上下文、其他已有签名保留，以及 offchain v0/v1 消息的 Base58 签名。硬件层使用专用测试密钥的模拟 OpenPGP，浏览器 WebUSB 与第三方 dApp 的组合仍待验收。[真实 relay 记录](walletconnect/relay-2026-11-09.json)

Solana 使用仅在开发依赖中的官方 Web3.js 1.98.4 进行动态差分，比较 legacy/v0、部分多签、ALT 消息字节及完整交易序列化结果。Node/OpenSSL 独立验证 Ed25519。测试包含原始消息输入、已有签名保留、ALT 可写/只读顺序、错误 owner/索引/激活状态、short_vec 规范性、截断、尾随字节、未知指令、nonce 顺序和容量拒绝路径。

Solana 离链消息新增 16 项测试，覆盖独立固定布局编码、Node/OpenSSL 签名、v0/v1 signer 与正文校验、隐藏字符/交易字节拒绝、1232/1331 字节边界、独立批准过期/单次消费及取消、消息/账户变更、WalletConnect 参数与响应。最大容量消息已通过模拟设备扩展 APDU，核对完整原始消息签名。浏览器检查交易、生成消息和导入消息三种模式的控件切换，当前尚需真机验收。[界面验收图](screenshots/solana-offchain-2026-11-09.png)

参考库限定其 Jayson 依赖为 5.0.0，以移除旧版本引入的 stream-json/uuid 安全公告。使用该版本后全部测试通过，当前 `npm audit` 返回 0 条已知漏洞。Web3.js 与 Jayson 均不进入浏览器运行时构建。Ox 0.9.3 新增为明确锁定的开发参考依赖，应用源码通过原有交易库与官方 WalletConnect SDK 工作。SDK 自身也将同一版本 Ox 列为传递依赖。

OpenPGP 模拟设备测试已贯通 EVM 与 Bitcoin 交易审查对象、一次性批准、VERIFY、精确 ECDSA 摘要签名、认证退出及交易重组。BTC 多输入任务捕获一次 PIN，按用户完整批准的输入清单逐项核对、VERIFY、签名和退出认证，失败或取消后停止后续输入。原有 secp256k1 与 Ed25519 基础算法已通过真机测试。应用交易流程仍需实际设备和独立交易工具的端到端验收。

内置链名覆盖 Ethereum、OP、Arbitrum、Base、Polygon、BNB Smart Chain、Avalanche C-Chain 及相应测试网。未登记名称的 chainId 保留数字显示，签名始终使用交易中的原值。名称依据官方网络资料核对。[Ethereum](https://geth.ethereum.org/docs/getting-started)、[OP Mainnet](https://docs.optimism.io/rust/kona/sdk/protocol/registry)、[OP Sepolia](https://github.com/ethereum-optimism/superchain-registry/blob/main/superchain/configs/sepolia/op.toml)、[Arbitrum](https://docs.arbitrum.io/chain-info)、[Base](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId)、[Polygon](https://docs.polygon.technology/pos/reference/rpc-endpoints)、[BNB](https://docs.bnbchain.org/developer-kit/bnbagent-sdk/networks/)、[Avalanche](https://build.avax.network/docs/rpcs/c-chain)

可运行 `npm run test:relay` 重复官方 SDK 的真实 relay 验收。追加报告路径可保存 JSON，例如 `npm run test:relay -- /tmp/canokey-relay.json`。该命令为单独启用的联网检查，使用独立的内存会话和专用测试密钥。常规 `npm test` 执行 390 项本地回归。脚本走生产连接控制器、审查对象和 OpenPGP 执行路径，dApp 端接收后复核签名与序列化结果。浏览器交互、真实设备触摸/PIN 和第三方 dApp 属于后续验收范围。

Solana WalletConnect 批量交易签名已接入，应用上限为每批 8 笔。开始签名前预检查全部交易，按原顺序逐笔展示并要求独立确认与 PIN/触摸。中途拒绝、过期、账户变化或失败会废弃整批结果，全部完成后才返回签名交易数组。新增 13 项本地测试验证边界、已有签名保留、并发与取消等路径。真实 relay 新增混合 legacy/v0/ALT 批次，以及签完首笔后拒绝整批的互操作检查。首次 relay 运行在 offchain v1 消息响应阶段超过 30 秒，随后完整重跑 20 项全部通过，未对签名请求加入自动重试。硬件使用专用测试密钥的模拟 OpenPGP，真实设备与第三方 dApp 批量验收仍待完成。[实现与限制](SOLANA_PROTOCOL.md)、[界面验收图](screenshots/solana-batch-2026-11-09.png)

Token-2022 新增显式手续费转移、Transfer Fee 配置/提取/归集、Memo 要求及 CPI Guard 开关，另覆盖基础增发/销毁/授权/关闭/冻结等已知操作和 ATA。金额、费率、来源、目标和保护设置的变化全部展示。普通 Token-2022 Transfer/TransferChecked 因未声明预期费用而拒签，未知扩展和额外 Hook 账户也拒绝。未读取的账户状态在审查中标明。官方 SDK 0.4.15 生成 55 组固定向量，通过 63 项新增格式与执行测试及 1 项 WalletConnect 单笔/批量测试。真实 relay 扩展为 22 项，新增 Token-2022 预期费用转移与 Memo 配置。参考 SDK 生成后移除，当前依赖审计为 0 条。真实设备与第三方 dApp 验收仍待完成。[实现与限制](SOLANA_PROTOCOL.md)、[界面验收图](screenshots/solana-token2022-2026-11-09.png)

Solana v1 已接入独立解析器，支持 transaction/message 导入、消息头资源审查、尾部签名槽、公钥匹配、已有签名保留及导出。完整消息在 1331 字节内可签名，超出设备容量的协议交易仍完整审查。v1 的 ComputeBudget 指令按 no-op 显示，Priority fee 按总 lamports 展示。新增 25 项格式与设备执行测试及 1 项 WalletConnect 混合版本测试。真实 relay 扩展为 23 项，核对单笔 v1 与 legacy/v0/v1 有序混合批次。开发参考依赖固定为 Kit 8.6.0 的 transaction-messages 与 transactions，使用公开编解码 API，当前依赖审计 0 条。真实设备、第三方 dApp、可信资源与费用上下文仍待验收。[实现与限制](SOLANA_PROTOCOL.md)、[界面验收图](screenshots/solana-v1-2026-11-09.png)

Solana 手动签名新增可选 RPC 读取与模拟，默认列出所选 cluster 的官方公共端点，支持构建时自定义来源。用户点击后核对 genesis、读取 ALT 原始账户、消息费用并按原始交易模拟，显示端点、slots、日志与两分钟上下文有效期。费用缺失或模拟失败使本次审查只读，取消或输入变化使在途结果失效。新增 18 项本地测试覆盖传输边界、来源/字节绑定、错误策略与过期。公共 Devnet 实测返回费用 5000 lamports，专用测试交易模拟为 InvalidAccountForFee，signable=false。已验证自定义 CSP 来源、CORS 预检及离线产物排除 RPC/relay。EVM/WalletConnect RPC、Token 扩展状态和真机流程仍待完成。[实现与操作](RPC_PROTOCOL.md)、[界面验收图](screenshots/solana-rpc-2026-11-09.png)

EVM 手动交易新增可选 RPC 上下文与执行检查，从交易 chainId 匹配来源。默认配置 PublicNode 的 Ethereum Mainnet 和 Sepolia，可在构建时替换。读取参考区块、nonce、pending nonce、余额、代码和费用，按原始 type 0/1/2 字段执行 eth_call/gas 估计。失败或状态不匹配使本次审查只读，来源和原始交易不变更，上下文两分钟后过期。新增 14 项测试及 Sepolia 只读实测通过，实测余额为 0、执行检查 -32000，signable=false。346 项全量测试和两种构建通过。WalletConnect RPC、成功执行与真机验收继续推进。[实现与限制](RPC_PROTOCOL.md)、[界面验收图](screenshots/evm-rpc-2026-11-09.png)

WalletConnect 交易请求现可显式读取 RPC，接收时固定参数，读取后重新审查与确认。Solana 缺失 ALT 进入等待状态，用户主动选择来源后读取补全。混合 legacy/v0/v1 批次先完成整批 RPC，任何一笔失败都阻止全部设备签名；通过后仍逐笔批准，最早上下文或请求到期使整批失效。来源变化清除旧审查，读取失败、取消、过期和会话变化均不会恢复旧结果。新增 15 项测试覆盖正常路径与并发/迟到结果等边界。官方 SDK 真实 relay 检查扩展至 25 项，RPC 远端状态与 OpenPGP 硬件使用合成测试数据。346 项全量测试和两种构建通过。浏览器检查了未连接状态说明与控件隐藏状态。成功链上执行、Token 扩展状态及真机/第三方 dApp 验收继续推进。[实现与限制](RPC_PROTOCOL.md)、[说明页验收图](screenshots/walletconnect-rpc-2026-11-09.png)

## 继续开发

手动 EVM 与 Solana 签名结果现可单独准备、批准广播并查询状态。提交前核对精确签名内容、全部协签、网络及新读取的费用与执行上下文，提交响应与本地标识匹配。响应不确定时按标识查询，当前页面内同一网络与标识最多尝试提交一次。界面每币种保留一条内存记录，可下载后结束记录。新增 18 项模拟测试，全量 364 项测试和两种构建通过。真实节点广播和链上执行仍待验收。[提交流程与限制](BROADCAST_PROTOCOL.md)

WalletConnect EVM 新增 eth_sendTransaction。接收常见缺省字段请求，用户主动读取 RPC 后逐项展示补全来源与值，核对请求链、账户、费用和执行结果后批准硬件签名。签名后单独批准提交，响应按协议返回本地计算且经端点接受或状态核实的交易哈希。结果不确定时携带标识返回错误并保留查询记录。新增 15 项本地测试，379 项全量测试和两种构建通过。真实 relay 扩展至 29 项，覆盖提交、状态恢复、不确定响应及签名后拒绝，节点与硬件均使用合成数据。浏览器检查了未连接状态说明与控件隐藏，真机和真实链上执行仍待验收。[流程与默认费用规则](BROADCAST_PROTOCOL.md)、[说明页验收图](screenshots/walletconnect-send-2026-11-09.png)

WalletConnect Solana 新增 solana_signAndSendTransaction，支持 legacy/v0/v1、ALT、完整已有协签和 sendOptions。读取后分别批准签名与提交，第一签名用作交易标识，覆盖 CanoKey 签署非 fee payer 槽位的情况。13 项新测试覆盖正常与取消/不确定路径，另增加 1 项 namespace 合并权限回归测试，按链限制提交能力。全量 393 项测试、两种构建和 35 项真实 relay 检查通过。节点与硬件使用合成数据，浏览器检查未连接状态的入口说明及控件隐藏。真实节点提交、真机与第三方 dApp 流程仍需验收。[实现与限制](BROADCAST_PROTOCOL.md)、[入口验收图](screenshots/walletconnect-solana-send-2026-11-09.png)

继续验证真实浏览器/硬件与 EVM/Solana 第三方 dApp 互操作，以及真机交易和测试网络验收。Token 账户扩展状态和后续扩展格式仍属待实现能力，发布构建与操作文档继续完善。当前产品仅开放已声明的方法。整体目标尚未完成。

EVM 交易范围按当前要求收敛为 type 0/1/2。手动页面提供交易、personal_sign 和 EIP-712 v4，交易解析与 WalletConnect 共用类型限制。新增拒绝回归覆盖已移除交易类型的 JSON、未签名/已签名 Hex 以及额外授权字段。当前 390 项本地测试、严格 TypeScript 检查、联网/离线构建和 33 项真实 relay 检查通过，relay 中的硬件及 RPC 使用合成数据。[当前界面](screenshots/evm-current-2026-11-09.png)

发布阶段新增运行手册和 npm run release 命令。命令执行本地测试，比较联网/离线各两次构建后生成版本、SHA-256、源码快照、完整锁定依赖和已安装包许可证副本。页面版本来自 package.json，发布目录保留当前环境与依赖元数据缺口。真机与跨系统发布验收继续按开发计划推进。[运行手册](../README.md)、[发布核验](RELEASE.md)

签名路径检查修复设备操作中批准过期的交付缺口，在设备发现、PIN、签名命令及认证退出边界检查批准和 RPC 上下文。Bitcoin 最后一个输入结束后同样检查。RPC 审查组合保留较早截止时间，过期对象要求重新读取。新增 14 项回归，全量 390 项本地测试和 33 项真实 relay 检查通过，硬件与 RPC 使用合成数据。[检查记录](SIGNING_REVIEW.md)

真机应用验收已准备 9 组固定离线输入，覆盖 EVM type 0/1/2、BTC P2WPKH、Solana legacy/v0 与 255/256/1331 字节完整消息。公钥来自先前的已验签公开证据，现场重读匹配及实际签名待完成。输入经过独立参考摘要或序列化核对，重复生成逐字节一致，并验证旧目录保护和无效证据拒绝。本次尝试时本机未枚举到 CanoKey，Mac 锁屏导致原生设备选择无法继续。另复现并修复选择等待期间取消未结束页面任务的问题，新增 5 项回归，390 项全量测试及两种构建通过。[验收材料](hardware/APPLICATION_ACCEPTANCE.md)、[取消流程检查](SIGNING_REVIEW.md)
