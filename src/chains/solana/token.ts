import { base58 } from '@scure/base';
import { Reader } from './codec';
import type { Account } from './instructions';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export function reviewTokenInstruction(program: string, bytes: Uint8Array, selected: readonly Account[], prefix: string): {
  rows: [string, string][]; understood: boolean;
} {
  const rows: [string, string][] = [];
  let understood = true;
  const token2022 = program === TOKEN_2022_PROGRAM_ID;
  const tokenName = token2022 ? 'Token-2022' : 'SPL Token';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const add = (name: string, value: string) => rows.push([`${prefix} / ${name}`, value]);
  const count = (value: number) => { if (selected.length !== value) throw new Error(`${prefix} 账户数量无效`); };
  const writable = (position: number) => { if (!selected[position]?.writable) throw new Error(`${prefix} 缺少可写账户 ${position}`); };
  const signer = (position: number) => { if (!selected[position]?.signer) throw new Error(`${prefix} 缺少签名者 ${position}`); };
  const authority = (position: number, end = selected.length) => {
    if (end === position + 1) signer(position);
    else {
      if (end < position + 2 || end > position + 12) throw new Error('Token 多签数量无效');
      const signers = selected.slice(position + 1, end);
      if (token2022 && (selected[position]!.signer || new Set(signers.map((account) => account.address)).size !== signers.length)) throw new Error('Token-2022 authority 附加账户不是明确的多签签名者');
      for (let i = position + 1; i < end; i++) signer(i);
    }
    add('授权账户', selected[position]!.address);
    if (end > position + 1) add('多签签名者', selected.slice(position + 1, end).map((account) => account.address).join(', '));
  };
  const length = (value: number) => { if (bytes.length !== value) throw new Error(`${prefix} 数据长度无效`); };
  const unknown = () => { understood = false; add('策略', '未知 Token 指令，当前拒签'); };
  if (token2022) add('Token-2022 状态来源', '未读取 Mint 与 Token 账户扩展。余额、authority、扩展限制及可执行性需可信链上上下文核对。');
  const type = bytes[0]!;
  if ([3, 4, 7, 8, 12, 13, 14, 15].includes(type)) {
    const checked = type >= 12;
    length(checked ? 10 : 9);
    const isTransfer = type === 3 || type === 12, isApprove = type === 4 || type === 13;
    const authPosition = checked && (isTransfer || isApprove) ? 3 : 2;
    if (selected.length <= authPosition) throw new Error('Token 指令账户不足');
    writable(0);
    if (isTransfer) writable(checked ? 2 : 1);
    else if (!isApprove) writable(1);
    authority(authPosition);
    add('操作', isTransfer ? `${tokenName} 转移` : isApprove ? `${tokenName} delegate 授权` : [7, 14].includes(type) ? `增发 ${tokenName}` : `销毁 ${tokenName}`);
    add('源账户 / Mint', selected[0]!.address); add(isApprove ? 'Delegate' : '目标账户 / Mint', selected[checked && (isTransfer || isApprove) ? 2 : 1]!.address);
    add('数量（最小单位）', view.getBigUint64(1, true).toString());
    if (isApprove && view.getBigUint64(1, true) === 0xffffffffffffffffn) add('授权额度', '最大 u64 授权');
    if (checked) {
      add('Mint', selected[isTransfer || isApprove ? 1 : type === 14 ? 0 : 1]!.address);
      add('decimals（指令声明）', String(bytes[9]));
    } else add('decimals 来源', '未提供，按最小单位整数展示');
    if (token2022 && isTransfer) {
      understood = false;
      add('策略', '此转移未声明预期手续费，当前拒签。请使用 TransferCheckedWithFee 提供总额及预期手续费。');
    }
  } else if (type === 5 || type === 9) {
    length(1);
    const authPosition = type === 5 ? 1 : 2;
    if (selected.length <= authPosition) throw new Error('Token 指令账户不足');
    writable(0); if (type === 9) writable(1); authority(authPosition);
    add('操作', type === 5 ? `撤销 ${tokenName} delegate 授权` : token2022 ? '关闭 Token 账户或 Mint 并转移全部 SOL' : '关闭 Token 账户并转移全部 SOL');
    add('Token 账户', selected[0]!.address);
    if (type === 9) add('SOL 接收账户', selected[1]!.address);
  } else if (type === 6) {
    if (bytes.length !== 3 && bytes.length !== 35) throw new Error('SetAuthority 长度无效');
    const authorityTypes = ['Mint Tokens', 'Freeze Account', 'Account Owner', 'Close Account', 'Transfer Fee Config', 'Withdraw Withheld Fees',
      'Close Mint', 'Interest Rate', 'Permanent Delegate（可转移或销毁此 Mint 的任意 Token）', 'Confidential Transfer Mint',
      'Transfer Hook Program', 'Confidential Transfer Fee Config', 'Metadata Pointer', 'Group Pointer', 'Group Member Pointer',
      'Scaled UI Amount', 'Pause / Resume', 'Permissioned Burn'];
    if (bytes[1]! >= (token2022 ? authorityTypes.length : 4) || bytes[2]! > 1 || bytes.length !== (bytes[2] ? 35 : 3) || selected.length < 2) throw new Error('SetAuthority 参数无效');
    writable(0); authority(1);
    add('操作', `修改 ${tokenName} authority`); add('账户', selected[0]!.address);
    add('Authority 类型', authorityTypes[bytes[1]!]!);
    add('新 Authority', bytes[2] ? base58.encode(bytes.slice(3)) : 'None，撤销此 authority');
  } else if (type === 17) {
    length(1); count(1); writable(0); add('操作', '同步 Wrapped SOL 余额'); add('账户', selected[0]!.address);
  } else if (token2022 && (type === 10 || type === 11)) {
    length(1); if (selected.length < 3) throw new Error('Token 冻结指令账户不足');
    writable(0); authority(2);
    add('操作', type === 10 ? '冻结 Token-2022 账户' : '解冻 Token-2022 账户');
    add('Token 账户', selected[0]!.address); add('Mint', selected[1]!.address);
  } else if (token2022 && type === 22) {
    length(1); count(1); writable(0);
    add('操作', '初始化 Immutable Owner'); add('Token 账户', selected[0]!.address);
    add('效果', '永久阻止更改此 Token 账户的 owner，必须在初始化账户前执行。');
  } else if (token2022 && (type === 30 || type === 34)) {
    length(2); if (bytes[1]! > 1 || selected.length < 2) throw new Error('Token-2022 扩展开关参数无效');
    writable(0); authority(1);
    const enable = bytes[1] === 0;
    add('Token 账户', selected[0]!.address);
    if (type === 30) {
      add('操作', enable ? '启用转入 Memo 要求' : '禁用转入 Memo 要求');
      add('效果', enable ? '转入此账户时，前一条同级指令必须为 Memo。' : '取消此账户对转入前置 Memo 的要求。');
    } else {
      add('操作', enable ? '启用 CPI Guard' : '禁用 CPI Guard');
      add('效果', enable ? '限制通过 CPI 执行转移、销毁、关闭账户、授权及修改 authority。' : '取消此账户的 CPI Guard 限制，允许按 Token 程序规则从其他程序调用操作。');
    }
  } else if (token2022 && type === 26 && bytes.length >= 2) {
    const subtype = bytes[1]!;
    if (subtype === 1) {
      length(19); if (selected.length < 4) throw new Error('Token-2022 转移账户不足');
      writable(0); writable(2); authority(3);
      const amount = view.getBigUint64(2, true), fee = view.getBigUint64(11, true);
      if (fee > amount) throw new Error('预期手续费超过转移总额');
      add('操作', 'Token-2022 转移并核对预期手续费');
      add('源账户', selected[0]!.address); add('Mint', selected[1]!.address); add('目标账户', selected[2]!.address);
      add('转移总额（最小单位）', amount.toString()); add('预期预扣手续费（最小单位）', fee.toString());
      add('decimals（指令声明）', String(bytes[10]));
      add('预计新增可用余额（最小单位）', selected[0]!.address === selected[2]!.address ? '0（自转移，仅校验，不变更余额或预扣手续费）' : (amount - fee).toString());
      add('手续费校验', '链上按执行时的 Mint 费率计算并核对预期费用，不一致时交易失败。');
    } else if (subtype === 0 || subtype === 5) {
      writable(0);
      let feeOffset = 2;
      if (subtype === 0) {
        count(1);
        const reader = new Reader(bytes); reader.take(2);
        const optionalKey = () => {
          const flag = reader.byte();
          if (flag > 1) throw new Error('Transfer Fee authority option 无效');
          return flag ? base58.encode(reader.take(32)) : undefined;
        };
        const configAuthority = optionalKey(), withdrawAuthority = optionalKey();
        feeOffset = reader.offset; reader.take(10); reader.end();
        add('操作', '初始化 Token-2022 Transfer Fee Config'); add('Mint', selected[0]!.address);
        add('费率配置 Authority', configAuthority ?? 'None，费率配置将不可更改');
        add('手续费提取 Authority', withdrawAuthority ?? 'None，预扣手续费将无法通过此 authority 提取');
        add('初始化条件', '必须在初始化 Mint 前执行。');
      } else {
        length(12); if (selected.length < 2) throw new Error('Transfer Fee 配置账户不足');
        authority(1); add('操作', '修改 Token-2022 Transfer Fee'); add('Mint', selected[0]!.address);
        add('生效范围', '新费率按链上 epoch 计划生效，当前与计划配置需可信链上上下文核对。');
      }
      const basisPoints = view.getUint16(feeOffset, true);
      if (basisPoints > 10000) throw new Error('手续费费率超过 10000 basis points');
      add('转移手续费费率（basis points，1/10000）', String(basisPoints));
      add('每笔手续费上限（最小单位）', view.getBigUint64(feeOffset + 2, true).toString());
    } else if (subtype === 2 || subtype === 3) {
      length(subtype === 2 ? 2 : 3);
      const sourceCount = subtype === 3 ? bytes[2]! : 0;
      const authorityEnd = selected.length - sourceCount;
      if (authorityEnd < 3) throw new Error('预扣手续费提取账户不足');
      writable(1); authority(2, authorityEnd);
      if (subtype === 2) writable(0);
      add('操作', subtype === 2 ? '从 Mint 提取全部预扣手续费' : '从 Token 账户提取全部预扣手续费');
      add('Mint', selected[0]!.address); add('接收 Token 账户', selected[1]!.address);
      for (let i = authorityEnd; i < selected.length; i++) { writable(i); add(`手续费源账户 ${i - authorityEnd}`, selected[i]!.address); }
      add('提取数量来源', '由执行时的预扣手续费余额决定，尚未读取链上状态。');
    } else if (subtype === 4) {
      length(2); if (!selected.length) throw new Error('归集预扣手续费缺少 Mint');
      writable(0); add('操作', '将账户预扣手续费归集至 Mint'); add('Mint', selected[0]!.address);
      selected.slice(1).forEach((account, index) => { writable(index + 1); add(`手续费源账户 ${index}`, account.address); });
      add('归集范围', '将所列账户的全部预扣手续费归集至 Mint，此操作无需 Token owner 签名。');
    } else unknown();
  } else unknown();
  return { rows, understood };
}
