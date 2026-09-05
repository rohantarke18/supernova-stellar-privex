import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web';
import { Encryptable, FheTypes } from '@cofhe/sdk';
import { ValidationUtils } from '@cofhe/sdk/permits';
import { arbSepolia } from '@cofhe/sdk/chains';
import { createPublicClient, createWalletClient, http, custom } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { JsonRpcProvider, Contract } from 'ethers';

const ARB_SEPOLIA_RPC = 'https://sepolia-rollup.arbitrum.io/rpc';
const CHAIN_ID = 421614;

export type { EncryptedUint64Input } from '@cofhe/sdk';

export type EncInput = { ctHash: bigint; securityZone: number; utype: number; signature: string };

const _config = createCofheConfig({
  supportedChains: [arbSepolia],
  useWorkers: false,
});

export const cofheClient = createCofheClient(_config);

// Track which account the CoFHE client is currently connected to so we can
// reconnect when the user switches wallets (cofheClient.connected stays true
// across account switches, which would otherwise serve a stale connection).
let _connectedAccount: string | null = null;

// Connect the CoFHE client to the user's wallet via viem clients.
// Must be called before encryptInputs. Reconnects if the account changed.
export async function connectCofheClient(account: string, eip1193Provider: unknown) {
  if (cofheClient.connected && _connectedAccount === account.toLowerCase()) return;
  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http('https://sepolia-rollup.arbitrum.io/rpc'),
  });
  const walletClient = createWalletClient({
    account:   account as `0x${string}`,
    chain:     arbitrumSepolia,
    transport: custom(eip1193Provider as Parameters<typeof custom>[0]),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await cofheClient.connect(publicClient as any, walletClient as any);
  _connectedAccount = account.toLowerCase();
}

/**
 * Pre-warm: connect the CoFHE client AND ensure a self-permit exists so that
 * subsequent balance reveals and fill decryptions never prompt mid-flow.
 * Call this once right after wallet connect — it's fire-and-forget safe.
 */
export async function warmupCofhe(account: string, eip1193Provider: unknown): Promise<void> {
  try {
    await ensurePermit(account, eip1193Provider);
  } catch {
    // Warmup is best-effort — if the user dismisses the permit sign, ordering
    // still works; they'll just be prompted when they first reveal balances.
  }
}

// MockFHERC20.balanceOf returns an euint64 ciphertext handle (ABI: uint256).
const BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

/**
 * Ensure a valid self-permit exists for the given account.
 * Removes any expired/invalid permit first so getOrCreateSelfPermit is
 * forced to issue a fresh one. Call this ONCE before parallel decrypts.
 */
/**
 * Ensure a fresh valid permit exists. Returns the permit object so callers
 * can pass it directly to .withPermit(permit) — avoids casing-mismatch bugs
 * in the SDK's active-permit lookup.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensurePermit(
  account: string,
  eip1193Provider: unknown,
  chainId = CHAIN_ID,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  await connectCofheClient(account, eip1193Provider);
  const existing = cofheClient.permits.getActivePermit();
  if (existing && !ValidationUtils.isValid(existing).valid) {
    cofheClient.permits.removeActivePermit();
  }
  return cofheClient.permits.getOrCreateSelfPermit(chainId, account as `0x${string}`);
}

/**
 * Read a confidential token balance and decrypt it.
 * Pass the permit returned by ensurePermit() to avoid SDK active-permit lookup issues.
 */
export async function readEncryptedBalance(
  tokenAddress: string,
  account: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  permit: any,
  chainId = CHAIN_ID,
  onStatus?: (msg: string) => void,
): Promise<number> {
  const lg = (...a: unknown[]) => console.log('%c[BB balance]', 'color:#22c55e', ...a);

  // Read handle from a pinned RPC — don't trust the wallet's provider for view calls.
  const provider = new JsonRpcProvider(ARB_SEPOLIA_RPC);
  const token = new Contract(tokenAddress, BALANCE_ABI, provider);
  const ctHash: bigint = await token.balanceOf(account);
  if (!ctHash || ctHash === 0n) return 0;

  onStatus?.('Decrypting…');
  const value = await cofheClient
    .decryptForView(ctHash, FheTypes.Uint64)
    .setChainId(chainId)
    .setAccount(account)
    .withPermit(permit)
    .set404RetryTimeout(30_000)
    .onPoll(({ attemptIndex }) => {
      if (attemptIndex > 0) onStatus?.(`Decrypting… (attempt ${attemptIndex + 1})`);
    })
    .execute();

  lg('decrypted', tokenAddress.slice(0, 10), '→', String(value));
  return Number(value);
}

/**
 * Encrypt a price+qty pair in a single encryptInputs call.
 * One batch = one ZK proof = one wallet signature instead of two.
 */
export async function encryptOrder(
  price: number,
  qty: number,
  account: string,
  chainId = CHAIN_ID,
): Promise<[EncInput, EncInput]> {
  const [encPrice, encQty] = await cofheClient
    .encryptInputs([Encryptable.uint64(BigInt(price)), Encryptable.uint64(BigInt(qty))])
    .setAccount(account as `0x${string}`)
    .setChainId(chainId)
    .execute();

  const toEncInput = (e: typeof encPrice): EncInput => ({
    ctHash:       e.ctHash,
    securityZone: e.securityZone,
    utype:        Number(e.utype),
    signature:    e.signature,
  });

  return [toEncInput(encPrice), toEncInput(encQty)];
}

// Kept for any callers that only need a single value encrypted.
export async function encryptPrice(
  value: number,
  account: string,
  chainId = CHAIN_ID,
): Promise<EncInput> {
  const [enc] = await cofheClient
    .encryptInputs([Encryptable.uint64(BigInt(value))])
    .setAccount(account as `0x${string}`)
    .setChainId(chainId)
    .execute();

  return {
    ctHash:       enc.ctHash,
    securityZone: enc.securityZone,
    utype:        Number(enc.utype),
    signature:    enc.signature,
  };
}
