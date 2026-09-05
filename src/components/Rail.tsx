import type { ReactNode } from 'react';
import type { Screen } from '../types';

interface Props {
  current: Screen;
  onChange: (s: Screen) => void;
}

const ITEMS: { id: Screen; label: string; icon: ReactNode }[] = [
  {
    id: 'trade',
    label: 'Trade',
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor">
        <rect x="1" y="9"  width="3" height="6" rx="0.5"/>
        <rect x="6" y="5"  width="3" height="10" rx="0.5"/>
        <rect x="11" y="2" width="3" height="13" rx="0.5"/>
      </svg>
    ),
  },
  {
    id: 'perp',
    label: 'Perp',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 11 L5 6 L9 9 L15 2" />
        <polyline points="11 2 15 2 15 6" />
      </svg>
    ),
  },
  {
    id: 'markets',
    label: 'Markets',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="4"  cy="4"  r="2.5"/>
        <circle cx="12" cy="4"  r="2.5"/>
        <circle cx="4"  cy="12" r="2.5"/>
        <circle cx="12" cy="12" r="2.5"/>
      </svg>
    ),
  },
  {
    id: 'portfolio',
    label: 'Portfolio',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="1,13 4.5,8 7.5,10 11,4 15,2"/>
      </svg>
    ),
  },
  {
    id: 'orders',
    label: 'Orders',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <line x1="2" y1="5"  x2="10" y2="5"/>
        <line x1="2" y1="8"  x2="14" y2="8"/>
        <line x1="2" y1="11" x2="12" y2="11"/>
      </svg>
    ),
  },
];

export function Rail({ current, onChange }: Props) {
  return (
    <nav className="rail">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          className={`rail__item${current === item.id ? ' rail__item--active' : ''}`}
          onClick={() => onChange(item.id)}
          title={item.label}
        >
          <span className="rail__icon">{item.icon}</span>
          <span className="rail__label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
