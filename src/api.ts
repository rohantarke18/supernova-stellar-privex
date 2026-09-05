// The solver is a blind matcher: it never sees order prices. The only endpoints
// it exposes are the faucet, public book/batch status, the GoldRush key, and
// health. All order data flows encrypted directly to the BlindCLOB contract
// (see clob.ts), never through here.

const BASE = '/solver';

export interface BatchStatus {
  configured: boolean;
  state?: number;
  deadline?: number;
  bidCount?: number;
  askCount?: number;
  error?: string;
}

export async function fetchBatch(): Promise<BatchStatus> {
  try {
    const r = await fetch(`${BASE}/batch`);
    return r.json();
  } catch {
    return { configured: false };
  }
}

export async function fetchHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function requestFaucet(address: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${BASE}/faucet/${address}`);
    return r.json();
  } catch {
    return { ok: false, error: 'network error' };
  }
}
