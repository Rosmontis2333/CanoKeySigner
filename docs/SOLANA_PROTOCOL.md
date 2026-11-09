# Solana 实现与验证

2026-11-09。当前生产适配器支持 legacy/v0/v1 的 transaction 和 message。legacy/v0 序列化交易按 1232 字节限制，v1 按 4096 字节限制。设备单次扩展 APDU 的完整原始消息限制为 1331 字节，v1 超出该上限时保留审查并阻止签名。[官方交易格式与版本](https://solana.com/docs/core/transactions/versioned-transactions)

输入编码必须明确选择 Base64、Base58 或 Hex。二进制文件也需要明确选择后导入，并保留 transaction/message 格式选择。消息读取限制 short_vec 的规范 u16 编码、账户和指令数量，检查 header、程序索引和全部账户索引，拒绝截断及尾随数据。所有审查字节转为不可变字符串保存，批准只可使用一次。

本地解析 System、SPL Token、Token-2022、Associated Token、Compute Budget 和 Memo 的已知分支。操作解释同时展示完整原始数据及所有相关账户。Token 的 checked decimals 标为指令声明，未提供的 decimals 保留为未知，金额均展示最小单位整数。未知程序或指令分支保持只读。Token-2022 的已实现分支与状态限制见下文。[SPL Token 指令定义](https://github.com/solana-program/token/blob/main/interface/src/instruction.rs)

## v1 交易格式

v1 使用独立解析器，识别 transaction/message 首字节 0x81。签名输入包含这个版本字节、header、配置 mask、lifetime、全部内联账户、资源值、指令 header 和 payload。交易签名放在消息尾部，每个 64 字节，数量取自 header。transaction 不含签名数量前缀，message 导入会在尾部补齐空签名槽。已有签名在精确原消息上验签，附签只替换所选 signer 的空槽。[SIMD-0385](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md)

配置 mask 只接受已知 0–4 位，其中 priority fee 的两位必须同时存在。指令 header 使用固定 u8/u8/u16 LE，全部 header 后再依次读取各指令的账户索引和数据。拒绝未知位、截断、尾随数据、重复账户、无效 header 和越界索引。最多 12 个签名、64 条指令，允许空指令列表。内联账户最多解析 96 个，超过 64 时明确提示执行依赖 SIMD-0596，当前这些长消息同时超过设备容量而保持只读。v1 按协议使用全部内联地址。[官方 Rust 消息实现](https://github.com/anza-xyz/solana-sdk/blob/master/message/src/versions/v1/message.rs)

| 配置 | 编码 | 缺省值与审查 |
| --- | --- | --- |
| Priority fee | mask 位 0 和 1，u64 LE | 0，总 lamports |
| CU limit | mask 位 2，u32 LE | 0，资源请求 |
| Loaded accounts data limit | mask 位 3，u32 LE | 0 字节，资源请求 |
| Heap size | mask 位 4，u32 LE | 32768 字节，显式值必须为 32768–262144 范围的 1024 倍数 |

审查区同时显示 mask、各字段的显式/缺省状态、完整消息长度和设备上限。CU 或加载数据请求为 0 时提示执行可能失败。v1 的 ComputeBudget 指令按 no-op 展示，保留原始字节及账户，即使指令内容为空、无效或重复也按协议解释。费用与资源来自消息头，Priority fee 展示为总额，准确 base fee、可执行性及网络资源约束仍需可信链上上下文。[资源配置定义](https://github.com/anza-xyz/solana-sdk/blob/master/message/src/versions/v1/config.rs)、[协议资源规则](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md)

新增固定版本 `@solana/transaction-messages@8.6.0` 与 `@solana/transactions@8.6.0` 开发参考依赖，通过其公开编解码 API 生成与解码 v1 消息及签名交易。25 项新格式测试覆盖全部 16 种有效 mask、优先费 u64、默认值、首尾签名槽、其他已有签名、12 签名/64 指令/96 地址边界、全部截断位置及错误字段。1331 字节消息通过生产 OpenPGP 模拟设备扩展 APDU，Node/OpenSSL 独立验签，1332 字节及完整 4096 字节交易保持只读。另有 WalletConnect 单笔及 legacy/v0/v1 混合批次测试，真实 relay 核对返回签名位置、消息字节与协签保留。浏览器已验证版本标记与容量说明，实际设备和第三方 dApp v1 验收待完成。[界面验收图](screenshots/solana-v1-2026-11-09.png)

## Token-2022 指令

Token-2022 固定使用程序 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`。基础 Token 解析移至独立模块，两种 Token 程序复用已有金额、权限和多签验证。扩展检查保持在 Token-2022 程序分支内。已实现以下操作。[官方指令定义](https://github.com/solana-program/token-2022/blob/main/interface/src/instruction.rs)

| 指令 | 审查内容 |
| --- | --- |
| Approve / ApproveChecked / Revoke | 源账户、Mint、delegate、数量、最大 u64 授权与撤销 |
| MintTo / MintToChecked / Burn / BurnChecked | 增发或销毁数量、源/目标与 Mint、authority、声明 decimals |
| CloseAccount / FreezeAccount / ThawAccount / SyncNative | 关闭并转移全部 SOL、冻结/解冻账户、同步 Wrapped SOL |
| SetAuthority | 官方类型 0–17 的角色、新 authority 或 None，Permanent Delegate 展示任意 Token 转移/销毁范围 |
| InitializeImmutableOwner | 账户 owner 的永久不可更改效果及初始化顺序 |
| Transfer Fee 子指令 0–5 | 初始化/修改费率、显式手续费转移、从 Mint/账户提取预扣费、归集至 Mint |
| Memo Transfer Enable / Disable | 对转入前置 Memo 的要求或取消 |
| CPI Guard Enable / Disable | 对 CPI 转移、销毁、关闭、授权及 authority 修改的限制或取消 |
| Associated Token Account | 按所选 Token 程序派生并验证 PDA，支持普通与幂等创建 |

TransferCheckedWithFee 展示总额、预期预扣手续费、预计新增可用余额、Mint、来源与目标。费用不得超过总额，链上执行会核对预期费用。自转移单独标示仅校验且不改变余额或预扣手续费。普通 Transfer / TransferChecked 的 Token-2022 请求仍完整展示，但因未声明预期手续费而拒签。后续接入可信 Mint 状态后再扩展该路径。额外账户仅接受 authority 后的 1–11 个不重复多签签名者，已有单签 authority 后附加账户会拒绝。Transfer Hook 额外账户及未知扩展指令未开放签名。[Transfer Fee 定义](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/transfer_fee/instruction.rs)、[程序执行规则](https://github.com/solana-program/token-2022/blob/main/program/src/processor.rs)

Transfer Fee 初始化支持四种可选 authority 组合，检查规范 option 编码及完整长度。费率限制为 0–10000 basis points，每笔上限使用 u64。展示 fee config authority 缺失后的不可修改效果，以及 withdraw authority 缺失后的提取限制。修改费用显示 epoch 计划语义。提取与归集列出所有源账户及接收账户，数量由执行时余额决定。Memo 和 CPI Guard 分别显示启用与禁用的实际影响。[Memo Transfer](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/memo_transfer/instruction.rs)、[CPI Guard](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/cpi_guard/instruction.rs)

当前未读取 Mint 或 Token 账户的 TLV 扩展、余额及 authority。审查区明确标出状态来源与可执行性限制，指令参数不代表经过链上核实的账户状态。含有未知指令的整笔交易拒签。可信 RPC、Hook 程序审查及其他扩展仍需继续实现。

官方 `@solana/spl-token@0.4.15` 生成 55 组固定指令向量，保存程序地址、完整数据和 AccountMeta。向量包含 18 种 authority、四种费率初始化组合、0/max u64/自转移、Token 多签及 ATA。63 项新 Token-2022 测试逐组比较 legacy/v0 原始消息和 Web3.js 签名交易，用 Node/OpenSSL 独立验签。覆盖截断/尾随、非法 option/费率/费用/开关、账户权限、未知扩展、程序替换、已有多签保留与 OpenPGP PIN/认证退出。另有 WalletConnect 单笔和批量流程测试，真实 relay 验证带 ALT/部分多签的手续费转移及 Memo 配置。真机与第三方 dApp 验收待完成。

参考 SDK 的 bigint-buffer 传递依赖有高危安全公告，因此仅在生成固定向量时临时使用，生成后移除。当前项目依赖审计为 0 条。生成器验证参考包版本为 0.4.15，固定向量记录 npm 完整性值。需要重建向量时，可在隔离目录安装参考包并传入其模块文件 URL。

```sh
npm install --prefix /tmp/canokey-token2022-reference --ignore-scripts --save-exact @solana/spl-token@0.4.15 @solana/web3.js@1.98.4
node test/fixtures/generate-token2022.mjs file:///tmp/canokey-token2022-reference/node_modules/@solana/spl-token/lib/esm/index.js
```

## ALT 离线快照

v0 消息中的每个 ALT 引用都必须解析。导入 JSON 数组，每个对象具备以下字段。

| 字段 | 内容 |
| --- | --- |
| address | ALT 账户 Base58 地址 |
| owner | `AddressLookupTab1e1111111111111111111111111` |
| dataBase64 | 原始账户数据，规范 Base64 |
| source | 导出工具、RPC 或其他来源说明 |
| contextSlot | 读取上下文 slot，十进制整数字符串 |
| network | 与本次所选 `devnet`、`testnet` 或 `mainnet-beta` 相同 |

解析初始化标记、deactivation slot、last extended slot、扩展起始索引、authority 标志及 56 字节 metadata 后的 32 字节地址数组。当前拒绝已停用表。读取上下文与扩展同 slot 时，仅扩展起始索引之前的地址视为可用。检查索引重复、越界、地址重复和加载顺序，全部可写加载地址在全部只读加载地址之前。

这些检查验证的是快照内部一致性。页面将来源显示为离线快照、未经链上验证。快照不提供链上真实性证明，不能用于宣称 owner 或当前状态已经通过 RPC 核实。手动和 WalletConnect 入口已经接入用户选择的 RPC，按相同结构校验返回的原始账户数据，并标记为 RPC 来源及其 slot。[RPC 操作与限制](RPC_PROTOCOL.md)

## 验证与限制

官方 Web3.js 1.98.4 仅作为开发测试参考库，生成 legacy/v0、带 ALT 和部分多签测试数据。适配器从相同输入解析出精确消息，附签后的完整 transaction 与官方实现逐字节比较。Node/OpenSSL 独立验证消息签名，已有非空签名也在本地验证。PDA 地址派生与官方 PublicKey API 对照。

OpenPGP 模拟设备测试确认签名 APDU 携带完整原始消息，签后仅替换当前 signer 的空槽，其他签名和消息字节保持一致。任何 blockhash、nonce、账户、指令、cluster 或快照变更都会要求重新审查。

手动和 WalletConnect 入口已支持可选 RPC 核对网络、读取 ALT、消息费用及模拟原始交易。nonce authority、Token 账户扩展和租金的独立状态核验仍待完成。RPC 结果的信任范围与有效期见 [RPC 操作与限制](RPC_PROTOCOL.md)。所选 cluster 明确展示为外部上下文，不能把 Solana 签名解释为已绑定该 cluster。真实设备交易签名与测试网络验收仍待完成。

## WalletConnect 签名并提交

solana_signAndSendTransaction 已接入 Base64 完整 transaction 与 sendOptions。主动读取 RPC 后分别批准硬件签名与提交，支持 legacy/v0/v1，保留原始消息、blockhash 和已有协签。其他必需签名缺失时在操作设备前拒绝。返回 signature 为交易第一签名，覆盖 CanoKey 签署非 fee payer 槽位的情况。发送前重新检查相同交易，取消或响应不确定时保留标识供查询。发送选项、默认值和信任范围见提交文档。真实节点提交与真机流程仍待验收。[提交协议](BROADCAST_PROTOCOL.md)

## WalletConnect 批量交易签名

solana_signAllTransactions 接受 `{transactions}`，其中为按原顺序排列的 Base64 serialized transaction 数组，完成后返回 `{transactions}` 签名交易数组。应用单批上限设为 8 笔，接受 1 笔，拒绝空数组、超量请求、额外字段及非字符串元素。可以混合 legacy/v0/v1。每笔分别按版本检查协议交易容量和设备消息容量，并使用当前授权公钥、cluster 与同一份 ALT 快照预先解析。首笔签名前，整批交易必须全部满足相同签名策略。已有签名先验证，再按原样保留。[官方 WalletConnect Solana 适配器](https://github.com/WalletConnect/walletconnect-solana-adapter/blob/main/packages/walletconnect-solana/src/core.ts)

界面逐笔显示完整审查与批次进度，每笔单独确认、输入 PIN 并遵守槽位触摸策略。每次完成后清空确认框和 PIN，展示下一笔，等待新的用户操作。只有最后一笔通过本地验签和设备认证退出后，才按原顺序返回整批结果。拒绝、超时、账户变化、断连或中途失败会废弃本地保存的部分结果，并拒绝整个请求。整批共用初始截止时间，最长五分钟，推进下一笔不会延期。已经发生的设备签名操作无法撤回，部分交易结果不会返回 dApp。

新增 13 项本地测试覆盖整批预检查、legacy/v0/ALT 混合、部分多签保留、原始请求变更、1/8 笔边界、非法后续交易、逐笔确认与 PIN 清除、重复请求和并发确认、固定截止时间、账户变化、拒绝/设备失败/过期、取消后的迟到结果，以及签后认证退出失败。官方 SDK 真实 relay 验证有序完整结果与签完首笔后整批拒绝的 4001 响应。浏览器已检查批量能力和上限说明，真实硬件与第三方 dApp 的批量交互仍待验收。[relay 记录](walletconnect/relay-2026-11-09.json)、[界面验收图](screenshots/solana-batch-2026-11-09.png)

## 受限离链消息签名

手动签名新增可阅读正文和已有编码消息两种模式。正文模式生成 Solana offchain v1，required signer 为当前槽位公钥，完整签名输入包含标准域分离头、版本、signer 列表及 UTF-8 正文。已有消息导入接受明确选择的 Base64、Base58、Hex 和二进制文件，支持 offchain v0/v1，并按输入的原始字节签名。WalletConnect solana_signMessage 接受 `{message, pubkey}`，message 使用 Base58，pubkey 必须为当前授权账户。返回 `{signature}`，signature 为 Base58 编码的 64 字节 Ed25519 签名。[消息格式](https://docs.anza.xyz/proposals/off-chain-message-signing)、[官方 WalletConnect Solana 适配器](https://github.com/WalletConnect/walletconnect-solana-adapter/blob/main/packages/walletconnect-solana/src/core.ts)

策略要求标准的域分离前缀和非空可阅读正文，原始文本、交易 message/transaction 字节、未知版本、非 UTF-8、隐藏字符及非可阅读控制符会拒签。换行、回车和制表符在正文审查中转义展示。v1 signer 列表必须按原始公钥字节递增且不重复，当前公钥必须列在其中。v0 保留原有顺序，拒绝重复 signer，核对 application domain、消息格式和声明长度。格式 0 只接受可打印 ASCII，格式 0/1 完整消息最多 1232 字节。格式 2 与 v1 受设备完整消息 1331 字节上限约束，单 signer 的手动 v1 正文最多 1281 字节。

消息使用独立的不可变审查对象和单次批准，五分钟后过期，并复用 OpenPGP 的算法、公钥、触摸策略核对与认证退出。审查完整列出 required signers、v0 声明的 application domain、JSON 转义正文、长度和精确 Hex 字节，同时说明 cluster 属于外部上下文，签名可跨网络复用。一次任务仅生成当前 signer 的签名，接收方仍须验证全部 required signer 的签名。手动结果下载 JSON，包含 method、publicKey、messageBase64 和 signatureBase58，供接收方核对原始消息和验签。

独立固定布局测试与 Node/OpenSSL 验证 v0/v1 的完整消息和签名。覆盖错误前缀/版本、交易字节拒绝、UTF-8/隐藏字符、signer 顺序/重复/成员、长度/截断/尾随、批准过期/撤销/单次消费和取消。1331 字节边界通过生产 OpenPGP 模拟设备的扩展 APDU，并与 Node/OpenSSL 的原始消息签名逐字节比较。WalletConnect 模拟生命周期与官方 SDK 的真实 relay 均验证 v0/v1 的标准参数、逐笔批准及 Base58 响应。实际设备和第三方 dApp 验收仍待完成。
