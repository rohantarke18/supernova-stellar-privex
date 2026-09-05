import type { Order, OrderStatus } from './types';

export interface SimulatedBalances {
  base: number;       // encETH
  quote: number;      // encUSDC
  collateral: number; // pUSD collateral in Perp
  pusd: number;       // pUSD unallocated
}

const BALANCES_PREFIX = 'privex.balances.';
const ORDERS_PREFIX = 'privex.orders.';
const PERP_PREFIX = 'privex.perp.';

export const DEFAULT_BALANCES: SimulatedBalances = {
  base: 45.0,
  quote: 150000,
  collateral: 10000,
  pusd: 90000,
};

export function getSimulatedBalances(address: string): SimulatedBalances {
  if (!address) return { ...DEFAULT_BALANCES };
  try {
    const raw = localStorage.getItem(BALANCES_PREFIX + address.toLowerCase());
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { ...DEFAULT_BALANCES };
}

export function saveSimulatedBalances(address: string, bal: SimulatedBalances): void {
  if (!address) return;
  try {
    localStorage.setItem(BALANCES_PREFIX + address.toLowerCase(), JSON.stringify(bal));
  } catch { /* ignore */ }
}

export function faucetSimulatedBalances(address: string): SimulatedBalances {
  const current = getSimulatedBalances(address);
  const updated: SimulatedBalances = {
    base: +(current.base + 25.0).toFixed(4),
    quote: Math.round(current.quote + 50000),
    collateral: current.collateral,
    pusd: Math.round(current.pusd + 50000),
  };
  saveSimulatedBalances(address, updated);
  return updated;
}

export function resetSimulatedBalances(address: string, initial?: Partial<SimulatedBalances>): SimulatedBalances {
  const next: SimulatedBalances = {
    ...DEFAULT_BALANCES,
    ...initial,
  };
  saveSimulatedBalances(address, next);
  return next;
}

export function randomHex(len: number): string {
  const chars = '0123456789abcdef';
  let s = '0x';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

export function nextOrderId(): number {
  return Math.floor(1000 + Math.random() * 9000);
}

/**
 * Executes a simulated spot order:
 * 1. Checks balance
 * 2. Locks collateral
 * 3. Returns Order object with realistic hash and ID
 */
export function placeSimulatedOrder(
  address: string,
  side: 'buy' | 'sell',
  price: number,
  qty: number,
): { order: Order; updatedBalances: SimulatedBalances } {
  const current = getSimulatedBalances(address);
  const totalCost = Math.round(price * qty);

  if (side === 'buy') {
    if (current.quote < totalCost) {
      throw new Error(`Insufficient encUSDC balance. Required: ${totalCost.toLocaleString()}, Available: ${current.quote.toLocaleString()}`);
    }
    current.quote = Math.max(0, current.quote - totalCost);
  } else {
    if (current.base < qty) {
      throw new Error(`Insufficient encETH balance. Required: ${qty} ETH, Available: ${current.base} ETH`);
    }
    current.base = +(current.base - qty).toFixed(4);
  }

  saveSimulatedBalances(address, current);

  const orderId = nextOrderId();
  const hash = randomHex(64);

  const order: Order = {
    id: orderId,
    hash,
    side,
    price,
    qty,
    status: 'resting',
    placedAt: Date.now(),
    matchTxs: [],
  };

  return { order, updatedBalances: current };
}

/**
 * Cancels a resting simulated order and refunds locked tokens.
 */
export function cancelSimulatedOrder(address: string, order: Order): SimulatedBalances {
  const current = getSimulatedBalances(address);
  const filled = order.filled ?? 0;
  const remaining = Math.max(0, order.qty - filled);

  if (remaining > 0) {
    if (order.side === 'buy') {
      const refund = Math.round(order.price * remaining);
      current.quote += refund;
    } else {
      current.base = +(current.base + remaining).toFixed(4);
    }
    saveSimulatedBalances(address, current);
  }

  return current;
}

/**
 * Fills a simulated order and credits the counter-token to the user.
 */
export function fillSimulatedOrder(address: string, order: Order, fillQty: number): { updatedBalances: SimulatedBalances; matchTx: string } {
  const current = getSimulatedBalances(address);
  const matchTx = randomHex(64);

  if (order.side === 'buy') {
    // User bought ETH
    current.base = +(current.base + fillQty).toFixed(4);
  } else {
    // User sold ETH for USDC
    const proceed = Math.round(order.price * fillQty);
    current.quote += proceed;
  }

  saveSimulatedBalances(address, current);
  return { updatedBalances: current, matchTx };
}

// ── Perp Simulation ──────────────────────────────────────────────────────────

export interface SimulatedPerpPosition {
  isLong: boolean;
  size: number;
  avgEntry: number;
  leverage: number;
  collateralLocked: number;
  liquidationPrice: number;
  openedAt: number;
}

export function getSimulatedPerpPosition(address: string): SimulatedPerpPosition | null {
  if (!address) return null;
  try {
    const raw = localStorage.getItem(PERP_PREFIX + address.toLowerCase());
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

export function saveSimulatedPerpPosition(address: string, pos: SimulatedPerpPosition | null): void {
  if (!address) return;
  try {
    if (pos) {
      localStorage.setItem(PERP_PREFIX + address.toLowerCase(), JSON.stringify(pos));
    } else {
      localStorage.removeItem(PERP_PREFIX + address.toLowerCase());
    }
  } catch { /* ignore */ }
}
