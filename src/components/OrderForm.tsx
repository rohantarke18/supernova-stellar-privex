import { useState, type FormEvent } from 'react';
import { useWallet } from '../wallet';
import { useToast } from '../toast';
import { requestFaucet } from '../api';
import { placeLimitBid, placeLimitAsk } from '../clob';
import { ADDRESSES } from '../contract';
import { placeSimulatedOrder, faucetSimulatedBalances } from '../tradingEngine';
import type { Order } from '../types';

interface Props {
  address: string;
  deposits: { base: number; quote: number };
  revealed: boolean;
  balBusy: boolean;
  spotPrice?: number;
  onRefreshBalances: () => Promise<void> | void;
  onOrder: (o: Order) => void;
}

type Side = 'buy' | 'sell';

function NumberField({
  label, value, onChange, step, suffix, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  step: number; suffix: string; placeholder?: string;
}) {
  const num = Number(value) || 0;
  const bump = (d: number) => onChange(String(Math.max(0, +(num + d).toFixed(6))));
  return (
    <label className="nfield">
      <span className="nfield__label">{label}</span>
      <div className="nfield__box">
        <button type="button" className="nfield__step" onClick={() => bump(-step)} tabIndex={-1}>−</button>
        <input
          type="number" inputMode="decimal" min="0" step={step} value={value}
          placeholder={placeholder ?? '0'} onChange={(e) => onChange(e.target.value)}
        />
        <span className="nfield__suffix">{suffix}</span>
        <button type="button" className="nfield__step" onClick={() => bump(step)} tabIndex={-1}>+</button>
      </div>
    </label>
  );
}

export function OrderForm({ address, deposits, revealed, balBusy, spotPrice, onRefreshBalances, onOrder }: Props) {
  const wallet = useWallet();
  const toast  = useToast();

  const [side, setSide]       = useState<Side>('buy');
  const [price, setPrice]     = useState('');
  const [qty, setQty]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [status, setStatus]   = useState('');
  const [fauceting, setFaucet] = useState(false);

  const p = Number(price) || 0;
  const q = Number(qty) || 0;
  const total = p * q;

  // Max qty affordable from the revealed balance.
  const maxQty = side === 'buy'
    ? (p > 0 ? Math.floor(deposits.quote / p) : 0)
    : Math.floor(deposits.base);
  const haveEnough = side === 'buy' ? deposits.quote >= total : deposits.base >= q;
  const canSubmit = !!address && p > 0 && q > 0 && (!revealed || haveEnough);

  function setPct(pct: number) {
    if (maxQty <= 0) return;
    setQty(String(Math.max(1, Math.floor((maxQty * pct) / 100))));
  }

  async function handleFaucet() {
    if (!address) return;
    setFaucet(true);
    const id = toast.push({ kind: 'pending', title: 'Minting test tokens…' });

    if (wallet.isSimulated) {
      setTimeout(async () => {
        faucetSimulatedBalances(address);
        toast.update(id, { kind: 'success', title: 'Test tokens minted', msg: '+25 encETH + $50k encUSDC added' });
        await onRefreshBalances();
        setFaucet(false);
      }, 500);
      return;
    }

    try {
      const res = await requestFaucet(address);
      if (res.ok) {
        toast.update(id, { kind: 'success', title: 'Test tokens minted', msg: '100 encETH + 200k encUSDC' });
        await onRefreshBalances();
      } else {
        toast.update(id, { kind: 'error', title: 'Faucet failed', msg: res.error });
      }
    } catch {
      toast.update(id, { kind: 'error', title: 'Faucet failed', msg: 'network error' });
    } finally {
      setFaucet(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !wallet) return;
    setBusy(true);
    setStatus('Encrypting order parameters…');
    const tid = toast.push({ kind: 'pending', title: `Placing ${side} order`, msg: 'Encrypting order parameters…' });

    if (wallet.isSimulated) {
      try {
        await new Promise((r) => setTimeout(r, 450));
        setStatus('CoFHE ZK-proof generated…');
        toast.update(tid, { msg: 'CoFHE ZK-proof generated…' });

        await new Promise((r) => setTimeout(r, 500));
        setStatus('Routing ciphertext to Arbitrum Sepolia…');
        toast.update(tid, { msg: 'Routing ciphertext to Arbitrum Sepolia…' });

        await new Promise((r) => setTimeout(r, 400));
        const { order } = placeSimulatedOrder(address, side, p, q);

        onOrder(order);
        toast.update(tid, {
          kind: 'success',
          title: `Order #${order.id} placed`,
          msg: `${side === 'buy' ? 'Buy' : 'Sell'} ${q} ETH @ $${p.toLocaleString()} — matching against sealed book…`,
        });

        setPrice('');
        setQty('');
        setStatus('');
        await onRefreshBalances();
      } catch (err: any) {
        toast.update(tid, { kind: 'error', title: 'Order failed', msg: err?.message || 'Transaction rejected' });
        setStatus('');
      } finally {
        setBusy(false);
      }
      return;
    }

    // Web3 Real On-chain path
    try {
      const onStatus = (s: string) => { setStatus(s); toast.update(tid, { msg: s }); };
      const receipt = side === 'buy'
        ? await placeLimitBid(wallet, p, q, Math.round(total), ADDRESSES.encUSDC, onStatus)
        : await placeLimitAsk(wallet, p, q, q, ADDRESSES.encETH, onStatus);

      onOrder({
        id: receipt.orderId, hash: receipt.hash, side, price: p, qty: q,
        status: 'resting', placedAt: Date.now(), matchTxs: [],
      });
      toast.update(tid, {
        kind: 'success',
        title: receipt.orderId >= 0 ? `Order #${receipt.orderId} placed` : 'Order placed',
        msg: `${side === 'buy' ? 'Buy' : 'Sell'} ${q} ETH @ ${p.toLocaleString()} — matching…`,
      });
      setPrice(''); setQty(''); setStatus('');
      onRefreshBalances();
    } catch (err: any) {
      toast.update(tid, { kind: 'error', title: 'Order failed', msg: err?.shortMessage ?? err?.message?.slice(0, 90) ?? 'reverted' });
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="of" onSubmit={submit}>
      <div className="of__tabs">
        <button type="button" className={`of__tab of__tab--buy ${side === 'buy' ? 'is-active' : ''}`} onClick={() => setSide('buy')}>Buy</button>
        <button type="button" className={`of__tab of__tab--sell ${side === 'sell' ? 'is-active' : ''}`} onClick={() => setSide('sell')}>Sell</button>
      </div>

      <div className="of__types">
        <button type="button" className="of__type is-active" disabled>Limit</button>
        <button type="button" className="of__type" disabled title="Market orders need a visible price — coming soon">Market</button>
      </div>

      <NumberField label="Limit price" value={price} onChange={setPrice} step={10} suffix="USDC"
        placeholder={spotPrice ? String(Math.round(spotPrice)) : '0'} />
      <NumberField label="Amount" value={qty} onChange={setQty} step={1} suffix="ETH" />

      <div className="of__pcts">
        {[25, 50, 75, 100].map((pct) => (
          <button type="button" key={pct} className="of__pct" disabled={!revealed || maxQty <= 0}
            onClick={() => setPct(pct)}>{pct === 100 ? 'Max' : `${pct}%`}</button>
        ))}
      </div>

      <div className="of__summary">
        <div className="of__summary-row">
          <span>{side === 'buy' ? 'Total cost' : 'You receive (max)'}</span>
          <span className="of__summary-val">{total > 0 ? total.toLocaleString() : '—'} USDC</span>
        </div>
        <div className="of__summary-row of__summary-row--sub">
          <span>{side === 'buy' ? 'encUSDC balance' : 'encETH balance'}</span>
          <span>
            {revealed
              ? (side === 'buy' ? deposits.quote.toLocaleString() : deposits.base.toLocaleString())
              : '🔒 hidden'}
            {revealed && !haveEnough && p > 0 && q > 0 && <span className="of__insufficient"> · low</span>}
          </span>
        </div>
      </div>

      <button type="submit" className={`of__submit of__submit--${side}`} disabled={busy || !canSubmit}>
        {!address ? 'Connect trader'
          : busy ? (status || 'Encrypting…')
          : side === 'buy' ? `Buy ${q || ''} ETH`.trim() : `Sell ${q || ''} ETH`.trim()}
      </button>

      {address && (
        <div className="of__footer">
          <button type="button" className="of__ghost" onClick={handleFaucet} disabled={fauceting}>
            {fauceting ? 'Minting…' : '💧 Faucet (+Tokens)'}
          </button>
          <button type="button" className="of__ghost" onClick={() => onRefreshBalances()} disabled={balBusy}>
            {balBusy ? 'Revealing…' : revealed ? 'Refresh balances' : 'Reveal balances'}
          </button>
        </div>
      )}

      <div className="of__priv">🔒 Price &amp; size encrypted with CoFHE ZK-proofs · blind solver matching</div>
    </form>
  );
}
