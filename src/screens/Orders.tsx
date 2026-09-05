import { useState } from 'react';
import { useWallet } from '../wallet';
import { useToast } from '../toast';
import { cancelOrder, fetchOrderFlags } from '../clob';
import { cancelSimulatedOrder } from '../tradingEngine';
import type { Order, OrderStatus } from '../types';

interface Props {
  address: string;
  orders: Order[];
  onUpdate: (hash: string, patch: Partial<Order>) => void;
}

const EXPLORER = 'https://sepolia.arbiscan.io/tx/';

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'pending',
  resting: 'resting',
  matching: 'matching',
  partial: 'partial',
  filled: 'filled',
  cancelled: 'cancelled',
};

export function Orders({ address, orders, onUpdate }: Props) {
  const wallet = useWallet();
  const toast  = useToast();
  const [busyHash, setBusyHash] = useState<string | null>(null);

  const open = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'filled');
  const done = orders.filter((o) => o.status === 'cancelled' || o.status === 'filled');

  async function handleCancel(o: Order) {
    if (!wallet || o.id < 0) return;
    setBusyHash(o.hash);
    const id = toast.push({ kind: 'pending', title: `Cancelling order #${o.id}`, msg: 'Refunding remaining collateral…' });

    if (wallet.isSimulated) {
      setTimeout(() => {
        cancelSimulatedOrder(address, o);
        onUpdate(o.hash, { status: 'cancelled' });
        toast.update(id, { kind: 'success', title: `Order #${o.id} cancelled`, msg: 'Collateral refunded to balance' });
        setBusyHash(null);
      }, 400);
      return;
    }

    try {
      await cancelOrder(wallet, o.id);
      onUpdate(o.hash, { status: 'cancelled' });
      toast.update(id, { kind: 'success', title: `Order #${o.id} cancelled`, msg: 'Collateral refunded' });
    } catch (e: any) {
      // matchOrder/cancelOrder revert data for OrderNotActive() — the order was
      // already cancelled (e.g. an earlier click's tx landed after this one was
      // queued) or fully filled since the UI last synced. Reconcile with chain
      // truth instead of showing a scary "failed" error for something that
      // already succeeded.
      const flags = await fetchOrderFlags(o.id).catch(() => null);
      if (flags?.cancelled) {
        onUpdate(o.hash, { status: 'cancelled' });
        toast.update(id, { kind: 'success', title: `Order #${o.id} already cancelled`, msg: 'Collateral was already refunded.' });
      } else if (flags && flags.remainingHandle === 0n) {
        onUpdate(o.hash, { status: 'filled' });
        toast.update(id, { kind: 'info', title: `Order #${o.id} already filled`, msg: 'Nothing left to cancel.' });
      } else {
        toast.update(id, { kind: 'error', title: 'Cancel failed', msg: e?.shortMessage ?? e?.message?.slice(0, 80) });
      }
    } finally {
      setBusyHash(null);
    }
  }

  function Row({ o }: { o: Order; key?: string }) {
    const filled = o.filled ?? 0;
    const pct = o.qty > 0 ? Math.min(100, Math.round((filled / o.qty) * 100)) : 0;
    const canCancel = (o.status === 'resting' || o.status === 'partial') && o.id >= 0;
    return (
      <div className="otbl__row">
        <span className={`pill pill--${o.side}`}>{o.side === 'buy' ? 'BUY' : 'SELL'}</span>
        <span className="otbl__num">{o.price.toLocaleString()}</span>
        <span className="otbl__num">{o.qty}</span>
        <div className="otbl__fill">
          <div className="otbl__bar"><div className={`otbl__bar-fg otbl__bar-fg--${o.side}`} style={{ width: `${pct}%` }} /></div>
          <span className="otbl__fill-txt">{filled}/{o.qty}</span>
        </div>
        <span className={`status status--${o.status}`}>{STATUS_LABEL[o.status]}</span>
        <span className="otbl__age">
          {ago(o.placedAt)}
          {' · '}
          <a href={`${EXPLORER}${o.hash}`} target="_blank" rel="noreferrer" className="otbl__lnk">tx↗</a>
        </span>
        <span className="otbl__act">
          {canCancel ? (
            <button className="btn-cancel" disabled={busyHash === o.hash} onClick={() => handleCancel(o)}>
              {busyHash === o.hash ? '…' : 'Cancel'}
            </button>
          ) : <span className="otbl__dash">—</span>}
        </span>
      </div>
    );
  }

  return (
    <div className="screen-page">
      <div className="screen-page__header">
        <h1 className="screen-page__title">Orders</h1>
        <span className="screen-page__sub">
          {address
            ? 'Live limit orders — fills decrypt automatically; only you can see your prices'
            : 'Connect wallet to view orders'}
        </span>
      </div>

      {address && (
        <>
          <div className="screen-page__section-header">
            Open <span className="screen-section__badge">{open.length}</span>
            <span className="otbl__live">● live</span>
          </div>
          {open.length === 0 ? (
            <div className="screen-page__empty">No open orders. Place a limit order on the Trade screen.</div>
          ) : (
            <div className="otbl">
              <div className="otbl__head">
                <span>Side</span><span>Price</span><span>Amount</span><span>Filled</span>
                <span>Status</span><span>Age</span><span></span>
              </div>
              {open.slice().reverse().map((o) => <Row key={o.hash} o={o} />)}
            </div>
          )}

          {done.length > 0 && (
            <>
              <div className="screen-page__section-header" style={{ marginTop: 24 }}>History</div>
              <div className="otbl">
                <div className="otbl__head">
                  <span>Side</span><span>Price</span><span>Amount</span><span>Filled</span>
                  <span>Status</span><span>Age</span><span></span>
                </div>
                {done.slice().reverse().map((o) => <Row key={o.hash} o={o} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
