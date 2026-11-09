# P0 协议核对与真机验收

核对日期为 2026-11-09。基线为 canokey-core `3.0.3`，提交 `7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f`，以及该提交引用的 canokey-crypto `c65b9015d44115182ac5106f58a228efb569c93f`。本页记录源码事实及由源码推算的容量。真机签名、PIN、触摸、操作系统兼容性和商业硬件的 vendor 实现均待验证。

## WebUSB

core 默认 VID/PID 为 `20A0/42D4`。WebUSB 接口的 class、subclass、protocol 均为 `FF`，没有数据端点。接口号由硬件资源分配函数动态决定，客户端需要扫描配置描述符并 claim 对应接口。[设备描述符](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/interfaces/USB/device/usbd_desc.h)、[接口描述符](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/interfaces/USB/device/usbd_desc.c)

APDU 通过 EP0 control transfer 传输，使用 `requestType=vendor`、`recipient=interface`、`index=interfaceNumber`、`value=0`。一次交互依次执行下表中的操作。[WebUSB 实现](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/interfaces/USB/class/webusb/webusb.c)

| 步骤 | 方向及 request | 数据 |
| --- | --- | --- |
| 发送 | OUT `00` | 完整 CAPDU，最大 1340 字节，包含 APDU 头与长度字段 |
| 等待 | IN `02` | 读取 1 字节状态，`00` 表示响应就绪，`01` 表示执行中 |
| 接收 | IN `01` | 一次读取完整 RAPDU，缓冲至少 1342 字节，末两字节为 SW |

其他状态为 `FF` 空闲、`02` 响应发送中、`03` 接收中、`04` 持有共享缓冲。响应传输完成后进入 `04`，约两秒没有 keepalive 才释放共享 APDU 缓冲。CCID 与 WebUSB 共享缓冲，获取失败会导致 control transfer stall。客户端需要检查 transfer status、响应长度和超时，超时后废弃会话。RAPDU 读取会推进设备状态，截短读取后无法通过再次读取补齐。

## 只读发现 APDU

下表中的空格仅用于分隔字节。所有返回值均先检查 SW，再解析数据。`6A88` 可以表示未安装密钥。Applet 切换会调用 `applets_poweroff()` 清除各 applet 认证状态。相同 applet 的再次 SELECT 不触发这一通用清理。PIV SELECT 自身仍会清除 PIV 认证状态，OpenPGP 的同 applet SELECT 则保留认证。关闭浏览器 USB handle 是否等效于卡端掉电仍需真机确认。[APDU 分发](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/src/apdu.c)、[认证清理](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/src/applets.c)

| 目的 | CAPDU | 解析 |
| --- | --- | --- |
| 选择 Admin | `00 A4 04 00 05 F0 00 00 00 00` | 检查成功状态 |
| 固件版本 | `00 31 00 00 00` | vendor 自定义返回值，保留原始字节 |
| 硬件型号 | `00 31 01 00 00` | vendor 自定义返回值，保留原始字节 |
| 选择 OpenPGP | `00 A4 04 00 06 D2 76 00 01 24 01` | 检查成功状态 |
| OpenPGP 应用相关数据 | `00 CA 00 6E 00` | BER TLV，必要时 GET RESPONSE |
| SIG 公钥 | `00 47 81 00 02 B6 00` | `7F49` 外层，内部公钥模板 |
| AUT 公钥 | `00 47 81 00 02 A4 00` | `7F49` 外层，内部公钥模板 |
| 选择 PIV | `00 A4 04 00 05 A0 00 00 03 08` | 返回应用信息 |
| PIV 槽位 metadata | `00 F7 00 ss 00` | `ss` 为 `9A/9C/9D/9E/82/83` |

Admin 的 `31` 在 PIN 检查之前分发。core 中版本与硬件查询是 weak vendor 函数，默认可返回成功加空数据，客户端必须将其显示为未知。PIV 的 `00 FD 00 00 00` 固定返回 `05 07 00`，只能作为兼容版本记录。[Admin 实现](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/admin/admin.c)、[PIV 版本实现](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/piv/piv.c#L1071)

OpenPGP 在 `6E` 的 `73` 对象内返回 `C1` SIG、`C2` DEC、`C3` AUT 算法属性，`DE` 含密钥来源，`D6/D7/D8` 含 UIF。该版本没有单独 GET DATA `C1/C3` 的分支。secp256k1 ECDSA 属性值为 `13 2B 81 04 00 0A`，Ed25519 为 `16 2B 06 01 04 01 DA 47 0F 01`。现有公钥读取使用 `47` 的 `P1=81` 分支，返回 `7F49` 模板。secp256k1 内部为 `86 41 04 <X32><Y32>`，Ed25519 为 `86 20 <public32>`。固件会在较短对象上使用 `82` 两字节长度，BER 解码需要接受这种明确长度编码。[OpenPGP 实现](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/openpgp/openpgp.c)、[公钥编码](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/src/key.c#L11)

PIV metadata 为顺序 TLV，`01` 算法 ID、`02` 两字节 PIN/触摸策略、`03` 密钥来源、`04` 公钥模板。`04` 内部同样使用 `86` 公钥对象。PIN 策略 `01/02/03` 表示 never/once/always，触摸策略 `00/01/02/03` 表示 default/never/always/cached。密钥来源 `01/02` 表示卡内生成/导入。metadata 成功及公钥长度仅支持能力识别，签名路径仍需验签确认。[PIV metadata](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/piv/piv.c#L984)、[策略定义](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/include/key.h)

## 签名路径基线

后续真机验证应使用外部管理工具预先配置的专用测试槽位。下表的 `Lc/Data/Le` 需由 APDU 编码器根据精确字节长度生成。ECDSA 输入固定为 32 字节摘要，Ed25519 输入为原始消息。[OpenPGP 签名](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/openpgp/openpgp.c#L745)、[PIV 签名](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/piv/piv.c#L533)、[密码层接口](https://github.com/canokeys/canokey-crypto/blob/c65b9015d44115182ac5106f58a228efb569c93f/include/ecc.h)

| 路径 | VERIFY | 签名命令 | 返回编码 | 真机状态 |
| --- | --- | --- | --- | --- |
| OpenPGP SIG secp256k1 | `00 20 00 81 Lc PIN` | `00 2A 9E 9A Lc digest Le` | 64 字节 `r32‖s32` | 待验证 |
| OpenPGP AUT secp256k1 | `00 20 00 82 Lc PIN` | `00 88 00 00 Lc digest Le` | 64 字节 `r32‖s32` | 待验证 |
| OpenPGP SIG/AUT Ed25519 | 对应 SIG/AUT VERIFY | 对应 SIG/AUT 命令，Data 为原始消息 | 64 字节 Ed25519 | 待验证 |
| PIV secp256k1 | `00 20 00 80 08 PIN8` | `00 87 53 ss Lc template Le` | `7C {82 DER-ECDSA}` | 待验证 |
| PIV Ed25519 | `00 20 00 80 08 PIN8` | `00 87 E0 ss Lc template Le` | `7C {82 signature64}` | 待验证 |

PIV `template` 为 `7C {82 00, 81 message}`。其中 `82` 请求返回签名，`81` 携带摘要或原始消息。PIV PIN 必须为 8 字节，短 PIN 以 `FF` 补齐。OpenPGP PW1 直接传入 PIN 字节，不做该补齐。错误 PIN 的状态码在两 applet 间不同，OpenPGP 错误可能为 `6982`，PIV 为 `63Cx`，耗尽为 `6983`。记录结果后由操作者决定下一步，重试须重新明确发起。[PIN 与认证实现](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/piv/piv.c#L446)、[OpenPGP VERIFY](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/openpgp/openpgp.c#L604)

PIV 默认扩展算法 ID 为 secp256k1 `53`、Ed25519 `E0`。自定义扩展配置是 7 字节结构，顺序为 enabled、ed25519、rsa3072、rsa4096、x25519、secp256k1、sm2。读取命令 `00 EE 01 00` 也要求 management authentication。客户端使用经外部管理工具核实的映射及 metadata 结果，验签时再次核验实际算法。[PIV 扩展结构](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/include/piv.h)、[扩展读取权限](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/applets/piv/piv.c#L1092)

## 长度与响应链

`APDU_BUFFER_SIZE=1340` 同时限制 WebUSB 原始命令长度与通用 command chaining 的累计 Data 长度。扩展 APDU 的头部占用实际传输容量。下表为源码算出的上限，尚需实际设备确认。[容量常量](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/include/common.h)、[APDU 解析及链式处理](https://github.com/canokeys/canokey-core/blob/7644370f0c16d5b5e0d2f503e6c47bd39aaa0e2f/src/apdu.c)

| 形式 | 最大 Data | OpenPGP Ed25519 最大消息 | PIV Ed25519 最大消息 |
| --- | --- | --- | --- |
| 单次扩展 Case 3，7 字节头 | 1333 | 1333 | 1323 |
| 单次扩展 Case 4，9 字节总开销 | 1331 | 1331 | 1321 |
| command chaining 聚合 | 1340 | 1340 | 1330 |

PIV 此处按消息至少 256 字节计算，`7C` 和 `81` 均采用 `82 hi lo` 长度，加上 `82 00` 共 10 字节 TLV 开销。小消息的开销随长度字段变化。客户端对实际编码结果计数，不能用固定消息常数覆盖全部情况。空消息在 PIV 签名分支中不满足 challenge 长度条件，需显式拒绝。

分包时中间命令的 CLA 设置 `10`，其他头字段一致，最后一包恢复 `00`。中间包应得到 `9000` 且没有数据。累计长度仍受 1340 字节限制。通用 RAPDU 按 Le 分段，`61xx` 表示仍有数据，剩余超过 255 字节时返回 `61FF`。客户端发送 `00 C0 00 00 xx` 获取后续片段，限制总长度及响应轮数。PIV GET DATA 对象读取有独立流式分支，这不改变 GENERAL AUTHENTICATE 的聚合容量。

## P0 真机记录表

源码核对已完成。2026-11-09 已完成当前设备 SIG Ed25519 / AUT secp256k1 的基础签名及独立验签。长度边界及其余矩阵按下表继续记录。[本次真机记录](hardware/OPENPGP_2026-11-09.md)

| 组合 | 公钥/metadata | 精确输入签名及独立验签 | PIN/触摸 | 传输边界 | 当前结论 |
| --- | --- | --- | --- | --- | --- |
| OpenPGP SIG secp256k1 | 待设备 | 待设备 | 待设备 | 待设备 | 阻塞 |
| OpenPGP AUT secp256k1 | 已读取 | 基础摘要通过 | PW1 与触摸通过 | 待设备 | 基础路径已验证 |
| OpenPGP SIG Ed25519 | 已读取 | 98 字节原始消息通过 | PW1 通过，UIF 关闭 | 长消息边界待设备 | 基础路径已验证 |
| OpenPGP AUT Ed25519 | 待设备 | 待设备 | 待设备 | 待设备 | 阻塞 |
| PIV 六槽位 secp256k1 | 按实际配置逐槽记录 | 待设备 | 待设备 | 待设备 | 阻塞 |
| PIV 六槽位 Ed25519 | 按实际配置逐槽记录 | 待设备 | 待设备 | 待设备 | 阻塞 |

1. 在桌面 Chromium 的 localhost/HTTPS 打开探测页，记录操作系统、浏览器、USB VID/PID、接口号及 Admin 版本/硬件原始返回值。
2. 读取现有 SIG/AUT 及 PIV 六槽位，记录算法属性、公钥、来源、PIN/触摸策略。由外部管理工具确认 PIV 扩展 ID 映射。
3. 使用无资产的固定测试摘要与原始消息，各验证两 applet 的 ECDSA/Ed25519 签名，以独立实现交叉验签。ECDSA 同时检查两种返回格式及 high-S 处理，Ed25519 比较精确原始输入。
4. 使用专用测试 PIN 验证成功、单次错误、PIN 策略、触摸超时与触摸缓存。记录 applet 切换、显式退出认证及 USB 关闭后的卡端状态。
5. 在 `255/256`、上述最大消息附近、完整命令 `1340/1341` 处检查短/扩展 APDU、分包和 GET RESPONSE。越界用客户端拒绝路径验证，避免向设备发送超出协议限制的 USB 命令。
6. 检查断连、超时、取消、跨标签争用及 CCID/GnuPG 占用。废弃操作的迟到响应不能完成新请求。
7. 每条记录附设备标识、精确输入长度、摘要/消息、公开密钥、公开签名与独立验签输出。PIN 与管理认证数据不进入记录。

当前只读探测和软件小样可继续开发。P0 的硬件验收仍待以上记录，后续阶段的可用能力由该记录决定。
