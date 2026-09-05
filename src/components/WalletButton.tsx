import { useEffect, useRef, useState } from 'react';
import { useWallet } from '../wallet';
import { faucetSimulatedBalances, resetSimulatedBalances } from '../tradingEngine';

interface Props {
  onAddressChange: (address: string | null) => void;
  deposits?: { base: number; quote: number };
  onRefreshBalances?: () => void;
}

export function WalletButton({ onAddressChange, deposits, onRefreshBalances }: Props) {
  const {
    address,
    isConnected,
    isSimulated,
    currentProfile,
    profiles,
    providers,
    connect,
    connectSimulated,
    setCustomAddress,
    toggleMode,
    disconnect,
  } = useWallet();

  const [open, setOpen]               = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [copied, setCopied]           = useState(false);
  const [activeTab, setActiveTab]     = useState<'simulated' | 'web3'>(isSimulated ? 'simulated' : 'web3');
  const [web3Busy, setWeb3Busy]       = useState(false);
  const [web3Error, setWeb3Error]     = useState('');
  const menuRef                       = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onAddressChange(address);
  }, [address, onAddressChange]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  function copyAddress() {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleSetCustom() {
    if (!customInput.trim()) return;
    setCustomAddress(customInput.trim());
    setCustomInput('');
    onRefreshBalances?.();
  }

  function handleSelectProfile(id: string) {
    connectSimulated(id);
    onRefreshBalances?.();
  }

  function handleFaucet() {
    if (!address) return;
    faucetSimulatedBalances(address);
    onRefreshBalances?.();
  }

  function handleReset() {
    if (!address) return;
    resetSimulatedBalances(address);
    onRefreshBalances?.();
  }

  async function handleWeb3Connect(rdns?: string) {
    setWeb3Error('');
    setWeb3Busy(true);
    try {
      await connect(rdns);
      setOpen(false);
    } catch (e: any) {
      setWeb3Error(e?.message?.slice(0, 80) ?? 'Connection failed');
    } finally {
      setWeb3Busy(false);
    }
  }

  return (
    <div className="wallet-menu" ref={menuRef} style={{ position: 'relative' }}>
      {deposits && isConnected && (
        <div className="wallet-balances">
          <span className="wallet-bal">
            <span className="wallet-bal__label">encETH</span>
            <span className="wallet-bal__val">{deposits.base}</span>
          </span>
          <span className="wallet-bal">
            <span className="wallet-bal__label">encUSDC</span>
            <span className="wallet-bal__val">{deposits.quote.toLocaleString()}</span>
          </span>
        </div>
      )}

      {isConnected && address ? (
        <button
          className="wallet-btn wallet-btn--connected"
          onClick={() => setOpen((o) => !o)}
          title={address}
        >
          <span className="wallet-dot" style={{ backgroundColor: isSimulated ? '#10b981' : '#3b82f6' }} />
          <span style={{ fontWeight: 600, marginRight: 4 }}>
            {isSimulated ? (currentProfile ? `${currentProfile.avatar} ${currentProfile.name}` : '⚡ Trader') : '🦊 Web3'}
          </span>
          <span style={{ opacity: 0.75, fontFamily: 'var(--mono, monospace)' }}>
            ({address.slice(0, 4)}...{address.slice(-3)})
          </span>
        </button>
      ) : (
        <button className="wallet-btn" onClick={() => setOpen(true)}>
          Connect Trader Account
        </button>
      )}

      {open && (
        <div
          className="wallet-dropdown"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            width: 340,
            maxWidth: '92vw',
            zIndex: 100,
            background: 'var(--panel-bg, #11141a)',
            border: '1px solid var(--border-color, #272f3d)',
            borderRadius: 12,
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
            padding: 16,
            color: '#e2e8f0',
          }}
        >
          {/* Header tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid #272f3d', paddingBottom: 10 }}>
            <button
              type="button"
              onClick={() => { setActiveTab('simulated'); toggleMode(true); }}
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '0.8rem',
                fontWeight: 600,
                borderRadius: 6,
                background: activeTab === 'simulated' ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                color: activeTab === 'simulated' ? '#10b981' : '#94a3b8',
                border: activeTab === 'simulated' ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid transparent',
                cursor: 'pointer',
              }}
            >
              ⚡ Interactive Trader
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('web3')}
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '0.8rem',
                fontWeight: 600,
                borderRadius: 6,
                background: activeTab === 'web3' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                color: activeTab === 'web3' ? '#60a5fa' : '#94a3b8',
                border: activeTab === 'web3' ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid transparent',
                cursor: 'pointer',
              }}
            >
              🦊 Web3 Wallet
            </button>
          </div>

          {activeTab === 'simulated' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Current Address display */}
              {address && (
                <div style={{ background: '#171c26', padding: '10px 12px', borderRadius: 8, border: '1px solid #272f3d' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Active Trader ID
                    </span>
                    <button
                      type="button"
                      onClick={copyAddress}
                      style={{ fontSize: '0.7rem', color: '#10b981', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      {copied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.78rem', wordBreak: 'break-all', color: '#f8fafc' }}>
                    {address}
                  </div>
                </div>
              )}

              {/* Custom address input */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: 6 }}>
                  Enter custom trader address / ID:
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={customInput}
                    placeholder="0x... or trader.eth"
                    onChange={(e) => setCustomInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSetCustom(); }}
                    style={{
                      flex: 1,
                      background: '#171c26',
                      border: '1px solid #2d3748',
                      borderRadius: 6,
                      padding: '6px 10px',
                      fontSize: '0.8rem',
                      color: '#fff',
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleSetCustom}
                    style={{
                      background: '#10b981',
                      color: '#000',
                      border: 'none',
                      borderRadius: 6,
                      padding: '6px 12px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Set
                  </button>
                </div>
              </div>

              {/* Trader presets */}
              <div>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: 6 }}>
                  Switch Trader Desk:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {profiles.map((p) => {
                    const isActive = address?.toLowerCase() === p.address.toLowerCase();
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleSelectProfile(p.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          borderRadius: 8,
                          background: isActive ? 'rgba(16, 185, 129, 0.12)' : '#171c26',
                          border: isActive ? '1px solid #10b981' : '1px solid #272f3d',
                          cursor: 'pointer',
                          textAlign: 'left',
                          color: '#fff',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: '1.2rem' }}>{p.avatar}</span>
                          <div>
                            <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{p.name}</div>
                            <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{p.role}</div>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', fontSize: '0.72rem', color: '#10b981' }}>
                          {isActive ? '● Active' : 'Select →'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Faucet & quick actions */}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={handleFaucet}
                  style={{
                    flex: 1,
                    background: '#20293a',
                    border: '1px solid #334155',
                    color: '#38bdf8',
                    padding: '8px',
                    borderRadius: 6,
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  💧 Mint +25 ETH / +$50k
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  style={{
                    background: '#1f2430',
                    border: '1px solid #2d3748',
                    color: '#94a3b8',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                >
                  Reset Balances
                </button>
              </div>

              {isConnected && (
                <button
                  type="button"
                  onClick={() => { disconnect(); setOpen(false); }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#f87171',
                    fontSize: '0.75rem',
                    padding: '6px',
                    cursor: 'pointer',
                    marginTop: 4,
                  }}
                >
                  Disconnect Trader
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                Connect your browser Web3 wallet to test on Arbitrum Sepolia:
              </div>

              {providers.length > 0 ? (
                providers.map((p) => (
                  <button
                    key={p.info.rdns}
                    type="button"
                    onClick={() => handleWeb3Connect(p.info.rdns)}
                    disabled={web3Busy}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      background: '#171c26',
                      border: '1px solid #272f3d',
                      borderRadius: 8,
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    {p.info.icon && (
                      <img src={p.info.icon} alt="" width={20} height={20} style={{ borderRadius: 4 }} />
                    )}
                    <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{p.info.name}</span>
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  onClick={() => handleWeb3Connect()}
                  disabled={web3Busy}
                  style={{
                    padding: '10px 12px',
                    background: '#2563eb',
                    border: 'none',
                    borderRadius: 8,
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                  }}
                >
                  {web3Busy ? 'Connecting…' : 'Connect Browser Wallet'}
                </button>
              )}

              {web3Error && (
                <div style={{ fontSize: '0.75rem', color: '#f87171', background: 'rgba(239,68,68,0.1)', padding: 8, borderRadius: 6 }}>
                  {web3Error}
                </div>
              )}

              <button
                type="button"
                onClick={() => { setActiveTab('simulated'); toggleMode(true); }}
                style={{
                  marginTop: 6,
                  padding: '8px',
                  background: 'rgba(16, 185, 129, 0.15)',
                  border: '1px solid #10b981',
                  color: '#10b981',
                  borderRadius: 6,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                ← Back to Instant Trader Simulation
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
