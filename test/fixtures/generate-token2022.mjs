// Regenerate with the official @solana/spl-token 0.4.15 package in an isolated directory.
// Pass the absolute file URL of its lib/esm/index.js as the first argument.
// The package is deliberately kept outside this application's dependency tree.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const sdkUrl = import.meta.resolve(process.argv[2] ?? '@solana/spl-token');
const sdkPackage = JSON.parse(await readFile(new URL('../../package.json', sdkUrl), 'utf8'));
if (sdkPackage.version !== '0.4.15') throw new Error('Reference vectors require @solana/spl-token 0.4.15');
const sdk = await import(sdkUrl);
// Use the SDK's peer dependency so PublicKey instanceof checks use one class.
const { Keypair } = await import(pathToFileURL(createRequire(sdkUrl).resolve('@solana/web3.js')).href);
const signer = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const other = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
const destination = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
const mint = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey;
const source = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;
const multisig = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
const program = sdk.TOKEN_2022_PROGRAM_ID;
const vectors = [];
function add(name, instruction, operation, multi = false, signable = true) {
  vectors.push({ name, program: instruction.programId.toBase58(), dataHex: instruction.data.toString('hex'),
    accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({ address: pubkey.toBase58(), isSigner, isWritable })),
    operation, multi, signable });
}

add('transferUnchecked', sdk.createTransferInstruction(source, destination, signer, 123n, [], program), 'Token-2022 转移', false, false);
add('transferChecked', sdk.createTransferCheckedInstruction(source, mint, destination, signer, 123n, 6, [], program), 'Token-2022 转移', false, false);
add('approve', sdk.createApproveInstruction(source, destination, signer, 18446744073709551615n, [], program), 'Token-2022 delegate 授权');
add('approveChecked', sdk.createApproveCheckedInstruction(source, mint, destination, signer, 123n, 6, [], program), 'Token-2022 delegate 授权');
add('revoke', sdk.createRevokeInstruction(source, signer, [], program), '撤销 Token-2022 delegate 授权');
add('mintTo', sdk.createMintToInstruction(mint, destination, signer, 123n, [], program), '增发 Token-2022');
add('mintToChecked', sdk.createMintToCheckedInstruction(mint, destination, signer, 123n, 6, [], program), '增发 Token-2022');
add('burn', sdk.createBurnInstruction(source, mint, signer, 123n, [], program), '销毁 Token-2022');
add('burnChecked', sdk.createBurnCheckedInstruction(source, mint, signer, 123n, 6, [], program), '销毁 Token-2022');
add('closeAccount', sdk.createCloseAccountInstruction(source, destination, signer, [], program), '关闭 Token 账户或 Mint 并转移全部 SOL');
add('freeze', sdk.createFreezeAccountInstruction(source, mint, signer, [], program), '冻结 Token-2022 账户');
add('thaw', sdk.createThawAccountInstruction(source, mint, signer, [], program), '解冻 Token-2022 账户');
add('syncNative', sdk.createSyncNativeInstruction(source, program), '同步 Wrapped SOL 余额');
add('immutableOwner', sdk.createInitializeImmutableOwnerInstruction(source, program), '初始化 Immutable Owner');
for (let type = 0; type <= 17; type++) {
  add(`authority${type}`, sdk.createSetAuthorityInstruction(source, signer, type, destination, [], program), '修改 Token-2022 authority');
}
add('authorityNone', sdk.createSetAuthorityInstruction(mint, signer, 4, null, [], program), '修改 Token-2022 authority');
for (const config of [null, signer]) for (const withdraw of [null, other]) {
  add(`initializeFee${Number(!!config)}${Number(!!withdraw)}`, sdk.createInitializeTransferFeeConfigInstruction(mint, config, withdraw, 100, 1000000n, program), '初始化 Token-2022 Transfer Fee Config');
}
add('setFee', sdk.createSetTransferFeeInstruction(mint, signer, [], 10000, 18446744073709551615n, program), '修改 Token-2022 Transfer Fee');
add('transferWithFee', sdk.createTransferCheckedWithFeeInstruction(source, mint, destination, signer, 123456789n, 6, 12345n, [], program), 'Token-2022 转移并核对预期手续费');
add('transferWithFeeZero', sdk.createTransferCheckedWithFeeInstruction(source, mint, destination, signer, 0n, 0, 0n, [], program), 'Token-2022 转移并核对预期手续费');
add('transferWithFeeMax', sdk.createTransferCheckedWithFeeInstruction(source, mint, destination, signer, 18446744073709551615n, 255, 18446744073709551615n, [], program), 'Token-2022 转移并核对预期手续费');
add('transferWithFeeSelf', sdk.createTransferCheckedWithFeeInstruction(source, mint, source, signer, 100n, 6, 1n, [], program), 'Token-2022 转移并核对预期手续费');
add('transferWithFeeMultisig', sdk.createTransferCheckedWithFeeInstruction(source, mint, destination, multisig, 123n, 6, 1n, [signer, other], program), 'Token-2022 转移并核对预期手续费', true);
add('withdrawMint', sdk.createWithdrawWithheldTokensFromMintInstruction(mint, destination, signer, [], program), '从 Mint 提取全部预扣手续费');
add('withdrawAccounts', sdk.createWithdrawWithheldTokensFromAccountsInstruction(mint, destination, signer, [], [source, multisig], program), '从 Token 账户提取全部预扣手续费');
add('withdrawAccountsMultisig', sdk.createWithdrawWithheldTokensFromAccountsInstruction(mint, destination, multisig, [signer, other], [source], program), '从 Token 账户提取全部预扣手续费', true);
add('withdrawAccountsEmpty', sdk.createWithdrawWithheldTokensFromAccountsInstruction(mint, destination, signer, [], [], program), '从 Token 账户提取全部预扣手续费');
add('harvest', sdk.createHarvestWithheldTokensToMintInstruction(mint, [source, destination], program), '将账户预扣手续费归集至 Mint');
add('harvestEmpty', sdk.createHarvestWithheldTokensToMintInstruction(mint, [], program), '将账户预扣手续费归集至 Mint');
add('enableMemo', sdk.createEnableRequiredMemoTransfersInstruction(source, signer, [], program), '启用转入 Memo 要求');
add('disableMemo', sdk.createDisableRequiredMemoTransfersInstruction(source, signer, [], program), '禁用转入 Memo 要求');
add('enableCpiGuard', sdk.createEnableCpiGuardInstruction(source, signer, [], program), '启用 CPI Guard');
add('disableCpiGuard', sdk.createDisableCpiGuardInstruction(source, multisig, [signer, other], program), '禁用 CPI Guard', true);
const ata = sdk.getAssociatedTokenAddressSync(mint, signer, false, program);
add('createAta', sdk.createAssociatedTokenAccountInstruction(signer, ata, signer, mint, program), '创建 Associated Token Account');
add('createAtaIdempotent', sdk.createAssociatedTokenAccountIdempotentInstruction(signer, ata, signer, mint, program), '幂等创建 Associated Token Account');

await writeFile(new URL('./token2022-vectors.json', import.meta.url), JSON.stringify({
  sdk: '@solana/spl-token@0.4.15',
  integrity: 'sha512-3Lof3mNov8NVQ3PalIWb1Jgr/TZ6lYM+/sexv2TLqdhNFVth2OfWmH3d7QucgMjSbokkjNiNlRr6I8Fd269uaw==',
  vectors,
}, null, 2) + '\n');
