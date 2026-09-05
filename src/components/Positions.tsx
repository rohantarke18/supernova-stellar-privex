import { useState } from 'react';
import type { Order } from '../types';

interface Props {
  address: string;
  orders:  Order[];
  spotPrice?: number;
  onManage: () => void;
  onCancelOrder?: (order: Order) => void;
}

type Tab = 'positions' | 'orders';

/**
 * Net spot position derived from filled/partial orders. Entry price uses the limit
 * price the trader entered (their plaintext) — a close approximation, since a bid
 * fills at or below its limit. This is the standard "net inventory" view.
 */
function computePosition(orders: Order[]) {
  let buyQty = 0, buyCost = 0, sellQty = 0, sellProceeds = 0;
  for (const o of orders) {
    if (o.status !== 'filled' && o.status !== 'partial') continue;
    const f = o.filled ?? o.qty;
    if (f <= 0) continue;
    if (o.side === 'buy') { buyQty += f; buyCost += f * o.price; }
    else                  { sellQty += f; sellProceeds += f * o.price; }
  }
  const netQty = buyQty - sellQty;
  const size = Math.abs(netQty);
  if (size === 0) return null;
  const isLong = netQty > 0;
  const avgEntry = isLong ? buyCost / buyQty : sellProceeds / sellQty;
  return { isLong, size, avgEntry, buyQty, sellQty };
}

export function Positions({ address, orders, spotPrice, onManage, onCancelOrder }: Props) {
  const [tab, setTab] = useState<Tab>('positions');

  const open = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'filled');
  const pos  = computePosition(orders);
  const uPnl = pos && spotPrice != null
    ? (pos.isLong ? spotPrice - pos.avgEntry : pos.avgEntry - spotPrice) * pos.size
    : null;
  const pnlUp = (uPnl ?? 0) >= 0;

  return (
    <div className="pos">
      <div className="pos__bar">
        <div className="pos__tabs">
          <button className={`pos__tab ${tab === 'positions' ? 'pos__tab--active' : ''}`} onClick={() => setTab('positions')}>
            Positions {pos && <span className="pos__badge">1</span>}
          </button>
          <button className={`pos__tab ${tab === 'orders' ? 'pos__tab--active' : ''}`} onClick={() => setTab('orders')}>
            Open Orders {open.length > 0 && <span className="pos__badge">{open.length}</span>}
          </button>
        </div>
        <div className="pos__right">
          <span className="positions__badge">🔒 FHE encrypted</span>
          {address && <button className="pos__manage" onClick={onManage}>Manage →</button>}
        </div>
      </div>

      {!address ? (
        <div className="pos__empty">Connect a wallet to trade.</div>
      ) : tab === 'positions' ? (
        !pos ? (
          <div className="pos__empty">No open position — fills net out flat. Place &amp; fill an order to open one.</div>
        ) : (
          <div className="pos__scroll">
            <div className="pos__cols pos__cols--pos">
              <span>Market</span><span>Side</span><span>Size</span><span>Avg entry</span><span>Mark</span><span>uPnL</span>
            </div>
            <div className="pos__row pos__row--pos">
              <span className="pos__num">ETH / USD</span>
              <span className={`pill pill--${pos.isLong ? 'buy' : 'sell'}`}>{pos.isLong ? 'LONG' : 'SHORT'}</span>
              <span className="pos__num">{pos.size} ETH</span>
              <span className="pos__num">{pos.avgEntry.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span className="pos__num">{spotPrice != null ? spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</span>
              <span className={uPnl == null ? 'pos__num' : pnlUp ? 'ptf-pnl--up' : 'ptf-pnl--down'}>
                {uPnl != null ? `${pnlUp ? '+' : ''}$${uPnl.toFixed(2)}` : '—'}
              </span>
            </div>
          </div>
        )
      ) : (
        open.length === 0 ? (
          <div className="pos__empty">No open orders — place a limit order to get started.</div>
        ) : (
          <div className="pos__scroll">
            <div className="pos__cols">
              <span>Side</span><span>Price</span><span>Amount</span><span>Filled</span><span>Status</span>
              {onCancelOrder && <span>Action</span>}
            </div>
            {open.slice().reverse().map((o) => {
              const f = o.filled ?? 0;
              const pct = o.qty > 0 ? Math.min(100, Math.round((f / o.qty) * 100)) : 0;
              return (
                <div className="pos__row" key={o.hash}>
                  <span className={`pill pill--${o.side}`}>{o.side === 'buy' ? 'BUY' : 'SELL'}</span>
                  <span className="pos__num">{o.price.toLocaleString()}</span>
                  <span className="pos__num">{o.qty}</span>
                  <div className="otbl__fill">
                    <div className="otbl__bar"><div className={`otbl__bar-fg otbl__bar-fg--${o.side}`} style={{ width: `${pct}%` }} /></div>
                    <span className="otbl__fill-txt">{f}/{o.qty}</span>
                  </div>
                  <span className={`status status--${o.status}`}>{o.status}</span>
                  {onCancelOrder && (
                    <button
                      type="button"
                      onClick={() => onCancelOrder(o)}
                      style={{
                        padding: '3px 8px',
                        fontSize: '0.72rem',
                        borderRadius: 4,
                        background: 'rgba(239, 68, 68, 0.15)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: '#f87171',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
