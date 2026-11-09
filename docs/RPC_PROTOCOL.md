# RPC 上下文读取与模拟

2026-11-09。手动签名支持 Solana 可选 RPC 读取与模拟，以及 EVM 可选 RPC 读取与执行检查。用户核对端点来源后主动点击读取。页面会向所选端点提供相关账户地址及交易内容。Solana 默认列出当前 cluster 的官方公共端点，EVM 默认配置 PublicNode 的 Ethereum Mainnet 与 Sepolia，可以在构建时配置其他来源。[Solana 公共端点](https://solana.com/docs/references/clusters)、[PublicNode Ethereum](https://ethereum.publicnode.com/)、[PublicNode Sepolia](https://ethereum.publicnode.com/?sepolia)

## EVM 读取与执行检查

EVM 从交易中读取 chainId，并只列出匹配的 RPC 来源。先核对配置 chainId 与端点 eth_chainId，再读取 latest 区块的编号、hash、时间戳、gasLimit 与 baseFee。在该区块号读取账户 nonce、余额和目标代码，另读取 pending nonce。结束时再次读取参考区块并比较 hash，同时复核端点 chainId。不同区块的 pending 状态单独标示。[Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)

执行检查使用原交易的 from、to、type、chainId、nonce、value、calldata、gas、费用和 access list 字段。eth_call 与 eth_estimateGas 绑定参考区块号，结果分别展示返回字节与 gas 估计。读取过程不会补全或改写交易字段。

余额不足以覆盖 value 与最大网络费、交易 nonce 不等于 pending nonce、gasLimit 超过参考区块限制、费用上限低于参考区块 baseFee、gas 估计超出指定上限、执行检查失败时，本次 RPC 审查保持只读。RPC 网络或响应格式错误则中止读取。pending nonce 早于参考区块 nonce、区块 hash 或 chainId 变化也会中止。返回的数量使用严格 uint256 Hex quantity 与 bigint，返回字节有独立长度限制。

eth_call 的成功只反映所选端点的参考区块执行，不能代替未来执行或外层签名验证。

EVM RPC 上下文同样绑定不可变交易字节及两分钟截止时间，签名前与附签后检查有效期。未知合约调用、已签名交易及既有审查策略拒绝的内容不会因 RPC 成功而获得签名权限。12 项测试覆盖配置/CSP、quantity、type 0/1/2 完整字段和 OpenPGP 签名、网络不匹配、nonce/余额/费用/gas/调用失败、区块替换、类型异常、token calldata 和过期。

`npm run test:rpc:evm -- /tmp/canokey-evm-rpc.json` 对专用合成公钥和未签名零金额 Sepolia 交易执行只读检查。最新实测成功核对 chainId 11155111、参考区块与 nonce，余额为 0，eth_call 和 gas 估计返回 -32000，本次 signable=false。浏览器检查从交易 chainId 自动匹配 Sepolia 来源，并在未配置链上显示不可用。成功执行与真机流程继续验收。[实测记录](rpc/sepolia-2026-11-09.json)、[界面验收图](screenshots/evm-rpc-2026-11-09.png)

## 读取与审查流程

先解码完整 transaction/message，并冻结本次输入、公钥、网络与端点。通过 getGenesisHash 核对所选 cluster 的已知 genesis。验证通过后，含 ALT 的 v0 消息使用 getMultipleAccounts 取得原始账户数据，再复用已有的 owner、账户结构、激活边界、索引、顺序与地址检查。手动和签名请求默认使用 confirmed。WalletConnect Solana 提交请求按已审查的 preflightCommitment 和 minContextSlot 读取，并逐步提高最低上下文 slot。[getGenesisHash](https://solana.com/docs/rpc/http/getgenesishash)、[genesis 基线](https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs)、[getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts)

getFeeForMessage 使用精确的原始消息，simulateTransaction 使用当前序列化交易，保持原始 blockhash。模拟设置 sigVerify=false 和 replaceRecentBlockhash=false，因此可审查未签名或部分签名交易。费用读取的 minContextSlot 不早于 ALT 读取，模拟的 minContextSlot 不早于费用读取。返回的 slot 同样检查单调约束。没有 fee 或模拟返回错误时，仍展示完整结果，但这次 RPC 审查不能批准设备签名。[getFeeForMessage](https://solana.com/docs/rpc/http/getfeeformessage)、[simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction)

审查展示来源名称与 origin、genesis、commitment、各次读取的 slots、消息网络费、模拟结果与 CU 消耗、完整的有界模拟日志，以及上下文截止时间。RPC 返回的账户数据仍依赖所选端点的可信性，当前没有独立链上证明。日志使用文本和转义形式显示。Token Mint 扩展、nonce authority 和完整账户执行效果仍需继续扩展状态核验。

RPC 结果生成新的不可变审查对象，绑定交易字节、公钥与网络，最长有效两分钟。新来源或内容变化会取消在途读取、清除确认和 PIN，并废弃旧结果。可以使用“取消 RPC 读取”主动停止。签名批准及附签阶段都检查上下文有效期，触摸等待期间过期的签名结果也不会交付。成功模拟仍不能使未知指令或超出设备容量的交易获得签名权限。

设备读取完成、PIN 验证完成与认证退出完成后也检查有效期，过期时停止后续设备命令或作废结果。组合 RPC 审查时保留已有上下文的较早截止时间，过期对象须重新读取并审查。[本次签名路径检查](SIGNING_REVIEW.md)

## 传输与构建配置

RPC 客户端仅开放已声明的读取和模拟方法，使用 POST、credentials=omit、redirect=error、cache=no-store 及 no-referrer。每次调用最长 15 秒，不自动重试。响应按流限制为 1 MiB，检查 UTF-8、重复 JSON 字段、JSON-RPC 版本、响应 ID、result/error 互斥和字段类型。日志最多 128 条、每条 4096 字符，错误对象最多 8192 字符。费用、slot 与 CU 数据目前要求为非负安全整数，超出 JavaScript 精度范围时拒绝读取结果。

可以在 `.env.local` 或构建环境中设置以下变量，替换默认端点列表。最多 16 个端点，network 取 devnet、testnet 或 mainnet-beta。

```dotenv
CANOKEY_SOLANA_RPC_ENDPOINTS='[{"name":"My Devnet RPC","network":"devnet","url":"https://rpc.example.org/solana"}]'
```

EVM 使用单独变量，最多 32 个端点，chainId 使用正整数十进制字符串。该配置匹配交易内容中的 chainId。

```dotenv
CANOKEY_EVM_RPC_ENDPOINTS='[{"name":"My EVM RPC","chainId":"31337","url":"http://127.0.0.1:8545"}]'
```

URL 允许 HTTPS，或 localhost/127.0.0.1/::1 的本机 HTTP，拒绝 URL 登录凭据和 fragment。配置为 `[]` 时禁用 RPC 来源。配置 URL 会进入静态客户端构建，需要保密的服务端凭据应留在服务端。端点需接受当前页面来源的 CORS POST 请求。

联网构建的 connect-src 在原 WalletConnect 来源之外，仅增加已配置 RPC 的 origins。自定义列表替换公共端点，没有 HTTPS 通配来源。离线构建不包含 RPC 客户端、RPC 端点或 relay 代码，RPC 控件隐藏，connect-src 保持 none。RPC 模块在用户点击读取后动态加载。

## WalletConnect 请求中的 RPC

EVM eth_signTransaction 与 Solana solana_signTransaction / solana_signAllTransactions 请求可主动读取 RPC。eth_sendTransaction 与 solana_signAndSendTransaction 须先主动读取并完成审查及执行检查，EVM 同时展示缺省字段的补全。来源使用与手动入口相同的构建配置，按已授权请求的 EVM chainId 或 Solana cluster 匹配。界面说明本次会向端点提供交易与账户数据，点击“为本次请求读取 RPC 并检查”才发起请求。连接批准与消息签名请求不会自动触发 RPC。

请求参数在接收时保存为有界 JSON 字符串，读取和签名始终使用该次固定输入。EVM 参数继续复用同一套 from、gas/gasLimit、chainId 与交易字段校验。Solana 批次在等待上下文前先校验所有交易的 envelope、版本与长度。缺少 ALT 的请求进入等待状态，展示原始参数和上下文需求，取得完整 RPC 账户后才生成不可变交易审查。

开始读取会清空旧审查、确认框与 PIN，读取期间禁止签名。完成后展示 RPC 来源、费用、执行结果与完整审查，并再次要求确认和 PIN/触摸。改变所选 RPC 来源会废弃原审查，必须重新读取。网络、格式或读取错误会拒绝当前请求，旧离线审查随请求一起失效。用户可以取消读取并拒绝请求，账户或会话变化、请求过期也会中止读取，迟到结果无法恢复请求。

Solana 批量 RPC 在首次设备签名前读取全部交易并展示每项通过/失败状态，失败交易展开完整审查。任意一笔失败使整批无法签名。全部通过后按原顺序逐笔确认，每笔仍只有单次硬件批准。首笔签名开始后，该批次不再允许重新读取或切换 RPC 来源。有效期取原请求截止时间与整批最早 RPC 上下文截止时间的较早值，过期时废弃已保存的部分签名结果。

新增 15 项本地测试验证固定输入、显式读取、ALT 等待与补全、三版本批次、后续失败/未知指令阻止整批、来源切换、重复与并发操作、读取取消/断连/过期/迟到回包、读取失败后旧审查失效，以及消息方法和设备签名期间的入口限制。官方 SignClient 2.26.0 双端真实 relay 通过 25 项检查，新增 EVM RPC 后重新确认、Solana ALT 补全，以及整批 RPC 后逐笔签名。relay 测试的 RPC 远端状态和 OpenPGP 硬件使用专用合成数据，生产 RPC 传输、审查和签名控制器均实际执行。浏览器已检查未连接状态的说明页与 RPC 控件隐藏状态，当前请求控件通过连接控制器测试验证，实际 WebUSB 与第三方 dApp 联合流程仍待验收。[relay 记录](walletconnect/relay-2026-11-09.json)、[说明页验收图](screenshots/walletconnect-rpc-2026-11-09.png)

## 验证与后续工作

新增 18 项本地测试，覆盖配置与 CSP、响应 ID/格式/大小/UTF-8、超时、取消和迟到响应、网络不匹配、ALT 错误、slot 约束、费用缺失、模拟失败、日志、原始字节固定、v1、过期及触摸期间过期。通过模拟 OpenPGP 设备验证批准与 PIN 清除，成功模拟无法绕过未知指令策略。

`npm run test:rpc -- /tmp/canokey-rpc.json` 使用专用合成公钥和交易，实际读取公共 Devnet 的 genesis、blockhash、账户、消息费用并模拟原始交易。最新实测费用为 5000 lamports，模拟返回 InvalidAccountForFee，对应 signable=false。该次记录验证 RPC 传输和错误策略，成功执行及真机签名仍需后续验收。[实测记录](rpc/devnet-2026-11-09.json)

当前 RPC 入口适用于手动及 WalletConnect 的 Solana/EVM 交易审查。手动签名结果新增独立批准的提交与状态查询流程，共用有界传输，读取与提交方法使用独立白名单。[广播流程](BROADCAST_PROTOCOL.md)

Token 扩展状态、成功链上执行与实际设备/第三方 dApp 联合验收仍需继续完成。当前 WalletConnect 方法集按已实现能力和提交网络 RPC 配置授予。
