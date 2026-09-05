import { Contract, JsonRpcProvider } from 'ethers';
import { FheTypes } from '@cofhe/sdk';
import { getSigner, CHAIN_ID, ADDRESSES } from './contract';
import { encryptOrder, connectCofheClient, cofheClient } from './cofhe';
import type { EncInput } from './cofhe';
import type { WalletContextValue } from './wallet';
import type { Order, OrderStatus } from './types';

// ── Debug logging ─────────────────────────────────────────────────────────────
// All CLOB-flow logs use the [CLOB] prefix so they're easy to filter in console.
const t0  = () => new Date().toISOString().slice(11, 23);
const log  = (...a: unknown[]) => console.log(`%c[CLOB ${t0()}]`, 'color:#7b6ef6', ...a);
const warn = (...a: unknown[]) => console.warn(`[CLOB ${t0()}]`, ...a);
const err  = (...a: unknown[]) => console.error(`[CLOB ${t0()}]`, ...a);

const ARB_SEPOLIA_RPC = 'https://sepolia-rollup.arbitrum.io/rpc';
const MAX_U64 = (1n << 64n) - 1n;   // approve once, reuse across orders

/** The CLOB is always live — there is no batch window to gate on. */
export const ClobState = { ACTIVE: 'active' } as const;

export interface OrderReceipt {
  hash:    string;
  orderId: number;
}

export const BLIND_CLOB_ADDRESS: string = ADDRESSES.blindClob;

// ── ABI ───────────────────────────────────────────────────────────────────────
// InEuint64 is encoded as a tuple: (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
const IN_EUINT64 = 'tuple(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)';
const CLOB_ABI = [
  `function placeBid(${IN_EUINT64} encPrice, ${IN_EUINT64} encQty, uint64 depositAmount) external returns (uint256)`,
  `function placeAsk(${IN_EUINT64} encPrice, ${IN_EUINT64} encQty, uint64 depositAmount) external returns (uint256)`,
  'function cancelOrder(uint256 orderId) external',
  'function viewOrderRemaining(uint256 orderId) external returns (uint256)',
  'function orders(uint256) view returns (address trader, uint256 price, uint256 qty, uint256 remaining, bool isBid, bool exists, bool cancelled)',
  'function restingBidCount() external view returns (uint256)',
  'function restingAskCount() external view returns (uint256)',
  'event OrderPlaced(uint256 indexed orderId, address indexed trader, bool isBid)',
  'event OrderMatched(uint256 indexed bidId, uint256 indexed askId)',
];

const ERC20_ABI = [
  'function approve(address spender, uint64 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint64)',
];

// ── Gas + retry helpers (mirrors blindbatch.ts) ─────────────────────────────────

function gasBump() {
  // Arbitrum Sepolia base fee is ~0.02 Gwei but wallet providers return a tight
  // legacy gasPrice with no EIP-1559 buffer, causing "maxFee < baseFee" errors.
  // Hard-floor at 0.1 Gwei — still < $0.001 per tx on Arbitrum.
  return {
    maxFeePerGas:         100_000_000n,
    maxPriorityFeePerGas:   2_000_000n,
  };
}

/**
 * Send a tx, retrying when the wallet's self-estimated fee lands just under a
 * rising base fee. `send` must build + submit the tx so it re-signs each retry.
 */
async function withFeeRetry<T>(label: string, send: () => Promise<T>, tries = 8): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      log(`${label}: send attempt ${i + 1}/${tries}`);
      const r = await send();
      log(`${label}: ✓ confirmed`);
      return r;
    } catch (e: any) {
      let blob = '';
      try { blob = JSON.stringify(e); } catch { /* circular */ }
      const msg = [
        e?.error?.message, e?.info?.error?.message, e?.cause?.message,
        e?.shortMessage, e?.message, blob,
      ].filter(Boolean).join(' ').toLowerCase();
      const retriable =
        msg.includes('less than block base fee') ||
        msg.includes('max fee per gas') ||
        msg.includes('transaction underpriced') ||
        msg.includes('fee too low') ||
        msg.includes('replacement transaction underpriced');
      warn(`${label}: attempt ${i + 1} failed — retriable=${retriable} —`,
           e?.shortMessage || e?.info?.error?.message || e?.message);
      if (!retriable || i === tries - 1) { err(`${label}: giving up`, e); throw e; }
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

function inEuint64({ ctHash, securityZone, utype, signature }: EncInput) {
  return [ctHash, securityZone, utype, signature] as const;
}

/** Parse the OrderPlaced event from a placement receipt to recover the orderId. */
function orderIdFromReceipt(clob: Contract, receipt: any): number {
  for (const lgEntry of receipt?.logs ?? []) {
    try {
      const parsed = clob.interface.parseLog(lgEntry);
      if (parsed?.name === 'OrderPlaced') return Number(parsed.args.orderId);
    } catch { /* not our event */ }
  }
  // Fallback: orderId unknown (event not found) — caller treats -1 as "pending id".
  return -1;
}

// ── Placement ───────────────────────────────────────────────────────────────────

/**
 * Place an encrypted limit buy order. Locks `depositAmount` of quoteToken (USDC).
 * Approves the token once (MAX_U64) so subsequent orders skip the approve tx.
 */
export async function placeLimitBid(
  wallet: WalletContextValue,
  price: number,
  qty: number,
  depositAmount: number,
  quoteTokenAddress: string,
  onStatus?: (s: string) => void,
): Promise<OrderReceipt> {
  if (!BLIND_CLOB_ADDRESS) throw new Error('VITE_BLIND_CLOB_ADDRESS not set');
  const eip1193 = await wallet.getEthereumProvider();
  const signer  = await getSigner(wallet);
  const address = await signer.getAddress();
  const bump    = gasBump();

  onStatus?.('Connecting to CoFHE…');
  await connectCofheClient(address, eip1193);

  onStatus?.('Encrypting order… (this takes ~20s the first time)');
  const quoteToken = new Contract(quoteTokenAddress, ERC20_ABI, signer);
  const [[encPrice, encQty], curAllow] = await Promise.all([
    encryptOrder(price, qty, address, CHAIN_ID),
    quoteToken.allowance(address, BLIND_CLOB_ADDRESS) as Promise<bigint>,
  ]);

  if (curAllow < BigInt(depositAmount)) {
    onStatus?.('Approving token…');
    await withFeeRetry('approve(encUSDC)', async () => {
      const t = await quoteToken.approve(BLIND_CLOB_ADDRESS, MAX_U64, bump);
      return t.wait();
    });
  }

  onStatus?.('Submitting encrypted bid…');
  const clob = new Contract(BLIND_CLOB_ADDRESS, CLOB_ABI, signer);
  const tx: any = await withFeeRetry('placeBid', () =>
    clob.placeBid(inEuint64(encPrice), inEuint64(encQty), BigInt(depositAmount), bump),
  );
  const receipt = await tx.wait();
  const orderId = orderIdFromReceipt(clob, receipt);
  log('placeLimitBid DONE ✓ tx', tx.hash, 'orderId', orderId);
  return { hash: tx.hash as string, orderId };
}

/**
 * Place an encrypted limit sell order. Locks `depositAmount` of baseToken (ETH).
 */
export async function placeLimitAsk(
  wallet: WalletContextValue,
  price: number,
  qty: number,
  depositAmount: number,
  baseTokenAddress: string,
  onStatus?: (s: string) => void,
): Promise<OrderReceipt> {
  if (!BLIND_CLOB_ADDRESS) throw new Error('VITE_BLIND_CLOB_ADDRESS not set');
  const eip1193 = await wallet.getEthereumProvider();
  const signer  = await getSigner(wallet);
  const address = await signer.getAddress();
  const bump    = gasBump();

  onStatus?.('Connecting to CoFHE…');
  await connectCofheClient(address, eip1193);

  onStatus?.('Encrypting order… (this takes ~20s the first time)');
  const baseToken = new Contract(baseTokenAddress, ERC20_ABI, signer);
  const [[encPrice, encQty], curAllow] = await Promise.all([
    encryptOrder(price, qty, address, CHAIN_ID),
    baseToken.allowance(address, BLIND_CLOB_ADDRESS) as Promise<bigint>,
  ]);

  if (curAllow < BigInt(depositAmount)) {
    onStatus?.('Approving token…');
    await withFeeRetry('approve(encETH)', async () => {
      const t = await baseToken.approve(BLIND_CLOB_ADDRESS, MAX_U64, bump);
      return t.wait();
    });
  }

  onStatus?.('Submitting encrypted ask…');
  const clob = new Contract(BLIND_CLOB_ADDRESS, CLOB_ABI, signer);
  const tx: any = await withFeeRetry('placeAsk', () =>
    clob.placeAsk(inEuint64(encPrice), inEuint64(encQty), BigInt(depositAmount), bump),
  );
  const receipt = await tx.wait();
  const orderId = orderIdFromReceipt(clob, receipt);
  log('placeLimitAsk DONE ✓ tx', tx.hash, 'orderId', orderId);
  return { hash: tx.hash as string, orderId };
}

// ── Cancellation ─────────────────────────────────────────────────────────────────

/** Cancel a resting order; refunds remaining collateral on-chain. Returns the tx hash. */
export async function cancelOrder(
  wallet: WalletContextValue,
  orderId: number,
): Promise<string> {
  if (!BLIND_CLOB_ADDRESS) throw new Error('VITE_BLIND_CLOB_ADDRESS not set');
  const signer = await getSigner(wallet);
  const bump   = gasBump();
  const clob   = new Contract(BLIND_CLOB_ADDRESS, CLOB_ABI, signer);
  const tx: any = await withFeeRetry('cancelOrder', () => clob.cancelOrder(BigInt(orderId), bump));
  await tx.wait();
  log('cancelOrder DONE ✓ tx', tx.hash, 'order', orderId);
  return tx.hash as string;
}

/** Read an order's plaintext-visible fields (trader/side/exists/cancelled — never price/qty). */
export async function fetchOrderFlags(
  orderId: number,
): Promise<{ exists: boolean; cancelled: boolean; remainingHandle: bigint } | null> {
  if (!BLIND_CLOB_ADDRESS) return null;
  const ro = new Contract(BLIND_CLOB_ADDRESS, CLOB_ABI, new JsonRpcProvider(ARB_SEPOLIA_RPC));
  const o = await ro.orders(BigInt(orderId));
  return { exists: o.exists as boolean, cancelled: o.cancelled as boolean, remainingHandle: o.remaining as bigint };
}

// ── Reads ──────────────────────────────────────────────────────────────────────

/** Read resting-book depth (counts only, no prices) from a pinned RPC. */
export async function getBookDepth(
  provider: JsonRpcProvider,
  clobAddress: string,
): Promise<{ restingBids: number; restingAsks: number }> {
  if (!clobAddress) return { restingBids: 0, restingAsks: 0 };
  const clob = new Contract(clobAddress, CLOB_ABI, provider);
  const [bids, asks] = await Promise.all([
    clob.restingBidCount() as Promise<bigint>,
    clob.restingAskCount() as Promise<bigint>,
  ]);
  return { restingBids: Number(bids), restingAsks: Number(asks) };
}

/**
 * Read an order's remaining (unfilled) quantity — FREE, no transaction.
 * The contract grants the trader persistent decrypt access to their own `remaining`
 * at placement and after every match, so the client just reads the handle from a
 * pinned RPC and decrypts it. `permit` is the object returned by ensurePermit().
 *
 * Returns the decrypted remaining, or `null` if the handle isn't decryptable yet
 * (coprocessor still resolving a fresh post-match handle) so callers can retry.
 */
export async function readOrderRemaining(
  account: string,
  orderId: number,
  permit: unknown,
): Promise<number | null> {
  if (!BLIND_CLOB_ADDRESS) throw new Error('VITE_BLIND_CLOB_ADDRESS not set');
  const ro = new Contract(BLIND_CLOB_ADDRESS, CLOB_ABI, new JsonRpcProvider(ARB_SEPOLIA_RPC));
  const order = await ro.orders(BigInt(orderId));
  const handle: bigint = order.remaining;
  if (!handle || handle === 0n) return 0;
  return decryptHandle(handle, account, permit);
}

export interface MatchedOrderEvent {
  bidId: number;
  askId: number;
  txHash: string;
  blockNumber: number;
}

export async function queryOrderMatchedEvents(
  fromBlock: number,
  toBlock: number | 'latest',
): Promise<MatchedOrderEvent[]> {
  if (!BLIND_CLOB_ADDRESS) return [];
  const provider = new JsonRpcProvider(ARB_SEPOLIA_RPC);
  const clob = new Contract(BLIND_CLOB_ADDRESS, CLOB_ABI, provider);
  const events = await clob.queryFilter(clob.filters.OrderMatched(), fromBlock, toBlock);
  return events.map((e: any) => ({
    bidId: Number(e.args.bidId),
    askId: Number(e.args.askId),
    txHash: e.transactionHash as string,
    blockNumber: e.blockNumber,
  }));
}

export async function getClobBlockNumber(): Promise<number> {
  return new JsonRpcProvider(ARB_SEPOLIA_RPC).getBlockNumber();
}

/** Decrypt a euint64 handle for view. Returns 0 for the zero handle, null if the
 *  coprocessor hasn't sealed it yet (caller can retry). */
async function decryptHandle(handle: bigint, account: string, permit: unknown): Promise<number | null> {
  if (!handle || handle === 0n) return 0;
  try {
    const value = await cofheClient
      .decryptForView(handle, FheTypes.Uint64)
      .setChainId(CHAIN_ID)
      .setAccount(account)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .withPermit(permit as any)
      .set404RetryTimeout(8_000)
      .execute();
    return Number(value);
  } catch (e) {
    warn('decryptHandle pending', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Rebuild the caller's full order list from on-chain OrderPlaced events — no local
 * state needed. The contract grants owners decrypt access to their own price + qty +
 * remaining, so every order (and its live fill status) is reconstructable on any
 * device. `permit` is the object from ensurePermit().
 */
export async function reconstructOrders(account: string, permit: unknown): Promise<Order[]> {
  if (!BLIND_CLOB_ADDRESS) return [];
  const provider = new JsonRpcProvider(ARB_SEPOLIA_RPC);
  const clob = new Contract(BLIND_CLOB_ADDRESS, CLOB_ABI, provider);
  const latest = await provider.getBlockNumber();

  // Scan OrderPlaced (indexed by trader) in chunks to respect public-RPC getLogs limits.
  const CHUNK = 9_000, MAX_BACK = 90_000;
  const filter = clob.filters.OrderPlaced(null, account);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = [];
  for (let end = latest; end > Math.max(0, latest - MAX_BACK); end -= CHUNK + 1) {
    const start = Math.max(0, end - CHUNK);
    try { events.push(...await clob.queryFilter(filter, start, end)); }
    catch (e) { warn('reconstruct chunk failed', start, end, e instanceof Error ? e.message : e); }
    if (start === 0) break;
  }

  // Resolve block timestamps for placedAt.
  const tsMap = new Map<number, number>();
  await Promise.all([...new Set(events.map((e) => e.blockNumber))].map(async (b) => {
    try { const blk = await provider.getBlock(b); if (blk) tsMap.set(b, Number(blk.timestamp) * 1000); } catch { /* ignore */ }
  }));

  const out: Order[] = [];
  for (const e of events) {
    const orderId = Number(e.args.orderId);
    const isBid   = Boolean(e.args.isBid);
    let o;
    try { o = await clob.orders(BigInt(orderId)); } catch { continue; }
    if (!o.exists) continue;
    const [price, qty, remaining] = await Promise.all([
      decryptHandle(o.price, account, permit),
      decryptHandle(o.qty, account, permit),
      decryptHandle(o.remaining, account, permit),
    ]);
    if (!price || !qty) continue; // price/qty not decryptable yet — skip this pass
    const rem = remaining == null ? qty : remaining;
    const status: OrderStatus = o.cancelled ? 'cancelled'
      : rem <= 0 ? 'filled' : rem < qty ? 'partial' : 'resting';
    out.push({
      id: orderId, hash: e.transactionHash as string, side: isBid ? 'buy' : 'sell',
      price, qty, status, placedAt: tsMap.get(e.blockNumber) ?? Date.now(),
      matchTxs: [], filled: Math.max(0, qty - rem),
    });
  }
  out.sort((a, b) => a.id - b.id);
  log('reconstructed', out.length, 'orders from chain');
  return out;
}
