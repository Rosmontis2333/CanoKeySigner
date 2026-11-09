import * as AbiFunction from 'ox/AbiFunction';

export const tokenFrom = '0x1111111111111111111111111111111111111111';
export const tokenTo = '0x2222222222222222222222222222222222222222';
export const tokenOperator = '0x3333333333333333333333333333333333333333';
export const tokenContract = '0x4444444444444444444444444444444444444444';

/** Independent ABI encoder used only by development tests. */
export function encodeTokenCall(signature: string, args: readonly unknown[]): `0x${string}` {
  const method = AbiFunction.from(`function ${signature}` as never);
  return AbiFunction.encodeData(method, args as never);
}

export const tokenCallVectors = [
  { signature: 'transfer(address,uint256)', selector: 'a9059cbb', args: [tokenTo, 17n] },
  { signature: 'approve(address,uint256)', selector: '095ea7b3', args: [tokenOperator, (1n << 256n) - 1n] },
  { signature: 'transferFrom(address,address,uint256)', selector: '23b872dd', args: [tokenFrom, tokenTo, 19n] },
  { signature: 'safeTransferFrom(address,address,uint256)', selector: '42842e0e', args: [tokenFrom, tokenTo, 20n] },
  { signature: 'safeTransferFrom(address,address,uint256,bytes)', selector: 'b88d4fde', args: [tokenFrom, tokenTo, 21n, '0xabcd'] },
  { signature: 'setApprovalForAll(address,bool)', selector: 'a22cb465', args: [tokenOperator, true] },
  { signature: 'safeTransferFrom(address,address,uint256,uint256,bytes)', selector: 'f242432a', args: [tokenFrom, tokenTo, 22n, 23n, '0x010203'] },
  { signature: 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', selector: '2eb2c2d6', args: [tokenFrom, tokenTo, [24n, 25n], [26n, 27n], '0x0405'] },
] as const;

export function tokenTransactionInput(data: string) {
  return { type: '2', chainId: '31337', nonce: '7', gasLimit: '1000000',
    to: tokenContract, value: '0', data, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', accessList: [] };
}
