import { useEffect, useState } from 'react';
import { getBookDepth } from '../clob';
import { ADDRESSES } from '../contract';

interface Props {
  spotPrice?: number;
}

const MAX_ROWS = 7;
// Deterministic, decreasing depth-bar widths so the sealed book reads like a real
// ladder without revealing anything (there is no real depth to show — it's encrypted).
const widthFor = (i: number, n: number) => 90 - (i / Math.max(1, n)) * 64;

export function SealedBook({ spotPrice }: Props) {
  const [book, setBook] = useState<{ restingBids: number; restingAsks: number } | null>({
    restingBids: 8,
    restingAsks: 6,
  });

  useEffect(() => {
    if (!ADDRESSES.blindClob) return;
    let cancelled = false;
    async function poll() {
      try {
        const { JsonRpcProvider } = await import('ethers');
        const provider = new JsonRpcProvider('https://sepolia-rollup.arbitrum.io/rpc');
        const d = await getBookDepth(provider, ADDRESSES.blindClob);
        if (!cancelled) setBook(d);
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const asks = book?.restingAsks ?? 0;
  const bids = book?.restingBids ?? 0;
  const askRows = Math.min(asks, MAX_ROWS);
  const bidRows = Math.min(bids, MAX_ROWS);

  return (
    <div className="ob">
      <div className="ob-header">
        <span>Sealed Book</span>
        <span className="ob-header__private">🔒 encrypted</span>
      </div>

      <div className="ob-asks">
        {askRows === 0 ? (
          <div className="ob-side-empty">no asks resting</div>
        ) : (
          Array.from({ length: askRows }).map((_, i) => (
            <div className="ob-row ob-row--ask" key={`a${i}`}>
              <span className="ob-bar" style={{ width: `${widthFor(askRows - 1 - i, askRows)}%` }} />
              <span className="ob-price">••••••</span>
              <span className="ob-qty--hidden">sealed</span>
            </div>
          ))
        )}
        {asks > MAX_ROWS && <div className="ob-more">+{asks - MAX_ROWS} more asks</div>}
      </div>

      <div className="ob-mid">
        <div className="ob-mid__price">
          {spotPrice ? `$${spotPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
        </div>
        <div className="ob-mid__spread">ref · Base mainnet</div>
      </div>

      <div className="ob-bids">
        {bidRows === 0 ? (
          <div className="ob-side-empty">no bids resting</div>
        ) : (
          Array.from({ length: bidRows }).map((_, i) => (
            <div className="ob-row ob-row--bid" key={`b${i}`}>
              <span className="ob-bar" style={{ width: `${widthFor(i, bidRows)}%` }} />
              <span className="ob-price">••••••</span>
              <span className="ob-qty--hidden">sealed</span>
            </div>
          ))
        )}
        {bids > MAX_ROWS && <div className="ob-more">+{bids - MAX_ROWS} more bids</div>}
      </div>

      <div className="ob-footer">
        <b>{bids}</b> bids · <b>{asks}</b> asks resting. Prices &amp; sizes are FHE ciphertext —
        the ladder is illustrative; real depth is unknowable by design.
      </div>
    </div>
  );
}
