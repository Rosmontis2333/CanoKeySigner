import { createContract, Decoder, parseAbi } from 'micro-eth-signer/abi.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const abi = parseAbi([
  'function transfer(address to, uint256 value)',
  'function approve(address spender, uint256 value)',
  'function transferFrom(address from, address to, uint256 value)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, uint256 amount, bytes data)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
]);
// A local ABI registry key, independent of the transaction's actual contract address.
const REGISTRY_KEY = '0x0000000000000000000000000000000000000000';
const decoder = new Decoder();
decoder.add(REGISTRY_KEY, abi);
const encoders = createContract(abi);
const MAX_BATCH_ITEMS = 128;
const MAX_CALLBACK_BYTES = 4096;
const MAX_CALLDATA_BYTES = 16384;
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = REGISTRY_KEY;

const layouts: Readonly<Record<string, { words: number; tails: readonly (readonly [number, 'bytes' | 'array'])[] }>> = {
  a9059cbb: { words: 2, tails: [] },
  '095ea7b3': { words: 2, tails: [] },
  '23b872dd': { words: 3, tails: [] },
  '42842e0e': { words: 3, tails: [] },
  b88d4fde: { words: 4, tails: [[3, 'bytes']] },
  a22cb465: { words: 2, tails: [] },
  f242432a: { words: 5, tails: [[4, 'bytes']] },
  '2eb2c2d6': { words: 5, tails: [[2, 'array'], [3, 'array'], [4, 'bytes']] },
};

/** Bound dynamic lengths before the general ABI decoder allocates any arrays. */
function checkLayout(body: string, layout: typeof layouts[string]): void {
  const length = body.length / 2;
  if (length < layout.words * 32) throw new Error('ABI 参数头被截断');
  let cursor = layout.words * 32;
  function word(offset: number): bigint {
    if (offset + 32 > length) throw new Error('ABI 动态长度被截断');
    return BigInt(`0x${body.slice(offset * 2, (offset + 32) * 2)}`);
  }
  for (const [index, type] of layout.tails) {
    if (word(index * 32) !== BigInt(cursor)) throw new Error('ABI 动态偏移需要连续、按参数顺序排列');
    const count = word(cursor);
    const limit = type === 'array' ? MAX_BATCH_ITEMS : MAX_CALLBACK_BYTES;
    if (count > BigInt(limit)) throw new Error(type === 'array' ? `批量数组超过 ${limit} 项` : `回调数据超过 ${limit} 字节`);
    cursor += 32 + (type === 'array' ? Number(count) * 32 : Math.ceil(Number(count) / 32) * 32);
    if (cursor > length) throw new Error('ABI 动态数据被截断');
  }
  if (cursor !== length) throw new Error('ABI 参数包含尾随数据');
}

/** Decode known ABI shapes, keeping selector collisions explicit in the review. */
export function reviewEvmCalldata(data: string, nativeValue: bigint): { understood: boolean; rows: [string, string][] } {
  const hex = data.replace(/^0x/, '').toLowerCase();
  const layout = layouts[hex.slice(0, 8)];
  if (!layout) return { understood: false, rows: [] };
  try {
    if (!/^(?:[0-9a-f]{2})+$/.test(hex) || hex.length / 2 > MAX_CALLDATA_BYTES) throw new Error('Calldata 编码或大小无效');
    checkLayout(hex.slice(8), layout);
    const decoded = decoder.decode(REGISTRY_KEY, hexToBytes(hex));
    if (!decoded || Array.isArray(decoded) || !decoded.value || typeof decoded.value !== 'object') throw new Error('ABI 解码失败');
    const method = encoders[decoded.signature] ?? encoders[decoded.name];
    if (!method || bytesToHex(method.encodeInput(decoded.value)) !== hex) throw new Error('ABI 参数填充或编码不规范');
    // Values have already passed the registered ABI's scalar/array validation.
    const value = decoded.value as Record<string, string | bigint | boolean | Uint8Array | bigint[]>;
    const rows: [string, string][] = [['函数签名（ABI 匹配）', decoded.signature]];
    const selector = hex.slice(0, 8);
    let acceptsNativeValue = false;
    switch (selector) {
      case 'a9059cbb':
        rows.push(['调用解释', 'ERC-20 transfer 转账'], ['Token 收款人', String(value.to)],
          ['Token 数量（最小单位）', String(value.value)]);
        break;
      case '095ea7b3':
        acceptsNativeValue = true;
        rows.push(['调用解释', 'ERC-20 / ERC-721 approve 授权'], ['Spender / Approved', String(value.spender)],
          ['ERC-20 数量（最小单位）', String(value.value)], ['ERC-721 Token ID', String(value.value)],
          ['资产标准', 'ERC-20 与 ERC-721 共享此函数编码，资产类型需要核对目标合约']);
        if (value.value === UINT256_MAX) rows.push(['ERC-20 授权额度', '无限授权']);
        if (value.value === 0n) rows.push(['ERC-20 授权效果', '将该 spender 的额度设为零']);
        if (value.spender === ZERO_ADDRESS) rows.push(['ERC-721 授权效果', '清除该 Token ID 的单独授权']);
        break;
      case '23b872dd':
        acceptsNativeValue = true;
        rows.push(['调用解释', 'ERC-20 / ERC-721 transferFrom 转移'], ['转出账户 from', String(value.from)],
          ['接收账户 to', String(value.to)], ['ERC-20 数量（最小单位）', String(value.value)], ['ERC-721 Token ID', String(value.value)],
          ['资产标准', 'ERC-20 与 ERC-721 共享此函数编码，资产类型需要核对目标合约']);
        break;
      case '42842e0e':
      case 'b88d4fde':
        acceptsNativeValue = true;
        rows.push(['调用解释', 'ERC-721 safeTransferFrom 转移'], ['转出账户 from', String(value.from)],
          ['接收账户 to', String(value.to)], ['Token ID', String(value.tokenId)]);
        break;
      case 'a22cb465':
        rows.push(['调用解释', 'ERC-721 / ERC-1155 setApprovalForAll'], ['Operator', String(value.operator)],
          ['全部资产授权', value.approved ? '授予' : '撤销'],
          ['授权范围', '该合约内当前及未来持有的全部 Token ID。授予后 operator 可转移这些资产。']);
        break;
      case 'f242432a':
        rows.push(['调用解释', 'ERC-1155 safeTransferFrom 转移'], ['转出账户 from', String(value.from)],
          ['接收账户 to', String(value.to)], ['Token ID', String(value.tokenId)], ['数量（最小单位）', String(value.amount)]);
        break;
      case '2eb2c2d6': {
        const ids = value.ids as bigint[], amounts = value.amounts as bigint[];
        if (ids.length !== amounts.length) throw new Error('ERC-1155 Token ID 与数量数组长度不一致');
        rows.push(['调用解释', 'ERC-1155 safeBatchTransferFrom 批量转移'], ['转出账户 from', String(value.from)],
          ['接收账户 to', String(value.to)], ['批量条目数', String(ids.length)]);
        ids.forEach((id, index) => rows.push([`条目 ${index + 1} · Token ID`, id.toString()], [`条目 ${index + 1} · 数量（最小单位）`, amounts[index]!.toString()]));
        break;
      }
    }
    if (value.data instanceof Uint8Array) rows.push(['接收方回调数据 Hex', `0x${bytesToHex(value.data)}`],
      ['接收方回调数据字节数', String(value.data.length)], ['接收方回调', '按原样传给接收合约，接收合约可根据这些字节执行额外逻辑']);
    const understood = acceptsNativeValue || nativeValue === 0n;
    if (nativeValue) rows.push(['随调用发送的原生币（wei）', nativeValue.toString()],
      ['原生币处理', acceptsNativeValue ? '该 ERC-721 接口允许 payable，实际收款和调用结果取决于目标合约'
        : '当前标准调用的规则要求 value 为零，拒签']);
    rows.push(['解释范围', '按标准 ABI 解码参数，目标合约身份、实现、代理及实际执行行为尚需核对']);
    return { understood, rows };
  } catch (error) {
    return { understood: false, rows: [['调用解码', error instanceof Error ? error.message : 'ABI 参数无效']] };
  }
}
