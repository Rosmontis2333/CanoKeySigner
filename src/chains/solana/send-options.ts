export interface SolanaSendOptions {
  readonly skipPreflight: boolean;
  readonly preflightCommitment: 'processed' | 'confirmed' | 'finalized' | 'recent' | 'single' | 'singleGossip' | 'root' | 'max';
  readonly maxRetries: number;
  readonly minContextSlot?: number;
}

export function solanaSendOptions(value: unknown = {}): SolanaSendOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sendOptions 需要对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['skipPreflight', 'preflightCommitment', 'maxRetries', 'minContextSlot'].includes(key))) throw new Error('sendOptions 包含未知字段');
  const skipPreflight = input.skipPreflight ?? false, preflightCommitment = input.preflightCommitment ?? 'confirmed';
  if (typeof skipPreflight !== 'boolean' || typeof preflightCommitment !== 'string'
    || !['processed', 'confirmed', 'finalized', 'recent', 'single', 'singleGossip', 'root', 'max'].includes(preflightCommitment)) throw new Error('sendOptions 预检设置无效');
  const maxRetries = input.maxRetries ?? 0, minContextSlot = input.minContextSlot;
  if (typeof maxRetries !== 'number' || !Number.isSafeInteger(maxRetries) || maxRetries < 0
    || (minContextSlot !== undefined && (typeof minContextSlot !== 'number' || !Number.isSafeInteger(minContextSlot) || minContextSlot < 0))) throw new Error('sendOptions 重传次数与最小 slot 需要安全非负整数');
  if (Object.values(input).some((field) => field === null)) throw new Error('sendOptions 字段不可为 null');
  return Object.freeze({ skipPreflight, preflightCommitment: preflightCommitment as SolanaSendOptions['preflightCommitment'], maxRetries,
    ...(minContextSlot !== undefined ? { minContextSlot: minContextSlot as number } : {}) });
}
