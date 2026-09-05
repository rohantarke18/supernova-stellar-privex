import { useCallback, useEffect, useRef, useState } from 'react';
import { OrderForm }       from './components/OrderForm';
import { SealedBook }      from './components/SealedBook';
import { Chart }           from './components/Chart';
import { Positions }       from './components/Positions';
import { WalletButton }    from './components/WalletButton';
import { Rail }            from './components/Rail';
import { ErrorBoundary }   from './components/ErrorBoundary';
import { Markets }         from './screens/Markets';
import { Perp }            from './screens/Perp';
import { Portfolio }       from './screens/Portfolio';
import { Orders }          from './screens/Orders';
import { subscribeToPrice } from './goldrush';
import { readEncryptedBalance, ensurePermit } from './cofhe';
import { getClobBlockNumber, queryOrderMatchedEvents, readOrderRemaining, reconstructOrders } from './clob';
import { ADDRESSES } from './contract';
import { getSimulatedBalances, fillSimulatedOrder, cancelSimulatedOrder } from './tradingEngine';
import { useWallet } from './wallet';
import { useToast } from './toast';
import type { Fill, Order, OrderStatus, Screen } from './types';

function Ticker({ price, changePct24h }: { price?: number; changePct24h?: number }) {
  if (!price) return <span className="ticker--loading">loading…</span>;
  const up = (changePct24h ?? 0) >= 0;
  return (
    <div className="ticker">
      <span className="ticker__price">
        ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
      {changePct24h !== undefined && (
        <span className={`ticker__change ${up ? 'up' : 'down'}`}>
          {up ? '+' : ''}{changePct24h.toFixed(2)}%
        </span>
      )}
    </div>
  );
}

export default function App() {
  const wallet = useWallet();
  const toast  = useToast();

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [ordersMap, setOrdersMap]   = useState<Map<string, Order>>(() => new Map<string, Order>());
  const orders: Order[] = Array.from(ordersMap.values());
  const fills: Fill[] = []; // blind CLOB has no public plaintext fills (Chart marker overlay unused)

  const [deposits, setDeposits]       = useState<{ base: number; quote: number }>({ base: 0, quote: 0 });
  const [revealed, setRevealed]       = useState(false);
  const [balBusy, setBalBusy]         = useState(false);
  const [spotPrice, setSpotPrice]     = useState<number | undefined>(2845.50);
  const [changePct24h, setChangePct]  = useState<number | undefined>(2.38);
  const [screen, setScreen]           = useState<Screen>('trade');

  const ordersRef = useRef(ordersMap);  ordersRef.current = ordersMap;
  const permitRef = useRef<unknown>(null);
  const lastTick  = useRef(0);
  const matchCursorRef = useRef<number | null>(null);
  const optimisticNoticeRef = useRef<Set<string>>(new Set());
  const matchEventSeenRef = useRef<Set<string>>(new Set());

  // Orders persist in localStorage, scoped to contract + account, so they (and the
  // derived positions) survive page refreshes. A redeploy = new key = clean slate.
  const ordersKey = (account: string) =>
    `blindclob.orders.${ADDRESSES.blindClob}.${account.toLowerCase()}`;

  // ── Order state helpers ───────────────────────────────────────────────────────
  const addOrder = useCallback((o: Order) => {
    setOrdersMap((p) => new Map(p).set(o.hash, o));
  }, []);
  const updateOrder = useCallback((hash: string, patch: Partial<Order>) => {
    setOrdersMap((p) => {
      const cur = p.get(hash);
      if (!cur) return p;
      return new Map(p).set(hash, { ...cur, ...patch });
    });
  }, []);
  const updateOrderById = useCallback((orderId: number, patch: Partial<Order>) => {
    setOrdersMap((p) => {
      let changed = false;
      const next = new Map<string, Order>(p);
      for (const [hash, cur] of next) {
        if (cur.id !== orderId) continue;
        next.set(hash, { ...cur, ...patch });
        changed = true;
      }
      return changed ? next : p;
    });
  }, []);
  const pushOptimisticToast = useCallback((key: string, toastBody: Parameters<typeof toast.push>[0]) => {
    if (optimisticNoticeRef.current.has(key)) return;
    optimisticNoticeRef.current.add(key);
    toast.push(toastBody);
  }, [toast]);

  // ── Permit (one signature per session, reused for balances + fill reveals) ─────
  const getPermit = useCallback(async (): Promise<unknown | null> => {
    if (!walletAddress) return null;
    if (permitRef.current) return permitRef.current;
    const eip = await wallet.getEthereumProvider();
    const p = await ensurePermit(walletAddress, eip);
    permitRef.current = p;
    return p;
  }, [walletAddress, wallet]);

  // ── Balances (auto-revealed on connect, refreshable) ──────────────────────────
  const refreshBalances = useCallback(async () => {
    if (!walletAddress) return;
    setBalBusy(true);

    if (wallet.isSimulated) {
      const bal = getSimulatedBalances(walletAddress);
      setDeposits({ base: bal.base, quote: bal.quote });
      setRevealed(true);
      setBalBusy(false);
      return;
    }

    try {
      const p = await getPermit();
      if (!p) return;
      const [base, quote] = await Promise.all([
        readEncryptedBalance(ADDRESSES.encETH,  walletAddress, p),
        readEncryptedBalance(ADDRESSES.encUSDC, walletAddress, p),
      ]);
      setDeposits({ base, quote });
      setRevealed(true);
    } catch {
      /* user dismissed permit, or decrypt failed — leave hidden */
    } finally {
      setBalBusy(false);
    }
  }, [walletAddress, wallet.isSimulated, getPermit]);

  // On wallet change: reset balances/permit and restore persisted orders for this
  // account + contract (so a refresh keeps your open orders and positions).
  useEffect(() => {
    permitRef.current = null;
    matchCursorRef.current = null;
    optimisticNoticeRef.current.clear();
    matchEventSeenRef.current.clear();
    setDeposits({ base: 0, quote: 0 });
    setRevealed(false);
    if (walletAddress) {
      try {
        const raw = localStorage.getItem(ordersKey(walletAddress));
        const arr: Order[] = raw ? JSON.parse(raw) : [];
        setOrdersMap(new Map(arr.map((o) => [o.hash, o])));
      } catch { setOrdersMap(new Map()); }
      refreshBalances().catch(() => {});
    } else {
      setOrdersMap(new Map());
    }
  }, [walletAddress, refreshBalances]);

  // Persist orders whenever they change.
  useEffect(() => {
    if (!walletAddress) return;
    try { localStorage.setItem(ordersKey(walletAddress), JSON.stringify([...ordersMap.values()])); }
    catch { /* quota / disabled storage — non-fatal */ }
  }, [ordersMap, walletAddress]);

  // ── Simulated solver matching engine (runs in background for resting simulated orders)
  useEffect(() => {
    if (!wallet.isSimulated || !walletAddress) return;

    const resting = orders.filter((o) => o.status === 'resting');
    if (resting.length === 0) return;

    const timer = setTimeout(() => {
      const target = resting[0];
      updateOrder(target.hash, { status: 'matching' });

      const mid = toast.push({
        kind: 'pending',
        title: `Evaluating Order #${target.id}`,
        msg: 'Evaluating homomorphic crossing conditions against sealed book…',
      });

      setTimeout(() => {
        const { matchTx } = fillSimulatedOrder(walletAddress, target, target.qty);
        updateOrder(target.hash, {
          status: 'filled',
          filled: target.qty,
          matchTxs: [matchTx],
        });
        refreshBalances();
        toast.update(mid, {
          kind: 'success',
          title: `Order #${target.id} Filled`,
          msg: `${target.side === 'buy' ? 'Bought' : 'Sold'} ${target.qty} ETH @ $${target.price.toLocaleString()}`,
        });
      }, 1500);
    }, 4000);

    return () => clearTimeout(timer);
  }, [wallet.isSimulated, walletAddress, orders, updateOrder, refreshBalances, toast]);

  // Decrypt-check a single order's real remaining qty and reconcile status/toast.
  // This is the ONLY place that ever sets status to 'partial'/'filled' — every
  // other signal (solver SSE, OrderMatched log) is just a hint that a decrypt
  // check for this order is worth doing *now* instead of waiting for the next
  // 9s poll tick. matchOrder emits OrderMatched (and the solver emits its SSE
  // "matched" event) for every pair it evaluates against the resting book, even
  // ones that never actually crossed — so those signals must never be trusted
  // to mean "this order filled."
  const checkOrderFill = useCallback(async (o: Order, permit: unknown) => {
    if (!walletAddress) return;
    const rem = await readOrderRemaining(walletAddress, o.id, permit);
    if (rem === null) return; // coprocessor hasn't sealed the handle yet — retry later
    const filled = Math.max(0, o.qty - rem);
    const next: OrderStatus = rem <= 0 ? 'filled' : filled > 0 ? 'partial' : 'resting';
    const current = ordersRef.current.get(o.hash);
    if (!current || (next === current.status && filled === (current.filled ?? 0))) return;
    updateOrder(o.hash, { status: next, filled });
    if (next !== current.status && next === 'filled') {
      toast.push({ kind: 'success', title: `Order #${o.id} filled`,
        msg: `${o.side === 'buy' ? 'Bought' : 'Sold'} ${o.qty} ETH @ ${o.price.toLocaleString()}` });
      refreshBalances().catch(() => {});
    } else if (next !== current.status && next === 'partial') {
      toast.push({ kind: 'info', title: `Order #${o.id} partially filled`, msg: `${filled} / ${o.qty} ETH` });
      refreshBalances().catch(() => {});
    }
  }, [walletAddress, updateOrder, toast, refreshBalances]);

  // Solver push channel for demo-grade responsiveness. "matching"/"matched" are
  // just liveness signals (solver picked the order up / submitted the tx) — they
  // never imply a fill, since matchOrder runs unconditionally against every
  // resting counterparty. A "matched" event triggers an immediate decrypt check
  // instead of waiting up to 9s, so the UI still updates fast but only ever
  // shows the truth.
  useEffect(() => {
    if (!walletAddress) return;

    const es = new EventSource('/solver/events');
    es.onmessage = (msg) => {
      let ev: { type?: string; orderId?: string; tx?: string; error?: string };
      try { ev = JSON.parse(msg.data); } catch { return; }

      const orderId = Number(ev.orderId);
      if (!Number.isFinite(orderId)) return;

      const order = [...ordersRef.current.values()].find((o) => o.id === orderId);
      if (!order || order.status === 'cancelled' || order.status === 'filled') return;

      if (ev.type === 'matching') {
        if (order.status === 'matching') return;
        updateOrderById(orderId, { status: 'matching' });
        pushOptimisticToast(`matching:${orderId}`, {
          kind: 'info',
          title: `Order #${orderId} matching`,
          msg: 'Solver picked it up — checking for a cross…',
        });
      } else if (ev.type === 'matched') {
        const tx = ev.tx;
        if (tx) {
          const key = `${orderId}:${tx}`;
          if (matchEventSeenRef.current.has(key)) return;
          matchEventSeenRef.current.add(key);
          updateOrderById(orderId, { matchTxs: [...order.matchTxs, tx] });
        }
        getPermit().then((p) => { if (p) checkOrderFill(order, p); }).catch(() => {});
      } else if (ev.type === 'match_failed') {
        if (order.status === 'matching') updateOrderById(orderId, { status: 'resting' });
        pushOptimisticToast(`failed:${orderId}`, {
          kind: 'error',
          title: `Order #${orderId} match failed`,
          msg: ev.error?.slice(0, 90) ?? 'Solver could not submit matchOrder.',
        });
      }
    };

    es.onerror = () => {
      // Browser will auto-reconnect; the OrderMatched poll below covers missed events.
    };

    return () => es.close();
  }, [walletAddress, updateOrderById, pushOptimisticToast, getPermit, checkOrderFill]);

  // Fallback path for missed SSE messages: as soon as the chain exposes
  // OrderMatched for one of our orders, trigger an immediate decrypt check
  // (same caveat as above — OrderMatched fires per evaluated pair, not per fill).
  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;

    async function pollMatchedEvents() {
      const local = [...ordersRef.current.values()].filter((o) => o.id >= 0 && o.status !== 'cancelled' && o.status !== 'filled');
      if (!local.length) return;

      try {
        const head = await getClobBlockNumber();
        const from = matchCursorRef.current ?? Math.max(0, head - 5000);
        const events = await queryOrderMatchedEvents(from, head);
        if (cancelled) return;

        let nextCursor = head + 1;
        const permit = await getPermit().catch(() => null);
        for (const ev of events) {
          nextCursor = Math.max(nextCursor, ev.blockNumber + 1);
          for (const id of Array.from(new Set([ev.bidId, ev.askId]))) {
            const seenKey = `${id}:${ev.txHash}`;
            if (matchEventSeenRef.current.has(seenKey)) continue;
            matchEventSeenRef.current.add(seenKey);

            const order = [...ordersRef.current.values()].find((o) => o.id === id);
            if (!order || order.matchTxs.includes(ev.txHash)) continue;
            updateOrder(order.hash, { matchTxs: [...order.matchTxs, ev.txHash] });
            if (permit && !cancelled) checkOrderFill(order, permit);
          }
        }
        if (nextCursor != null) matchCursorRef.current = nextCursor;
      } catch (e) {
        console.warn('[CLOB] OrderMatched poll failed', e);
      }
    }

    pollMatchedEvents();
    const t = setInterval(pollMatchedEvents, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [walletAddress, updateOrder, getPermit, checkOrderFill]);

  // Rebuild orders from on-chain OrderPlaced events on connect — fully stateless
  // recovery (survives refresh, cleared storage, and device switches). Chain is
  // authoritative; merges over the localStorage cache for an instant first paint.
  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    (async () => {
      const p = await getPermit().catch(() => null);
      if (!p || cancelled) return;
      try {
        const chain = await reconstructOrders(walletAddress, p);
        if (cancelled || chain.length === 0) return;
        setOrdersMap((prev) => {
          const next = new Map<string, Order>(prev);
          for (const o of chain) {
            const local = next.get(o.hash);
            next.set(o.hash, local ? { ...local, ...o } : o);
          }
          return next;
        });
      } catch { /* keep cached view */ }
    })();
    return () => { cancelled = true; };
  }, [walletAddress, getPermit]);

  // ── Live fill-status polling (free decrypt — persistent ACL on remaining) ──────
  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    async function poll() {
      const p = await getPermit().catch(() => null);
      if (!p || cancelled) return;
      const active = [...ordersRef.current.values()].filter(
        (o) => o.id >= 0 && (o.status === 'resting' || o.status === 'matching' || o.status === 'partial' || o.status === 'pending'),
      );
      for (const o of active) {
        if (cancelled) return;
        await checkOrderFill(o, p);
      }
    }
    poll();
    const t = setInterval(poll, 9000);
    return () => { cancelled = true; clearInterval(t); };
  }, [walletAddress, getPermit, checkOrderFill]);

  // ── Price feed ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = subscribeToPrice((p) => {
      const now = Date.now();
      if (now - lastTick.current < 500) return;
      lastTick.current = now;
      setSpotPrice(p.price);
      setChangePct(p.changePct24h);
    });
    return unsub;
  }, []);
  const handleSpotPrice = useCallback((price: number) => setSpotPrice((prev) => prev ?? price), []);
  const handleAddressChange = useCallback((addr: string | null) => setWalletAddress(addr), []);

  const handleCancelOrder = useCallback((o: Order) => {
    if (!walletAddress) return;
    if (wallet.isSimulated) {
      cancelSimulatedOrder(walletAddress, o);
      updateOrder(o.hash, { status: 'cancelled' });
      refreshBalances();
      toast.push({
        kind: 'success',
        title: `Order #${o.id} cancelled`,
        msg: 'Collateral refunded to balance',
      });
    } else {
      setScreen('orders');
    }
  }, [walletAddress, wallet.isSimulated, updateOrder, refreshBalances, toast]);

  return (
    <ErrorBoundary>
      <div className="app">
        <header className="topbar">
          <div className="brand" onClick={() => setScreen('trade')} role="button" tabIndex={0}>
            <div className="brand__logo-icon">P</div>
            <span className="brand__name">Privex</span>
            <span className="brand__badge">FHE</span>
          </div>
          <div className="divider" />
          <div className="pair">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            ETH / USD
          </div>
          <Ticker price={spotPrice} changePct24h={changePct24h} />
          <div className="topbar__right">
            <div className="network-badge">Arbitrum Sepolia</div>
            <div className="fhe-badge" title="Orders encrypted via Fhenix CoFHE">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              Confidential · FHE
            </div>
            <WalletButton
              onAddressChange={handleAddressChange}
              deposits={revealed ? deposits : undefined}
              onRefreshBalances={refreshBalances}
            />
          </div>
        </header>

        <div className="shell">
          <Rail current={screen} onChange={setScreen} />

          {screen === 'trade' && (
            <div className="layout">
              <div className="trade-grid">
                <section className="panel panel--chart">
                  <Chart fills={fills} onSpotPrice={handleSpotPrice} />
                </section>

                <section className="panel panel--book">
                  <SealedBook spotPrice={spotPrice} />
                </section>

                <section className="panel panel--right">
                  <OrderForm
                    address={walletAddress ?? ''}
                    deposits={deposits}
                    revealed={revealed}
                    balBusy={balBusy}
                    spotPrice={spotPrice}
                    onRefreshBalances={refreshBalances}
                    onOrder={addOrder}
                  />
                </section>
              </div>

              <div className="positions-bar">
                <Positions
                  address={walletAddress ?? ''}
                  orders={orders}
                  spotPrice={spotPrice}
                  onManage={() => setScreen('orders')}
                  onCancelOrder={handleCancelOrder}
                />
              </div>
            </div>
          )}

          {screen === 'perp'      && <div className="screen-wrap"><Perp address={walletAddress ?? ''} /></div>}
          {screen === 'markets'   && <div className="screen-wrap"><Markets spotPrice={spotPrice} changePct24h={changePct24h} /></div>}
          {screen === 'portfolio' && <div className="screen-wrap"><Portfolio address={walletAddress ?? ''} currentPrice={spotPrice} deposits={deposits} revealed={revealed} orders={orders} onRefreshBalances={refreshBalances} /></div>}
          {screen === 'orders'    && <div className="screen-wrap"><Orders address={walletAddress ?? ''} orders={orders} onUpdate={updateOrder} /></div>}
        </div>
      </div>
    </ErrorBoundary>
  );
}
