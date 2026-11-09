# CanoKeySigner 开发计划

制定日期：2026-11-08。2026-11-09 已开始 P0 开发，软件小样和只读设备检查已实现，真机验收待完成。进展见 [P0 状态](P0_STATUS.md)。

2026-11-09 用户范围更新。Bitcoin 仅提供手动签名。WalletConnect 范围为 EVM 与 Solana。EVM chainId 从交易或 EIP-712 Domain 读取，Project ID 内置为用户指定值。PIV 暂留。EVM 交易类型范围为 0、1、2。

## 1. 目标与基线

使用 WebUSB 直接调用 CanoKey **3.0.3** 的 OpenPGP 和 PIV applet，以 secp256k1 ECDSA 签署 BTC/EVM，以 Ed25519 签署 Solana。支持交易导入、解析、审查、硬件签名、签名验证和导出，以及可选 WalletConnect 钱包端连接。

优先级：签名正确和审查可靠 > 简单、可审计 > 格式覆盖 > 便利功能。采用静态前端、固定密钥槽位、显式能力矩阵；每新增一种格式必须同时交付解析、审查、签名和拒绝路径测试。

当前项目仅有 package.json、package-lock.json 和已安装依赖，没有业务代码。保留现有 TypeScript/Vite 方向，先验证库的硬件签名接入能力，再确定最终依赖。

## 2. 3.0.3 源码核对结果与约束

核对版本：canokey-core tag 3.0.3，commit `7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f`；其 canokey-crypto 子模块为 `c65b9015d44115182ac5106f58a228efb569c93f`。以下是源码结论，商业硬件的最终行为仍需真机确认。

| 项目 | 基线与设计后果 |
| --- | --- |
| OpenPGP | 使用 SIG/AUT 已有槽位；ECDSA 输入摘要，Ed25519 输入原始消息。读取已有公钥与算法属性，不修改属性。 |
| PIV | 使用现有 9A、9C、9D、9E、82、83 槽位中实际具备签名能力的密钥；读取 F7 metadata 获取公钥、算法 ID 和策略。界面优先推荐满足 PIN/触摸策略的签名槽位。 |
| 签名编码 | OpenPGP ECDSA 返回固定长度 r‖s；PIV ECDSA 返回 TLV 包装的 DER；Ed25519 为 64 字节签名。适配器统一输出并严格验证。 |
| PIV 算法映射 | 默认 secp256k1=0x53、Ed25519=0xE0；3.0.3 的扩展记录为 7 字节，且读取也要求管理认证，不能套用最新文档的公开读取/10 字节结构。 |
| 版本识别 | PIV FD 返回兼容值 5.7.0，不能当作 CanoKey 固件版本。使用 Admin applet 的只读版本/硬件查询，并与真机核对。 |
| APDU 容量 | APDU_BUFFER_SIZE=1340，WebUSB 单次传输和 APDU 链式聚合均有限制；PIV 还要扣除 TLV 开销。分包不能无限扩容。 |
| 长消息传输 | 以 3.0.3 的通用 APDU 解析和 chaining 行为为准，真机验证 short/extended APDU、command chaining 与 GET RESPONSE，不照搬最新版 PIV 文档的传输限制。 |

算法映射采用 3.0.3 默认配置作为明确前提，结合 metadata、公钥编码和签后验签核验；自定义算法 ID 的设备要求用户提供经过外部管理工具核实的映射。不自动猜测多个 ID，不为日常签名索取 management key。

硬件边界：

- 固定槽位不是 HD 钱包。不能根据 PSBT 的 BIP32 路径在卡上自动派生新私钥；以实际公钥匹配签名权限。BTC 与 EVM 可以使用同一 secp256k1 公钥，但允许配置独立槽位；Ed25519 使用另一槽位。
- 当前基线未提供 BTC Taproot 所需的 BIP340 Schnorr 签名路径。可解析 Taproot 相关数据，但不宣称支持签署 Taproot 输入；普通 ECDSA 输入的交易可以包含 Taproot 输出。
- Solana 必须签协议规定的原始消息，不能用外部 SHA-256/SHA-512 预哈希替代。legacy/v0 的通常大小范围在容量内；v1 解析后逐笔检查消息长度，超出硬件容量即拒签。
- CanoKey 没有用于核对链上交易的可信显示屏，触摸只能确认人在场。安全边界包含浏览器、页面来源和所运行的代码，不能承诺抵御已被控制的主机。

依据：[3.0.3 发布说明](https://github.com/canokeys/canokey-core/releases/tag/3.0.3)、[PIV 源码](https://github.com/canokeys/canokey-core/blob/3.0.3/applets/piv/piv.c)、[OpenPGP 源码](https://github.com/canokeys/canokey-core/blob/3.0.3/applets/openpgp/openpgp.c)、[APDU 实现](https://github.com/canokeys/canokey-core/blob/3.0.3/src/apdu.c)、[容量常量](https://github.com/canokeys/canokey-core/blob/3.0.3/include/common.h)、[密码接口](https://github.com/canokeys/canokey-crypto/blob/c65b9015d44115182ac5106f58a228efb569c93f/include/ecc.h)。

## 3. 最小架构

```text
文件/粘贴导入 ───────┐
WalletConnect 请求 ─┴→ 严格解码 → 链适配器 → 不可变待签名对象
                                              ↓
                                       交易审查与用户确认
                                              ↓
                                     策略校验/签名任务队列
                                              ↓
                           OpenPGP 或 PIV → APDU → WebUSB
                                              ↓
                             本地验签 → 重组/复核 → 导出

可选网络模块：RPC 补充上下文、模拟、显式广播；WalletConnect relay
```

目录按职责划分为 `src/device`、`src/chains/{bitcoin,evm,solana}`、`src/signing`、`src/ui`、`src/connectors/walletconnect`、`src/network`；避免泛化插件系统。

设备层只接收已批准的密钥引用和精确签名输入。ECDSA-digest 与 Ed25519-message 使用不同类型，不暴露给外部任意 APDU 或任意摘要签名接口。链适配器完成 parse、validate、review、prepare、attach、verify；不接触 PIN。

审查后冻结规范化字节及公钥、网络、账户、待签输入、RPC 上下文。任何字段补全或修改均重新审查。签名前核对冻结对象，签后验证公钥与签名，并确认输出只增加批准的签名。设备断开、换槽位、切链、请求过期或页面刷新均使批准失效。

## 4. 功能与格式矩阵

### 4.1 Bitcoin

首轮完成 PSBT v0 的 Base64、Hex、二进制文件导入/导出，支持 P2WPKH、P2SH-P2WPKH；默认只允许 SIGHASH_ALL。随后完成 PSBT v2、P2PKH，以及标准 P2WSH/P2SH 多签模板；只签本机公钥参与的输入，保留其他签名和未知 PSBT 字段，不静默转换 PSBT 版本。

审查内容：网络选择、输入 outpoint、UTXO 金额、输入脚本和所有权、所有输出地址/脚本和金额、已验证的本机输出、总输入/输出、矿工费、费率估计、locktime、sequence/RBF、每个输入的 sighash。PSBT 本身不可靠标识网络，必须显式绑定；无法证明归属的输出不得隐藏为“找零”。

验证完整 previous transaction 的 txid 与 vout、witness/non-witness UTXO 一致性、redeemScript/witnessScript 哈希、公钥匹配与重复字段。保守策略优先要求可验证的完整前序交易；仅有 witness UTXO 的金额和费用信息须明确其来源与验证限制，未达到策略要求时阻止签名。离线不能证明 UTXO 当前未花费。

PSBT 部分签名为默认交付；全部签名齐备且校验通过才允许 finalize/extract。特殊 sighash、任意脚本与混合复杂输入先拒签，后续通过单独审查规则扩展；Taproot 输入签名不在 3.0.3 支持范围。

标准：[BIP174](https://bips.dev/174/)、[BIP370](https://bips.dev/370/)、[BIP340](https://bips.dev/340/)。

### 4.2 EVM

首轮支持交易 JSON、未签名序列化 payload、已签名交易只读检查；交易类型为带 EIP-155 保护的 legacy、type 1/EIP-2930、type 2/EIP-1559。类型由明确 schema 与字节共同验证，避免数字精度损失和字段歧义。

未知类型及 L2 专属格式逐项注册，不将“EVM”解释为支持所有链的自定义交易。

审查内容：chainId、签名账户、to/创建合约、value、nonce、gasLimit、gasPrice 或 maxFee/maxPriorityFee、费用上限、access list、calldata及授权列表。区分最大费用与预估费用；nonce/gas 等在确认前补齐。

本地解码原生币转账、ERC-20 transfer/approve/transferFrom、ERC-721/1155 常用转移与授权；展示 spender、额度和无限授权。函数 selector/ABI 解码只能解释参数，不能证明任意合约行为。未知合约、代理实现和 multicall 逐步扩展，始终展示地址与原始数据。

签名后进行 low-S 规范化，使用已读公钥计算/验证 recovery parity，再生成正确 v/yParity。恢复出的地址必须等于批准账户。拒绝无 chainId 的传统重放不受保护交易。

WalletConnect 所需 personal_sign、EIP-712 v4 作为独立消息审查功能交付；完整展示 domain、类型和字段，并核验与请求链的关系。禁止通用 eth_sign 摘要盲签。EIP-4337 UserOperation、批量 wallet calls 不等同普通交易，列为后续独立协议。

标准：[交易类型概览](https://ethereum.org/developers/docs/transactions)。

### 4.3 Solana

首轮支持 legacy 和 v0 serialized transaction/message，接受明确标记的 Base64/Base58/Hex/二进制输入；不猜测歧义编码。支持未签名、部分签名、多签交易和逐笔确认的批量请求。

后续加入 v1 的独立解析器、资源配置审查和签名验证。当前官方文档已列出 v1，因此不能把 legacy/v0 称为全部格式；3.0.3 对 v1 只支持实际消息能装入签名 APDU 的子集。其余交易可解析但拒签，界面同时显示消息长度和固件限制。

审查内容：交易版本、fee payer、所有 signer、可写/只读账户、blockhash 或 durable nonce、program IDs、每条 instruction、SOL/Token 转移、授权/撤销/关闭账户、ComputeBudget 或 v1 资源配置。Token 元数据和 decimals 标明来源，始终保留最小单位整数值。

v0 在审查前解析全部 ALT 引用：验证账户 owner、表结构、索引和地址顺序，通过用户选定可信 RPC 获取，或导入有明确来源的离线快照。无法解析则拒签；离线快照不能伪装为经链上验证的数据。Solana 消息没有 EVM 式 chainId，网络来自会话和 RPC 上下文，不能宣称签名天然绑定所选 cluster。

本地优先解码 System、SPL Token、Associated Token、Compute Budget、Memo，逐步支持 Token-2022 的已知指令与扩展。未知指令仍展示完整结构，默认不允许语义不明的签名。模拟是补充证据，不能证明最终执行结果。

签署协议定义的精确消息字节，仅替换所选 signer 的签名槽，保留并检查其他已有非空签名。消息 blockhash/nonce 变化必须重新审查。signMessage 单独实现可阅读内容和域分离策略，拒绝用该接口绕过交易审查。

标准：[Solana 版本化交易](https://solana.com/docs/core/transactions/versioned-transactions)。

### 4.4 WalletConnect

实现钱包端：接收 dApp 产生的 wc URI，批准账户/链/方法，处理请求并回传结果。首版粘贴 URI，扫码后续按必要性增加。

按 EVM → Solana 顺序接入。Bitcoin 使用手动签名流程。使用官方 SDK，不自行重写 relay、会话加密或协议。当前已配置的 @walletconnect/sign-client 先验证钱包端生命周期覆盖及维护状态，再决定是否需要钱包专用封装；不叠加多套连接 SDK。

核心方法目标：EVM 的 eth_signTransaction、eth_sendTransaction、personal_sign、eth_signTypedData_v4；Solana 的 signTransaction、signAllTransactions、signAndSendTransaction 和受限 signMessage。具体 namespace、方法名、参数和返回值以锁定版官方 schema 和互操作测试为准，验证已声明的方法集与 namespace 授权边界。

会话只公布真正实现且当前账户支持的能力。无法满足 required namespaces 时拒绝提案，不假批准；optional capabilities 按需授予。校验 topic、request ID、过期时间、账户、chainId、方法、批量上限；请求去重、串行审查，断连立即取消。dApp 名称和图标按不可信数据处理，默认不加载外部图标。

签名与广播明确区分：sign 方法返回签名结果；send 方法在审查中说明将广播，并在广播成功后按协议返回结果，不能以 raw transaction 冒充 tx hash。广播结果不确定时查询交易状态，避免重复签名或修改 nonce 重试。

网络连接使用用户配置的 project ID 和 RPC；relay 是必要外部依赖。SDK 动态加载仅减少默认加载，不构成安全隔离。提供不包含 WalletConnect/RPC 代码、使用 connect-src 'none' 的离线构建；联网构建仍通过统一审查策略，不提供绕过入口。

依据：[WalletConnect 钱包端 Sign API](https://github.com/WalletConnect/walletconnect-docs/blob/main/docs/api/sign/wallet-usage.md)、[Namespaces 规范](https://github.com/WalletConnect/walletconnect-specs/blob/main/docs/specs/clients/sign/namespaces.md)。

## 5. 依赖与部署决策

| 职责 | 计划 |
| --- | --- |
| UI/构建 | TypeScript strict + Vite + 原生 DOM/CSS；不引入 UI 框架、路由器或全局状态库。 |
| 编码/密码 | 复用 @scure/base、@noble/hashes、@noble/curves，仅使用所需模块；不自行实现椭圆曲线和哈希。 |
| Bitcoin | 评估现有 @scure/btc-signer 的 PSBT、sighash、外部签名注入接口；其现有签名 API 不是即插即用异步硬件签名接口。先做兼容性小样，禁止调用私有方法或伪装 HD 私钥对象绕过类型。 |
| EVM | 优先复用 micro-eth-signer 的编码/交易支持，验证其摘要提取和外部签名附加方式；避免另引 ethers/viem 全家桶。 |
| Solana | 比较有边界检查的小型 codec 与按模块引入官方 codec 的审计成本；若自写，仅写格式和指令解析，并以官方实现做差分测试。不要因“零依赖”自写密码算法。 |
| WalletConnect | 唯一必要的大型可选协议依赖；记录其传递依赖和网络访问。 |
| RPC | 小型 fetch 适配器；只有用户主动开启的功能联网，不使用默认第三方解析/报价/分析服务。 |

现有版本不是经过审计的结论。固定直接依赖和 lockfile、审查传递依赖与安装脚本、记录许可证/来源/包体积、生成依赖清单；升级单独评审。测试用参考库仅进入开发依赖。

发布为本地可运行的静态构建，也可自托管 HTTPS。WebUSB 首先支持桌面 Chromium，确认 macOS/Windows/Linux 权限与占用行为；HTTPS/localhost 安全上下文和用户主动连接是前提。发布提供构建版本、校验和及可复现构建说明。

## 6. 安全规则与界面

界面保持四块：设备与账户、导入/连接、交易审查、签名结果。统一流程为连接 → 选择已有槽位 → 导入 → 审查 → PIN/触摸 → 验签 → 导出或已声明的广播。

- 不提供生成/覆盖/删除密钥、修改算法属性、重置设备和导入私钥功能；这些留给现有管理工具。签名客户端只读发现加必要的 VERIFY/签名 APDU。
- PIN 不持久化、不进入日志/URL/WalletConnect/RPC；错误 PIN 不自动重试。操作后尽快清除引用和缓冲，说明 JavaScript 无法保证物理内存擦除；核实卡端认证状态退出行为。
- 单设备、单活动签名任务，覆盖跨标签页互斥、CCID/GnuPG 占用、断连、超时、取消和过期回包。签名发出后不自动重试，取消后的晚到结果不得关联新请求。
- 全部金额用 bigint/整数字符串；严格检查编码、长度、数量、重复字段、越界索引、负数、截断、非规范整数和尾随数据，给文件/请求设置资源上限。
- 不渲染输入 HTML；配置严格 CSP、禁止 iframe 嵌入、eval 与远程脚本；离线构建零网络，联网构建限制到实际配置的 relay/RPC。初版不加入 Service Worker 自动更新或分析 SDK。
- 审查分为“已验证的字节事实”“解码解释”“外部数据/模拟”三层。未知内容默认拒签；专家原始签名若以后加入，必须作为独立策略并明确不承诺语义完整性，不进入首版默认路径。
- 钱包连接授权不等于交易授权；批量请求逐笔显示或先完整展示清单，不允许一个触摸静默批准未来请求。

## 7. 分阶段交付与验收

| 阶段 | 工作与交付 | 完成条件 |
| --- | --- | --- |
| P0：3.0.3 可行性 | 协议笔记、设备能力矩阵、库外部签名小样；验证两 applet 的两种算法、公钥读取、PIN/触摸、传输边界。 | 真机签名能被独立实现验证；确认消息上限、固件版本识别和自定义算法配置路径。未通过的能力标记阻塞。 |
| P1：签名基础 | WebUSB/APDU、OpenPGP/PIV、串行队列、统一审查对象、极简 UI。 | 断开、错误 PIN、超时、取消、切设备均不误签；无管理写操作。 |
| P2：BTC 端到端 | PSBT v0 + P2WPKH/P2SH-P2WPKH，详情、部分签名、导出。 | 独立工具验证 PSBT/交易；伪造 UTXO、输出归属、异常 sighash 被拦截。 |
| P3：EVM 端到端 | type 0/1/2，常用调用解析，签名恢复和导出。 | 各类型固定向量和独立解析验证通过；字段变化使确认失效。 |
| P4：Solana 端到端 | legacy/v0、ALT、常用指令、部分签名保留。 | 独立 Ed25519 验证和测试网络交易通过；未知 ALT/错误索引/超长消息拒签。 |
| P5：WalletConnect | EVM/Solana namespaces、URI 配对、会话管理、方法适配、可选 RPC/广播。 | EVM 与 Solana 各有 dApp 互操作样例，错误/拒绝/重复/过期请求正确回传；离线构建无 SDK/网络。 |
| P6：格式覆盖 | PSBT v2、P2PKH/标准多签；EVM type 0/1/2、EIP-712；Solana v1 容量内子集、Token-2022 已支持指令。 | 每项均具备解析、审查、签名或明确拒签、独立测试向量和能力声明。 |
| P7：发布验证 | 差分/模糊测试、真机矩阵、构建与依赖检查、操作文档和限制清单。 | 所有发布能力通过测试；高风险路径完成代码审查；未经真机测试的组合不标记可用。 |

P0 是后续时间估算的前置门槛。P2–P4 完成形成离线三链 MVP；P5 完成后形成联网可用版本；P6/P7 才形成计划内的扩展格式发布版本。按阶段提交可独立审查的变更，避免一次提交整套应用。

测试重点：已知向量及独立实现交叉验证；BTC 前序交易/多签/PSBT 未知字段保留；EVM high-S、recovery parity、chainId 与交易/消息签名；Solana 精确消息字节、ALT 顺序、部分签名和版本差异；APDU 在 255/256、总缓冲边界及 PIV TLV 开销处的长度测试；格式截断、超大输入、恶意文本、请求竞态和广播超时。

测试仅使用专用测试槽位/测试设备、测试网络和无真实资产的数据。不通过自动化改写用户已有密钥。当前从 P0 开始，按 [协议与真机验收记录](P0_PROTOCOL.md) 逐项记录结果。
