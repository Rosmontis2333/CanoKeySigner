# 手动交易提交与状态查询

2026-11-09。联网构建在手动 EVM 与 Solana 交易签名结果中提供独立的广播准备、批准、提交和状态查询。WalletConnect 提供 EVM eth_sendTransaction 与 Solana solana_signAndSendTransaction。Bitcoin 仅提供手动 PSBT 签名。

## 批准与提交

准备阶段只核对本地签名结果，展示原审查、网络、配置的 RPC 来源及本地计算的交易标识。EVM 核对完整未签名交易体、签名与发送账户。Solana 核对精确消息字节和其他签名槽，独立验证全部必需签名，保留 legacy、v0、v1 的完整编码。协签尚未完成时须继续收集签名。

用户单独勾选批准后，程序检查端点网络并查询已有记录。查询到交易即显示对应状态。尚未查询到时，重新读取账户、费用与执行上下文，检查通过后再次核对网络与两分钟批准有效期，提交准备好的签名交易。Solana 使用 preflightCommitment=confirmed、skipPreflight=false、maxRetries=0。

每个网络和交易标识在当前页面生命周期内最多尝试一次写入，覆盖并发任务、重复准备及切换 RPC 来源。记录上限为 1024 个标识。提交响应必须匹配本地计算的 EVM 交易哈希或 Solana 第一签名。

## 结果与记录

节点接受交易后显示 accepted，用户可主动查询后续状态。EVM 根据交易回执判断执行成功或失败，界面提示区块最终性仍需确认。Solana 展示 processed、confirmed 或 finalized 级别及执行结果。端点暂未查询到记录时显示 unknown。

写入响应丢失或标识不匹配时尝试查询一次。仍无法核实时保留 unknown 和交易标识。取消发生在写入之后时同样保留不确定结果，用户可稍后主动查询。

界面每个币种保留一条提交记录，修改输入、账户或切换页面模式会取消当前操作，已经尝试提交的记录仍供查询和下载。用户结束记录后可准备下一笔。状态记录包含网络、标识、来源及最近结果。记录与重复提交限制均保存在当前页面内存中，刷新页面会清除，用户可在刷新前下载记录。

## WalletConnect EVM 提交

eth_sendTransaction 使用单笔交易数组，核对 from、已授权 namespace 及请求 chainId。接受 gas/gasLimit 和 input/data 两组别名，每组只能出现一次。未知字段、账户不匹配和链不一致均阻止签名。required 提交能力要求相关链均有配置的 RPC 来源。optional 按链授予可提供的提交能力，混合链的提交权限使用 chain-qualified namespace，保留其他链可用的签名方法。合并 required 与 optional 时仍维持这个边界。

收到请求后固定原始参数，等待用户主动选择来源并读取 RPC。支持 dApp 省略 type、chainId、nonce、gas、value、data、accessList 和对应费用字段的正常调用。chainId 缺省时取本次 WalletConnect 请求的已授权链。nonce 取 pending 值，gasLimit 直接采用 pending gas 估计。缺省 value/data/accessList 分别补为 0、空字节和空列表。type 按费用字段、accessList 和参考区块的 baseFee 推断，明确指定的字段保留原值。

legacy/type 1 缺省 gasPrice 使用端点建议。动态费用缺省 priority fee 使用 eth_maxPriorityFeePerGas，缺省 maxFeePerGas 使用补全参考区块 baseFee × 2 + priority fee。这里的费用规则是应用默认值，所有补全项及来源、参考区块、完整费用上限都会在审查中展示。字段补全后仍执行原有语义审查与 RPC 检查，准备和检查的较早期限限制整个请求。[优先费 RPC](https://ethereum.github.io/execution-apis/api/methods/eth_maxPriorityFeePerGas/)

用户核对后批准硬件签名，验签通过时生成提交审查，再单独勾选批准提交。此时复用手动流程的网络核对、既有记录查询、重新执行检查和单次写入限制。节点接受响应匹配本地哈希，或查询到同一交易已有状态时，按方法协议返回交易哈希。[EVM JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)

结果不确定时向 dApp 回传错误及交易标识，保留本地记录。锁定版 SignClient 的 error.data 类型为字符串，因此其中携带 JSON 编码的 transactionHash 与 state。显式查询后只更新保留记录。提交完成、拒绝、断连或过期后，每个请求仍仅完成一次终结响应。

WalletConnect 同时保留一条内存提交记录，包含 dApp 声明名称、请求 ID、交易标识、来源和状态，可查询及下载。新提交请求需要先结束上次记录。切换账户、币种或手动/WalletConnect 模式会使当前请求失效并取消在途操作，保留的提交记录继续供查询。刷新页面清除内存记录，重复提交限制沿用同一页面内的共享标识集合。

## WalletConnect Solana 提交

solana_signAndSendTransaction 接受对象中的 Base64 完整 transaction、可选 pubkey 和 sendOptions。pubkey 提供时须等于当前授权账户。核对 required signer 与其他协签，缺失其他必需签名时在 RPC 和硬件操作前拒绝请求。完整已有签名在语义审查中独立验证，当前槽位签名后再次验证全部必需签名。支持 legacy、v0/ALT 和容量内 v1，消息与 blockhash 使用精确原始字节。

参数与返回结构按 Reown 官方参考及固定 AppKit commit fa90f4de7ebce805316f791b38cda0f06bda9b86 核对。成功返回对象中的 Base58 signature，值为 fee payer 的第一签名，即使 CanoKey 签署另一槽位也使用同一规则。[Reown RPC 参考](https://docs.reown.com/advanced/multichain/rpc-reference/solana-rpc)、[AppKit 适配器](https://github.com/reown-com/appkit/blob/fa90f4de7ebce805316f791b38cda0f06bda9b86/packages/adapters/solana/src/providers/SolanaWalletConnectProvider.ts)

用户先主动读取 RPC，核对 genesis、ALT、费用和原始交易模拟，再分别批准硬件签名和提交。sendOptions 逐项校验并固定，默认 skipPreflight=false、preflightCommitment=confirmed、maxRetries=0。明确提供的选项保留原值，包括 Reown 列出的旧 commitment 名称。maxRetries/minContextSlot 须为安全非负整数，未知字段与 null 拒绝。commitment 与最小 slot 约束 ALT、费用和模拟读取，发送前检查复用同一设置。

审查明确解释 skipPreflight=true 会跳过节点在提交时的预检。应用自身的消息审查、全部签名验证和发送前模拟始终执行。maxRetries 只控制节点重传同一份签名交易，应用仍最多发起一次写入。节点接受的返回值须匹配本地第一签名，后续状态继续使用该标识查询。[Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction)

取消、过期、网络变化与不确定响应复用已有提交控制。错误 data 中使用 JSON 编码的 signature 与 state，保留本地记录供查询。查询恢复只更新记录，每个请求至多发送一次终结响应。

## 验证范围

提交回归通过合成 RPC 和模拟 OpenPGP 设备验证精确提交字节、完整协签、网络与执行检查、既有记录、异常响应、取消、过期及重复提交。EVM 覆盖字段补全、费用、来源与能力限制、单独批准、过期/断连/迟到结果、状态恢复及单次回传。Solana 覆盖三种版本、非 fee payer 签名槽、完整协签、选项固定与 slot 约束、blockhash 失效、不确定响应及过期回包。现有全量 390 项测试和联网、离线构建通过。离线构建移除 RPC 传输与广播模块，CSP connect-src 为 none。

官方 SignClient 2.26.0 双端真实 relay 通过 33 项检查，包含 EVM 与 Solana 提交、响应丢失后状态恢复、不确定响应和签名后拒绝。Solana 提交场景覆盖 legacy/v0/v1、sendOptions、已有协签及精确第一签名回传。RPC 节点和 OpenPGP 使用专用合成数据。浏览器检查未连接状态的说明与控件隐藏，实际已签名请求的页面流程仍需真机验收。[relay 记录](walletconnect/relay-2026-11-09.json)、[Solana 入口验收图](screenshots/walletconnect-solana-send-2026-11-09.png)

真实节点广播、硬件签名后的端到端提交及实际链上执行仍待验收。当前测试均使用模拟提交。
