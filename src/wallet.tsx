import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { switchToArbitrumSepolia } from './contract';
import { warmupCofhe } from './cofhe';

export interface WalletProviderInfo {
  uuid: string;
  name: string;
  icon: string;   // data: URI
  rdns: string;   // reverse-DNS id, e.g. io.metamask
}

export interface DiscoveredProvider {
  info: WalletProviderInfo;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any;  // EIP-1193 provider
}

export interface TraderProfile {
  id: string;
  name: string;
  role: string;
  address: string;
  initialBase: number;
  initialQuote: number;
  avatar: string;
}

export const TRADER_PROFILES: TraderProfile[] = [
  {
    id: 'quant',
    name: 'Arbitrage Quant',
    role: 'HFT Strategy Desk',
    address: '0x71C8364f3B888126e82813BEc855a907297da89B',
    initialBase: 45.0,
    initialQuote: 150000,
    avatar: '⚡',
  },
  {
    id: 'whale',
    name: 'Whale Desk',
    role: 'Institutional Liquid',
    address: '0x3F8829Cda763321558E5F6De2e763fF40E9491c4',
    initialBase: 120.0,
    initialQuote: 450000,
    avatar: '🐋',
  },
  {
    id: 'mm',
    name: 'Confidential MM',
    role: 'Sealed Book Liquidity',
    address: '0x92B19e48a33aE5d66Fa0935D6a3501aB750F6e70',
    initialBase: 250.0,
    initialQuote: 850000,
    avatar: '🛡️',
  },
];

const LS_KEY_RDNS = 'blindclob.walletRdns';
const LS_KEY_MODE = 'privex.walletMode'; // 'simulated' | 'web3'
const LS_KEY_SIM_ADDR = 'privex.simAddress';
const LS_KEY_SIM_PROFILE = 'privex.simProfile';

export interface WalletContextValue {
  address: string | null;
  isConnected: boolean;
  isSimulated: boolean;
  currentProfile: TraderProfile | null;
  profiles: TraderProfile[];
  providers: DiscoveredProvider[];
  selectedRdns: string | null;
  connect: (rdns?: string) => Promise<void>;
  connectSimulated: (profileId: string) => void;
  setCustomAddress: (address: string) => void;
  toggleMode: (simulated: boolean) => void;
  disconnect: () => void;
  getEthereumProvider: () => Promise<unknown>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function createSimulatedEip1193(addr: string) {
  return {
    isMetaMask: true,
    request: async ({ method }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return [addr];
      }
      if (method === 'eth_chainId') {
        return '0xa4ba'; // Arbitrum Sepolia
      }
      if (method === 'net_version') {
        return '421614';
      }
      if (method === 'eth_sendTransaction') {
        return '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      }
      if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
        return '0x' + Array.from({ length: 130 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      }
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  // Mode: Default to simulated mode so platform works immediately without extensions
  const [isSimulated, setIsSimulated] = useState<boolean>(() => {
    const saved = localStorage.getItem(LS_KEY_MODE);
    return saved !== 'web3';
  });

  const [currentProfileId, setCurrentProfileId] = useState<string>(() => {
    return localStorage.getItem(LS_KEY_SIM_PROFILE) || 'quant';
  });

  const [simAddress, setSimAddress] = useState<string>(() => {
    const savedAddr = localStorage.getItem(LS_KEY_SIM_ADDR);
    if (savedAddr) return savedAddr;
    const defaultProfile = TRADER_PROFILES.find((p) => p.id === 'quant') ?? TRADER_PROFILES[0];
    return defaultProfile.address;
  });

  // Web3 state
  const [web3Address, setWeb3Address]   = useState<string | null>(null);
  const [providers, setProviders]       = useState<DiscoveredProvider[]>([]);
  const [selected, setSelected]         = useState<DiscoveredProvider | null>(null);

  const providersRef = useRef<DiscoveredProvider[]>([]);
  const selectedRef  = useRef<DiscoveredProvider | null>(null);
  providersRef.current = providers;
  selectedRef.current  = selected;

  // Active address
  const activeAddress = isSimulated ? simAddress : web3Address;
  const currentProfile = isSimulated
    ? TRADER_PROFILES.find((p) => p.address.toLowerCase() === simAddress.toLowerCase()) ?? null
    : null;

  // ── Discover wallets via EIP-6963 ──────────────────────────────────────────
  useEffect(() => {
    function onAnnounce(event: Event) {
      const detail = (event as CustomEvent<DiscoveredProvider>).detail;
      if (!detail?.info?.rdns) return;
      setProviders((prev) =>
        prev.some((p) => p.info.rdns === detail.info.rdns) ? prev : [...prev, detail],
      );
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
  }, []);

  const resolveProvider = useCallback((rdns?: string): DiscoveredProvider | null => {
    const list = providersRef.current;
    if (rdns) return list.find((p) => p.info.rdns === rdns) ?? null;
    if (list.length === 1) return list[0];
    return null;
  }, []);

  // Web3 auto-restore
  useEffect(() => {
    if (isSimulated || selected || providers.length === 0) return;
    const savedRdns = localStorage.getItem(LS_KEY_RDNS);
    const restore = savedRdns ? providers.find((p) => p.info.rdns === savedRdns) : undefined;
    if (!restore) return;
    restore.provider
      .request({ method: 'eth_accounts' })
      .then((accounts: string[]) => {
        if (accounts[0]) {
          setSelected(restore);
          setWeb3Address(accounts[0]);
          warmupCofhe(accounts[0], restore.provider).catch(() => {});
        }
      })
      .catch(() => {});
  }, [providers, selected, isSimulated]);

  // Web3 actions
  const connect = useCallback(async (rdns?: string) => {
    const chosen = resolveProvider(rdns);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prov = chosen?.provider ?? (window as any).ethereum;
    if (!prov) throw new Error('No browser wallet detected. You can switch to Simulated Trader Mode.');

    const accounts: string[] = await prov.request({ method: 'eth_requestAccounts' });
    const addr = accounts[0] ?? null;

    setSelected(chosen ?? null);
    if (chosen) localStorage.setItem(LS_KEY_RDNS, chosen.info.rdns);
    setWeb3Address(addr);
    setIsSimulated(false);
    localStorage.setItem(LS_KEY_MODE, 'web3');

    await switchToArbitrumSepolia(prov);
    if (addr) warmupCofhe(addr, prov).catch(() => {});
  }, [resolveProvider]);

  // Simulated actions
  const connectSimulated = useCallback((profileId: string) => {
    const prof = TRADER_PROFILES.find((p) => p.id === profileId);
    if (prof) {
      setSimAddress(prof.address);
      setCurrentProfileId(prof.id);
      setIsSimulated(true);
      localStorage.setItem(LS_KEY_MODE, 'simulated');
      localStorage.setItem(LS_KEY_SIM_ADDR, prof.address);
      localStorage.setItem(LS_KEY_SIM_PROFILE, prof.id);
    }
  }, []);

  const setCustomAddress = useCallback((raw: string) => {
    let clean = raw.trim();
    if (!clean) return;
    if (!clean.startsWith('0x')) clean = '0x' + clean;
    setSimAddress(clean);
    setIsSimulated(true);
    localStorage.setItem(LS_KEY_MODE, 'simulated');
    localStorage.setItem(LS_KEY_SIM_ADDR, clean);
  }, []);

  const toggleMode = useCallback((simulated: boolean) => {
    setIsSimulated(simulated);
    localStorage.setItem(LS_KEY_MODE, simulated ? 'simulated' : 'web3');
  }, []);

  const disconnect = useCallback(() => {
    if (isSimulated) {
      setSimAddress('');
      localStorage.removeItem(LS_KEY_SIM_ADDR);
    } else {
      setWeb3Address(null);
      setSelected(null);
      localStorage.removeItem(LS_KEY_RDNS);
    }
  }, [isSimulated]);

  const getEthereumProvider = useCallback(async () => {
    if (isSimulated) {
      return createSimulatedEip1193(simAddress || '0x71C8364f3B888126e82813BEc855a907297da89B');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prov = selectedRef.current?.provider ?? (window as any).ethereum;
    if (!prov) throw new Error('No browser wallet detected');
    return prov;
  }, [isSimulated, simAddress]);

  return (
    <WalletContext.Provider
      value={{
        address: activeAddress || null,
        isConnected: Boolean(activeAddress),
        isSimulated,
        currentProfile,
        profiles: TRADER_PROFILES,
        providers,
        selectedRdns: selected?.info.rdns ?? null,
        connect,
        connectSimulated,
        setCustomAddress,
        toggleMode,
        disconnect,
        getEthereumProvider,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>');
  return ctx;
}
