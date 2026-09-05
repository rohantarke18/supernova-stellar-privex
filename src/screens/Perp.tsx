import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useWallet } from '../wallet';
import { useToast } from '../toast';
import { ensurePermit } from '../cofhe';
import { Chart } from '../components/Chart';
import { EncryptionProgressOverlay } from '../components/EncryptionProgressOverlay';
import { StressTesterCard } from '../components/StressTesterCard';
import {
  depositCollateral, withdrawCollateral, placePerpOrder, closePerpPosition,
  reconstructPerpPosition, getMark, getFunding, getCollateral, getPusdBalance,
  getLastFill, getOpenInterest, perpFaucet, type PerpPosition,
} from '../perp';
import {
  getSimulatedBalances, saveSimulatedBalances,
  getSimulatedPerpPosition, saveSimulatedPerpPosition,
  faucetSimulatedBalances,
} from '../tradingEngine';
import type { Fill } from '../types';

const MMR = 0.10;

interface Props { address: string; }

export function Perp({ address }: Props) {
  const wallet = useWallet();
  const toast  = useToast();

  const [mark, setMark]         = useState<number>();
  const [funding, setFunding]   = useState<{ index: number; rate: number }>();
  const [collateral, setColl]   = useState(0);
  const [pusd, setPusd]         = useState(0);
  const [pos, setPos]           = useState<PerpPosition | null>(null);
  const [perpLast, setPerpLast] = useState(0);
  const [oi, setOi]             = useState(0);
  const [revealed, setRevealed] = useState(false);
  const noFills: Fill[] = [];

  const [side, setSide]   = useState<'long' | 'short'>('long');
  const [price, setPrice] = useState('');
  const [size, setSize]   = useState('');
  const [lev, setLev]     = useState(2);
  const [depAmt, setDep]  = useState('');
  const [busy, setBusy]   = useState(false);
  const [status, setStatus] = useState('');

  const permitRef = useRef<unknown>(null);
  const getPermit = useCallback(async () => {
    if (!address) return null;
    if (permitRef.current) return permitRef.current;
    const eip = await wallet.getEthereumProvider();
    permitRef.current = await ensurePermit(address, eip);
    return permitRef.current;
  }, [address, wallet]);

  // Public reads (mark + funding) every 5s.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [m, f] = await Promise.all([getMark(), getFunding()]);
        if (!cancelled) { setMark(m); setFunding(f); if (!price) setPrice(String(m)); }
      } catch { /* */ }
    }
    poll();
    const t = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mark price is driven on-chain by the keeper (real Pyth feed) — the frontend only reads it.

  const refresh = useCallback(async () => {
    if (!address) return;
    if (wallet.isSimulated) {
      const bal = getSimulatedBalances(address);
      setColl(bal.collateral);
      setPusd(bal.pusd);
      const savedPos = getSimulatedPerpPosition(address);
      if (savedPos) {
        setPos({
          isLong: savedPos.isLong,
          size: savedPos.size,
          entry: savedPos.avgEntry,
        });
      } else {
        setPos(null);
      }
      setRevealed(true);
      return;
    }

    try {
      const permit = await getPermit();
      if (!permit) return;
      const [c, b, p, lf, o] = await Promise.all([
        getCollateral(address, permit),
        getPusdBalance(address, permit),
        reconstructPerpPosition(address, permit),
        getLastFill(address, permit),
        getOpenInterest(address, permit),
      ]);
      setColl(c); setPusd(b); setPos(p); setPerpLast(lf); setOi(o); setRevealed(true);
    } catch { /* */ }
  }, [address, wallet.isSimulated, getPermit]);

  // Reset + auto-reveal on wallet change; poll position every 9s.
  useEffect(() => {
    permitRef.current = null; setRevealed(false); setColl(0); setPusd(0); setPos(null);
    if (!address) return;
    refresh();
    const t = setInterval(refresh, 9000);
    return () => clearInterval(t);
  }, [address, refresh]);

  const p = Number(price) || 0;
  const s = Number(size) || 0;
  const notional = p * s;
  const liqEst = (() => {
    if (!p || !s || collateral <= 0) return null;
    const signed = side === 'long' ? s : -s;
    const denom = signed - Math.abs(signed) * MMR;
    const liq = denom !== 0 ? (signed * p - collateral) / denom : 0;
    return liq > 0 ? liq : null;
  })();
  const curLev = collateral > 0 ? notional / collateral : 0;

  function applyLeverage(l: number) {
    setLev(l);
    if (p > 0 && collateral > 0) setSize(String(Math.max(1, Math.floor((collateral * l) / p))));
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  async function handleFaucet() {
    const id = toast.push({ kind: 'pending', title: 'Minting pUSD collateral…' });
    if (wallet.isSimulated) {
      faucetSimulatedBalances(address);
      toast.update(id, { kind: 'success', title: 'Got 50k pUSD test collateral' });
      refresh();
      return;
    }
    const res = await perpFaucet(address);
    if (res.ok) { toast.update(id, { kind: 'success', title: 'Got 100k pUSD' }); refresh(); }
    else toast.update(id, { kind: 'error', title: 'Faucet failed', msg: res.error });
  }

  async function handleDeposit() {
    const amt = Number(depAmt);
    if (!amt || !wallet) return;
    const id = toast.push({ kind: 'pending', title: `Depositing ${amt} pUSD` });
    await run('deposit', async () => {
      if (wallet.isSimulated) {
        const bal = getSimulatedBalances(address);
        if (bal.pusd < amt) {
          toast.update(id, { kind: 'error', title: 'Deposit failed', msg: 'Insufficient unallocated pUSD' });
          return;
        }
        bal.pusd -= amt;
        bal.collateral += amt;
        saveSimulatedBalances(address, bal);
        toast.update(id, { kind: 'success', title: `${amt} pUSD Collateral deposited` });
        setDep('');
        refresh();
        return;
      }
      try { await depositCollateral(wallet, Math.round(amt)); toast.update(id, { kind: 'success', title: 'Collateral deposited' }); setDep(''); await refresh(); }
      catch (e: any) { toast.update(id, { kind: 'error', title: 'Deposit failed', msg: e?.shortMessage ?? e?.message?.slice(0, 80) }); }
    });
  }

  async function handleWithdraw() {
    if (!wallet || collateral <= 0) return;
    const id = toast.push({ kind: 'pending', title: 'Withdrawing collateral' });
    await run('withdraw', async () => {
      if (wallet.isSimulated) {
        const bal = getSimulatedBalances(address);
        const wAmt = Math.floor(collateral);
        bal.collateral = 0;
        bal.pusd += wAmt;
        saveSimulatedBalances(address, bal);
        toast.update(id, { kind: 'success', title: `Withdrawn ${wAmt} pUSD` });
        refresh();
        return;
      }
      try { await withdrawCollateral(wallet, Math.floor(collateral)); toast.update(id, { kind: 'success', title: 'Withdrawn' }); await refresh(); }
      catch (e: any) { toast.update(id, { kind: 'error', title: 'Withdraw failed', msg: e?.shortMessage ?? e?.message?.slice(0, 80) }); }
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!wallet || !p || !s) return;
    const id = toast.push({ kind: 'pending', title: `Opening ${side} ${s} @ ${p}`, msg: 'Encrypting…' });
    await run('place', async () => {
      if (wallet.isSimulated) {
        setStatus('Generating CoFHE ciphertext proof…');
        await new Promise((r) => setTimeout(r, 450));
        setStatus('Evaluating homomorphic margin health…');
        await new Promise((r) => setTimeout(r, 400));

        saveSimulatedPerpPosition(address, {
          isLong: side === 'long',
          size: s,
          avgEntry: p,
          leverage: lev,
          collateralLocked: Math.round(notional / lev),
          liquidationPrice: liqEst ?? Math.round(p * 0.8),
          openedAt: Date.now(),
        });

        toast.update(id, {
          kind: 'success',
          title: `${side === 'long' ? 'Long' : 'Short'} position established`,
          msg: `${s} ETH @ $${p.toLocaleString()} · Encrypted size & leverage active`,
        });
        setSize('');
        setStatus('');
        refresh();
        return;
      }

      try {
        await placePerpOrder(wallet, side === 'long', p, s, (st) => { setStatus(st); toast.update(id, { msg: st }); });
        toast.update(id, { kind: 'success', title: `${side === 'long' ? 'Long' : 'Short'} submitted`, msg: `${s} @ ${p} — opening against protocol liquidity` });
        setSize(''); setStatus('');
        setTimeout(refresh, 4000);
      } catch (err: any) {
        toast.update(id, { kind: 'error', title: 'Order failed', msg: err?.shortMessage ?? err?.message?.slice(0, 90) });
        setStatus('');
      }
    });
  }

  async function handleClose() {
    if (!wallet) return;
    const id = toast.push({ kind: 'pending', title: 'Closing position' });
    await run('close', async () => {
      if (wallet.isSimulated) {
        if (pos && mark) {
          const pnl = Math.round((mark - pos.entry) * pos.size * (pos.isLong ? 1 : -1));
          const bal = getSimulatedBalances(address);
          bal.collateral = Math.max(0, bal.collateral + pnl);
          saveSimulatedBalances(address, bal);
        }
        saveSimulatedPerpPosition(address, null);
        toast.update(id, { kind: 'success', title: 'Position closed', msg: 'PnL settled into collateral' });
        refresh();
        return;
      }

      try { await closePerpPosition(wallet); toast.update(id, { kind: 'success', title: 'Position closed' }); await refresh(); }
      catch (e: any) { toast.update(id, { kind: 'error', title: 'Close failed', msg: e?.shortMessage ?? e?.message?.slice(0, 80) }); }
    });
  }

  const protectionRows = [
    ['Limit Price', 'Visible before execution', 'Encrypted', 'Prevents front-running.'],
    ['Order Size', 'Visible', 'Encrypted', 'Prevents toxic flow analysis.'],
    ['Position Size', 'Inferable after execution', 'Encrypted', 'Protects directional exposure.'],
    ['Entry Price', 'Visible', 'Encrypted', 'Protects trading strategy.'],
    ['Liquidation Threshold', 'Targetable', 'Encrypted', 'Prevents liquidation hunting.'],
    ['Margin Health', 'Can often be reconstructed', 'Evaluated homomorphically', 'Only the liquidation verdict is revealed.'],
  ];

  return (
    <div className="screen-page perp">
      <div className="screen-page__header">
        <h1 className="screen-page__title">ETH-PERP <span className="perp-tag">private</span></h1>
        <span className="screen-page__sub">Encrypted protocol-liquidity perpetual · size, entry &amp; leverage hidden on-chain</span>
      </div>

      <div className="perp-stats">
        <div className="perp-stat"><span>Index (Pyth)</span><b>{mark != null ? `$${mark.toLocaleString()}` : '—'}</b></div>
        <div className="perp-stat"><span>Perp last</span><b>{perpLast > 0 ? `$${perpLast.toLocaleString()}` : '—'}</b></div>
        <div className="perp-stat"><span>Premium</span><b className={perpLast > 0 && mark != null ? (perpLast - mark >= 0 ? 'ptf-pnl--up' : 'ptf-pnl--down') : ''}>
          {perpLast > 0 && mark != null ? `${perpLast - mark >= 0 ? '+' : ''}${perpLast - mark}` : '—'}</b></div>
        <div className="perp-stat"><span>Funding rate</span><b className={(funding?.rate ?? 0) >= 0 ? 'ptf-pnl--up' : 'ptf-pnl--down'}>{funding ? (funding.rate >= 0 ? '+' : '') + funding.rate : '—'}</b></div>
        <div className="perp-stat"><span>Open interest</span><b>{revealed ? `${oi} ETH` : '🔒'}</b></div>
      </div>

      {!address ? (
        <div className="screen-page__empty">Connect a wallet to trade the perp.</div>
      ) : (
        <div className="perp-workspace">
          <section className="perp-left">
            <div className="perp-chart-panel">
              <div className="perp-chart-panel__head">
                <div>
                  <h2>ETH-PERP <span className="perp-tag">private</span></h2>
                  <p>Encrypted protocol-liquidity perpetual · size, entry &amp; leverage hidden on-chain</p>
                </div>
              </div>
              <div className="perp-chart"><Chart fills={noFills} /></div>
            </div>

            <div className="perp-cofhe-callout">
              <div className="perp-cofhe-callout__icon">▣</div>
              <div>
                <b>Selective CoFHE Perps</b>
                <p>
                Order size, entry, leverage, and liquidation thresholds stay encrypted onchain. Mark price and funding remain public for market coordination.
                </p>
              </div>
            </div>

            <div className="perp-trade-grid">
              <form className="of perp-form" onSubmit={handleSubmit}>
                <EncryptionProgressOverlay busy={busy} status={status} />
                <div className="of__tabs">
                  <button type="button" className={`of__tab of__tab--buy ${side === 'long' ? 'is-active' : ''}`} onClick={() => setSide('long')}>Long</button>
                  <button type="button" className={`of__tab of__tab--sell ${side === 'short' ? 'is-active' : ''}`} onClick={() => setSide('short')}>Short</button>
                </div>

                <label className="nfield"><span className="nfield__label">Limit price</span>
                  <div className="nfield__box">
                    <input type="number" value={price} placeholder={mark ? String(mark) : '0'} onChange={(e) => setPrice(e.target.value)} />
                    <span className="nfield__suffix">pUSD</span>
                  </div>
                </label>

                <label className="nfield"><span className="nfield__label">Size</span>
                  <div className="nfield__box">
                    <input type="number" value={size} placeholder="0" onChange={(e) => setSize(e.target.value)} />
                    <span className="nfield__suffix">ETH</span>
                  </div>
                </label>

                <div className="perp-lev">
                  <div className="perp-lev__row"><span>Leverage</span><b>{lev}×</b></div>
                  <input type="range" min={1} max={20} step={1} value={lev} onChange={(e) => applyLeverage(Number(e.target.value))} />
                  <div className="perp-lev__ticks"><span>1×</span><span>5×</span><span>10×</span><span>20×</span></div>
                </div>

                <div className="of__summary">
                  <div className="of__summary-row"><span>Notional</span><span className="of__summary-val">{notional ? notional.toLocaleString() : '—'} pUSD</span></div>
                  <div className="of__summary-row of__summary-row--sub"><span>Est. Liq. Price</span><span>{liqEst ? `$${liqEst.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}</span></div>
                  <div className="of__summary-row of__summary-row--sub"><span>Resulting Leverage</span><span>{curLev ? `${curLev.toFixed(1)}×` : '—'}</span></div>
                </div>

                <button type="submit" className={`of__submit of__submit--${side === 'long' ? 'buy' : 'sell'}`} disabled={busy || !p || !s || collateral <= 0}>
                  {busy ? (status || 'Working…') : collateral <= 0 ? 'Deposit collateral first' : `${side === 'long' ? 'Long' : 'Short'} ${s || ''} ETH`.trim()}
                </button>
              </form>

              <div className="perp-side">
                <div className="perp-card">
                  <div className="perp-card__head">Collateral
                    <button className="of__ghost" type="button" onClick={handleFaucet}>Faucet</button>
                  </div>
                  <div className="perp-card__big">{revealed ? `${collateral.toLocaleString()} pUSD` : '🔒'}</div>
                  <div className="perp-card__sub">Wallet: {revealed ? `${pusd.toLocaleString()} pUSD` : '🔒'}</div>
                  <div className="perp-deposit">
                    <input type="number" placeholder="amount" value={depAmt} onChange={(e) => setDep(e.target.value)} />
                    <button className="of__ghost" type="button" onClick={handleDeposit} disabled={busy || !Number(depAmt)}>Deposit</button>
                    <button className="of__ghost" type="button" onClick={handleWithdraw} disabled={busy || collateral <= 0}>Withdraw</button>
                  </div>
                </div>

                <div className="perp-card">
                  <div className="perp-card__head">
                    <span>Position</span>
                    <span className="perp-private-state">Private State</span>
                  </div>
                  {!pos ? (
                    <div className="perp-card__empty">
                      <b>No active private position</b>
                      <span>Deposit collateral and place a long or short to view encrypted position state and liquidation protection.</span>
                    </div>
                  ) : (
                    <div className="perp-pos">
                      <div className="perp-pos__top">
                        <span className={`pill pill--${pos.isLong ? 'buy' : 'sell'}`}>{pos.isLong ? 'LONG' : 'SHORT'}</span>
                        <span className="perp-pos__size">{pos.size} ETH</span>
                        <span className="perp-pos__lev">{pos.leverage.toFixed(1)}×</span>
                      </div>
                      <div className="perp-pos__rows">
                        <div><span>Entry</span><b>${pos.entry.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
                        <div><span>Mark</span><b>${pos.mark.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
                        <div><span>Liq. price</span><b className="ptf-pnl--down">{pos.liqPrice ? `$${pos.liqPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</b></div>
                        <div><span>Collateral</span><b>{pos.collateral.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pUSD</b></div>
                        <div><span>uPnL</span><b className={pos.uPnl >= 0 ? 'ptf-pnl--up' : 'ptf-pnl--down'}>{pos.uPnl >= 0 ? '+' : ''}{pos.uPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pUSD</b></div>
                        <div><span>ROE</span><b className={pos.uPnl >= 0 ? 'ptf-pnl--up' : 'ptf-pnl--down'}>{pos.collateral > 0 ? `${pos.uPnl >= 0 ? '+' : ''}${((pos.uPnl / pos.collateral) * 100).toFixed(1)}%` : '—'}</b></div>
                      </div>

                      {(() => {
                        const dist = pos.liqPrice ? (Math.abs(pos.mark - pos.liqPrice) / pos.mark) * 100 : null;
                        if (dist == null) return null;
                        const cls = dist < 5 ? 'sell' : dist < 15 ? 'warn' : 'buy';
                        return (
                          <div className="perp-health">
                            <div className="perp-health__label"><span>Liq. distance</span><b className={`perp-health--${cls}`}>{dist.toFixed(1)}%</b></div>
                            <div className="perp-health__bar"><div className={`perp-health__fg perp-health__fg--${cls}`} style={{ width: `${Math.min(100, dist * 4)}%` }} /></div>
                          </div>
                        );
                      })()}

                      <button className="of__submit of__submit--sell perp-close" onClick={handleClose} disabled={busy}>Close position</button>
                    </div>
                  )}
                </div>

                <div className="perp-card perp-mini-protection">
                  <div className="perp-card__head">Trader State Protection</div>
                  <p>BlindPerp selectively uses CoFHE only for trader-specific state that creates MEV, liquidation hunting, and strategy leakage.</p>
                </div>
              </div>
            </div>
          </section>

          <aside className="perp-right">
            <div className="perp-card perp-protection">
              <div className="perp-card__head">
                <span>Trader State Protection</span>
                {pos && <span className="pill pill--buy">Protected live position</span>}
              </div>
              <p className="perp-protection__intro">
                BlindPerp selectively uses CoFHE only for trader-specific state.
              </p>
              <div className="perp-protection__table">
                <div className="perp-protection__head">
                  <span>Field</span><span>Public Perpetual Exchange</span><span>BlindPerp</span><span>Why it matters</span>
                </div>
                {protectionRows.map(([field, publicState, blindState, why]) => (
                  <div className="perp-protection__row" key={field}>
                    <b>{field}</b>
                    <span>{publicState}</span>
                    <strong>{blindState}</strong>
                    <span>{why}</span>
                  </div>
                ))}
              </div>
              <div className="perp-protection__note">
                <b>Selective CoFHE</b>
                <span>BlindPerp encrypts trader-specific state that creates MEV and liquidation risk, while keeping market-wide reference data public for efficiency.</span>
              </div>
            </div>

            <StressTesterCard pos={pos} mark={mark} refresh={refresh} />
          </aside>
        </div>
      )}
    </div>
  );
}
