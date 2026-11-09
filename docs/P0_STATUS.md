# P0 开发进展

更新于 2026-11-09。已完成当前 CanoKey 的 OpenPGP SIG / Ed25519 与 AUT / secp256k1 基础真机签名及独立验签，PIV 按用户要求暂留，其余真机验收见矩阵。[本次真机记录](hardware/OPENPGP_2026-11-09.md)

## 运行

使用 Node.js 22.12 或更新版本，本次验证环境为 Node.js 22.23.1、npm 10.9.8。

```sh
npm ci
npm test
npm run build
npm run dev
```

开发入口为 `http://127.0.0.1:5173/`。静态产物位于 `dist/`，可通过 `npm run preview` 检查。WebUSB 设备读取需要支持 WebUSB、Web Locks 的桌面 Chromium 和 localhost/HTTPS。

## 已实现

| 交付 | 行为与证据 |
| --- | --- |
| OpenPGP 检查页 | 用户选择默认 VID/PID `20A0/42D4` 的设备或重新读取已授权设备，动态查找 WebUSB 接口，读取 Admin 版本/硬件、OpenPGP SIG/AUT 算法及公钥、PW1 重试数与触摸策略 |
| APDU 与 BER-TLV | 短/扩展 APDU 编码，完整命令最大 1340 字节，响应最大 1342 字节，有上限的 GET RESPONSE，兼容固件非最短 BER 长度编码 |
| 设备会话 | 同源标签页互斥、单活动 APDU、只读 10 秒与签名 45 秒传输超时、取消、断连处理、handle 所有权、迟到结果失效；认证退出未确认时要求拔插 |
| 签名响应 | 按显式算法区分 32 字节 ECDSA 摘要与 Ed25519 原始消息，处理 OpenPGP compact 与 PIV DER/TLV，使用公钥验签后输出 low-S compact ECDSA 或 Ed25519 签名 |
| BTC 库小样 | PSBT v0 的 P2WPKH/P2SH-P2WPKH，验证完整前序交易、取摘要、异步附签、验签、未知/专有字段及其他签名保留 |
| EVM 库小样 | 固定本地链合成 type 0/1/2 交易的摘要、异步附签、low-S、recovery parity、账户核对与序列化往返 |
| 页面约束 | 所有设备返回值使用文本节点显示，CSP `connect-src 'none'`，外部样式文件兼容严格 CSP，Vite 开发与预览响应提供禁止嵌入的头部 |

链小样通过测试回调取得签名，交易与密钥来自无资产测试数据。设备页提供固定只读查询及固定诊断消息的审查、PW1 验证、硬件签名、认证退出和公开证据导出。交易导入及交易签名审查流程依照 P1–P4 后续交付。

## 库接入结论

`@scure/btc-signer` 的公开 `preimageWitnessV0()` 返回最终 SHA256d 摘要。结合 `updateInput({partialSig})` 和 `toPSBT(0)` 可以接入异步硬件签名。必须显式设置 `unknown/proprietary='ignore'` 保留不理解的字段，并在附签后复核整个 PSBT。当前小样只对选中输入应用脚本和 sighash 策略，其他已有签名被保留。全交易混合输入策略及其他签名有效性检查归入 P2。P2PKH 对应的 `preimageLegacy` 为私有方法，后续需要独立评估。[Bitcoin 小样](../src/chains/bitcoin/probe.ts)

`micro-eth-signer` 的公开 `toBytes({includeSignature:false})` 配合 Keccak 得到 EIP-155 或 typed transaction 摘要。通过 `new Transaction()` 附加 r/s/yParity，再使用公开恢复账户、验签和解析接口复核。当前版本足以支持首轮外部签名接入。type 1/2 的独立交易实现差分验证及完整审查归入 P3。[EVM 小样](../src/chains/evm/probe.ts)

## 验证结果

`npm test` 的 51 项测试通过，`npm run build` 的严格 TypeScript 检查与 Vite 生产构建通过。

- BTC 摘要与独立 Node SHA256/BIP143 组装结果一致，附签结果与软件签名器一致，完成 finalize/extract 测试。
- EVM 命中 EIP-155 官方完整摘要与签名交易向量，覆盖三类型、公钥不符、重复哈希、high-S 和确认输入副本。
- ECDSA/Ed25519 响应使用 Node/OpenSSL 交叉验签，覆盖原始消息、DER 拒绝路径及容器歧义。
- APDU 覆盖 255/256 与 1340/1341 边界、响应链上限，mock USB 覆盖失败、超时、取消、断连后重连和迟到结果。
- OpenPGP mock 覆盖 SIG/AUT 与两算法的四种组合、255/256/1331 字节原始消息、PIN 单次尝试、密钥及策略变更、批准单次使用和清除认证期间的取消。
- 真机验证 SIG Ed25519 的 98 字节原始消息、AUT secp256k1 的 32 字节摘要与触摸流程。两条公开签名通过 Node/OpenSSL 独立验签及修改消息拒绝检查，两个 PW1 用途均退出成功。

当前构建包含所需 Noble 密码库及 OpenPGP 诊断入口，主 JavaScript 约 73 kB。生产页面仅引用本地产物，当前运行时代码没有导入 BTC/EVM 链库或 WalletConnect SDK。

## 依赖记录

已固定所有直接依赖及开发依赖的精确版本，保留现有依赖选择。完整传递依赖版本、npm registry 来源与 integrity 记录在 lockfile，包含 166 个包条目，涵盖不同平台的可选包。[锁定清单](../package-lock.json)

| 直接依赖 | 版本 | 许可证 | 当前用途 |
| --- | --- | --- | --- |
| @noble/curves | 2.2.0 | MIT | 签名响应与小样密码学验证 |
| @noble/hashes | 2.2.0 | MIT | EVM 小样 Keccak |
| @scure/base | 2.2.0 | MIT | 后续编码功能预留，沿用计划依赖 |
| @scure/btc-signer | 2.4.1 | MIT | BTC 小样 |
| micro-eth-signer | 0.20.1 | MIT | EVM 小样 |
| @walletconnect/sign-client | 2.26.0 | 随包 WalletConnect Community License | 可选依赖，P5 集成前单独评估 |
| TypeScript | 5.9.3 | Apache-2.0 | 严格类型检查 |
| Vite | 8.3.6 | MIT | 开发与静态构建 |
| tsx | 4.23.15 | MIT | Node 测试运行器 |
| @types/node | 22.20.5 | MIT | 开发类型 |
| @types/w3c-web-usb | 1.0.14 | MIT | WebUSB 类型 |

BTC/EVM 库各自包含 `@noble/curves` 和 `@noble/hashes` 2.4.0，和顶层 2.2.0 并存。WalletConnect 另包含多组较早的密码库版本，P5 依赖评估需要包含完整传递树。

lockfile 将 esbuild 0.28.2、fsevents 2.3.3 标记为带安装脚本。已查看随包元数据及 esbuild 安装代码，esbuild 会验证平台二进制，缺失可选包时可通过 npm 或 registry 下载补齐。当前 fsevents 包未声明 install/postinstall，lockfile 仍保留该标志。安装期网络行为与浏览器运行期 CSP 分别记录，依赖安全审计与可复现发布检查仍归入 P7。

## 下一验收门槛

当前已验证的硬件组合为 SIG Ed25519 与 AUT secp256k1。下一步补齐长消息、错误/超时及跨系统真机矩阵，再推进生产审查与签名基础。255/256/1331 字节当前通过 mock，尚未在本次设备上实测。PIV 按用户要求暂留。[P0 协议与真机验收步骤](P0_PROTOCOL.md)
