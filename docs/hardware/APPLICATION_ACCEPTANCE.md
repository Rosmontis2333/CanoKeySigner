# 应用真机验收材料

2026-11-09。已准备 9 组固定离线输入，生成时通过生产解析器，并分别用 Ox、bitcoinjs-lib、Solana Web3.js 或独立消息布局核对摘要及序列化。本批状态为 prepared-awaiting-hardware，实际签名、认证退出和结果验签尚待设备操作。[输入清单与精确签名内容](acceptance-2026-11-09/manifest.json)

本轮现场测试已按用户要求停止，材料作为交付记录保留。[交付说明](../DELIVERY.md)

材料使用此前真机证据中的 AUT/secp256k1 和 SIG/Ed25519 公钥。使用前在应用重新读取设备，逐字节核对两份公钥及对应地址。设备或槽位已更改时，需使用新公钥对应的已验签公开证据重新生成。[原始公开证据](openpgp-2026-11-09.json)

| 输入文件 | 页面选择 | 核对内容 |
| --- | --- | --- |
| evm-type-0.json | EVM，AUT，交易 | chainId 31337、nonce 0、value 0、gasLimit 21000、gasPrice 2 wei |
| evm-type-1.json | EVM，AUT，交易 | 同上，空 accessList |
| evm-type-2.json | EVM，AUT，交易 | chainId 31337、nonce 0、value 0、gasLimit 21000、maxFee 2、priority 1 wei |
| bitcoin-p2wpkh.psbt | Bitcoin，AUT，testnet/signet，PSBT | 一项 P2WPKH 输入，100000 sat，两个输出 50000/48000 sat，费用 2000 sat，SIGHASH_ALL |
| solana-legacy.base64 | Solana，SIG，devnet，Base64 transaction | 原始 legacy 消息、一个 signer、零 lamport 转移 |
| solana-v0.base64 | Solana，SIG，devnet，Base64 transaction | v0 消息、空 ALT 列表、一个 signer、零 lamport 转移 |
| solana-message-255.txt | Solana，SIG，可阅读离链消息 | offchain v1 完整签名消息 255 字节，正文 205 字节 |
| solana-message-256.txt | Solana，SIG，可阅读离链消息 | 完整签名消息 256 字节，正文 206 字节 |
| solana-message-1331.txt | Solana，SIG，可阅读离链消息 | 完整签名消息 1331 字节，正文 1281 字节 |

EVM 使用本地测试 chainId 31337。Bitcoin 的完整前序交易为合成数据，Solana 使用固定占位 blockhash。本批用于离线签名及导出，链上执行由单独的测试网络验收覆盖。

每项分别导入、解析并完整审查，再在本地页面输入 PIN，按设备策略触摸。导出结果按输入文件名区分保存。每次核对页面验签和认证退出结果，记录设备、槽位、版本、签名输入、签名结果与验收时间。PIN 不写入记录或聊天。

结果复核时，EVM 比较原交易全部字段、参考摘要及恢复账户，Bitcoin 使用独立 PSBT/交易工具核对全部字段、BIP-143 摘要和签名，Solana 比较完整原消息及其他签名槽并使用 Node/OpenSSL 验证 Ed25519。失败、取消或退出认证未确认时，按页面提示处理后重新审查。

可以从公开证据重新生成到一个新目录。

```sh
npx tsx scripts/prepare-hardware-acceptance.mjs docs/hardware/openpgp-2026-11-09.json /tmp/canokey-acceptance
```

生成器先用 Node/OpenSSL 验证证据中的公开签名，再生成测试输入并核对参考实现。现有输出目录会被拒绝覆盖。清单记录源证据 SHA-256、每个输入的 SHA-256、已有公钥、参考摘要和精确消息，生成阶段不访问硬件。
