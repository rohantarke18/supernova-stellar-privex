import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, createSeriesMarkers, type UTCTimestamp } from 'lightweight-charts';
import {
  subscribeToOHLC,
  fetchHistoricalCandles,
  STREAMING_TF,
  type TfKey,
  type OHLCCandle,
} from '../goldrush';
import type { Fill } from '../types';

const TIMEFRAMES: TfKey[] = ['1H', '4H', '1D', '7D', '30D', '90D'];
const INITIAL_HISTORY_DAYS: Record<TfKey, number> = {
  '1H': 7,
  '4H': 14,
  '1D': 45,
  '7D': 90,
  '30D': 180,
  '90D': 365,
};
const BACKFILL_CHUNK_DAYS: Record<TfKey, number> = {
  '1H': 7,
  '4H': 14,
  '1D': 30,
  '7D': 60,
  '30D': 90,
  '90D': 180,
};

interface Props {
  fills: Fill[];
  onSpotPrice?: (price: number) => void;
}

function generateFallbackCandles(days: number): OHLCCandle[] {
  const result: OHLCCandle[] = [];
  const count = Math.min(100, Math.max(24, days * 12));
  const intervalSec = Math.floor((days * 86400) / count);
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - count * intervalSec;
  let price = 2780.0;

  for (let i = 0; i < count; i++) {
    const time = startTime + i * intervalSec;
    const change = (Math.random() - 0.48) * (price * 0.008);
    const open = price;
    const close = Math.max(100, open + change);
    const high = Math.max(open, close) + Math.random() * (price * 0.004);
    const low = Math.min(open, close) - Math.random() * (price * 0.004);
    price = close;
    result.push({
      time,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
    });
  }
  return result;
}

export function Chart({ fills, onSpotPrice }: Props) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const fillsRef      = useRef(fills);
  const onSpotRef     = useRef(onSpotPrice);
  fillsRef.current    = fills;
  onSpotRef.current   = onSpotPrice;

  const [tf, setTf]          = useState<TfKey>('7D');
  const [loading, setLoading] = useState(true);

  const seriesRef    = useRef<any>(null);
  const markersRef   = useRef<any>(null);
  const chartRef     = useRef<any>(null);
  const candleMapRef = useRef<Map<number, OHLCCandle>>(new Map());
  const backfillBusyRef = useRef(false);
  const activeTfRef = useRef<TfKey>('7D');

  // Create chart instance once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor:  '#94a3b8',
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
      timeScale:       { borderColor: 'rgba(255, 255, 255, 0.08)', timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: 'rgba(59, 130, 246, 0.4)', labelBackgroundColor: '#162030' },
        horzLine: { color: 'rgba(59, 130, 246, 0.4)', labelBackgroundColor: '#162030' },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:         '#10b981',
      downColor:       '#f43f5e',
      borderUpColor:   '#10b981',
      borderDownColor: '#f43f5e',
      wickUpColor:     '#10b981',
      wickDownColor:   '#f43f5e',
    });

    seriesRef.current  = series;
    markersRef.current = createSeriesMarkers(series, []);
    chartRef.current   = chart;

    return () => { chart.remove(); seriesRef.current = null; };
  }, []);

  function sortedCandles() {
    return [...candleMapRef.current.values()].sort((a, b) => a.time - b.time);
  }

  function applyCandles(sorted: OHLCCandle[], fit = false) {
    if (!seriesRef.current) { console.warn('[Chart] applyCandles: series not ready'); return; }
    try {
      seriesRef.current.setData(
        sorted.map((c) => ({ ...c, time: c.time as UTCTimestamp })),
      );
    } catch (e) { console.error('[Chart] setData error:', e); return; }
    if (fit) chartRef.current?.timeScale().fitContent();

    const recentFills = fillsRef.current.slice(-6);
    if (recentFills.length && markersRef.current) {
      const markers = recentFills.map((_, i) => ({
        time: sorted[Math.max(0, sorted.length - recentFills.length + i)].time as UTCTimestamp,
        position: 'aboveBar' as const,
        color: '#7b6ef6',
        shape: 'circle' as const,
        text: '',
      }));
      markersRef.current.setMarkers(markers);
    }
  }

  function mergeCandles(candles: OHLCCandle[], fit = false) {
    const map = candleMapRef.current;
    for (const c of candles) map.set(c.time, c);
    const sorted = sortedCandles();
    applyCandles(sorted, fit);
    return sorted;
  }

  async function backfillEarlier(tfKey: TfKey) {
    if (backfillBusyRef.current || activeTfRef.current !== tfKey) return;
    const earliest = sortedCandles()[0]?.time;
    if (!earliest) return;

    backfillBusyRef.current = true;
    try {
      const chunk = await fetchHistoricalCandles(BACKFILL_CHUNK_DAYS[tfKey], earliest - 86400);
      if (activeTfRef.current !== tfKey || !chunk.length) return;
      mergeCandles(chunk, false);
    } catch (err) {
      console.error('Historical backfill error:', err);
    } finally {
      backfillBusyRef.current = false;
    }
  }

  // Handle timeframe changes
  useEffect(() => {
    if (!seriesRef.current) return;
    activeTfRef.current = tf;
    setLoading(true);
    backfillBusyRef.current = false;
    candleMapRef.current.clear();
    seriesRef.current.setData([]);

    if (STREAMING_TF.has(tf as any)) {
      // Seed older candles first, then keep the right edge live via GoldRush streaming.
      let firstBatch = true;
      let cancelled = false;
      fetchHistoricalCandles(INITIAL_HISTORY_DAYS[tf])
        .then((candles) => {
          if (cancelled || !seriesRef.current) return;
          if (!candles || !candles.length) {
            const fallback = generateFallbackCandles(INITIAL_HISTORY_DAYS[tf]);
            mergeCandles(fallback, true);
            if (fallback.length) onSpotRef.current?.(fallback[fallback.length - 1].close);
            setLoading(false);
          } else {
            mergeCandles(candles, false);
          }
        })
        .catch((err) => {
          console.error('Historical seed error:', err);
          if (cancelled || !seriesRef.current) return;
          const fallback = generateFallbackCandles(INITIAL_HISTORY_DAYS[tf]);
          mergeCandles(fallback, true);
          setLoading(false);
        });

      const fallbackTimer = setTimeout(() => {
        if (firstBatch && !cancelled && seriesRef.current && sortedCandles().length === 0) {
          const fallback = generateFallbackCandles(INITIAL_HISTORY_DAYS[tf]);
          mergeCandles(fallback, true);
          if (fallback.length) onSpotRef.current?.(fallback[fallback.length - 1].close);
          setLoading(false);
        }
      }, 1000);

      const unsub = subscribeToOHLC(
        tf as '1H' | '4H' | '1D' | '7D',
        (incoming, spotPrice) => {
          if (cancelled) return;
          if (spotPrice !== null) onSpotRef.current?.(spotPrice);

          mergeCandles(incoming, false);

          if (firstBatch) {
            firstBatch = false;
            chartRef.current?.timeScale().scrollToRealTime();
            setLoading(false);
          }
        },
        (err) => console.error('OHLCV stream error:', err),
      );
      return () => { cancelled = true; clearTimeout(fallbackTimer); unsub(); };
    } else {
      // REST path — fetch once from GoldRush pricing API
      const days = tf === '30D' ? 30 : 90;
      let cancelled = false;
      fetchHistoricalCandles(days)
        .then((candles) => {
          if (cancelled || !seriesRef.current) return;
          if (!candles || !candles.length) {
            const fallback = generateFallbackCandles(days);
            mergeCandles(fallback, true);
            if (fallback.length) onSpotRef.current?.(fallback[fallback.length - 1].close);
          } else {
            const sorted = mergeCandles(candles, true);
            if (sorted.length) onSpotRef.current?.(sorted[sorted.length - 1].close);
          }
          setLoading(false);
        })
        .catch((err) => {
          console.error('Historical fetch error:', err);
          if (cancelled || !seriesRef.current) return;
          const fallback = generateFallbackCandles(days);
          mergeCandles(fallback, true);
          setLoading(false);
        });
      return () => { cancelled = true; };
    }
  }, [tf]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const onRange = (range: { from?: number | null } | null) => {
      if (!range || range.from == null) return;
      if (range.from < 35) backfillEarlier(activeTfRef.current);
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', flex: 1, minHeight: 0 }}>
      <div className="chart-header">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span className="chart-pair">ETH / USD</span>
          <span style={{ fontSize: 9, color: '#5a5a7a', letterSpacing: '0.04em' }}>
            Base Mainnet · reference price only
          </span>
        </div>
        <div className="chart-tfs">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              className={`chart-tf ${tf === t ? 'chart-tf--active' : ''}`}
              onClick={() => setTf(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {loading && <span className="chart-loading">loading</span>}
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
