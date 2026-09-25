export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Simple moving average of closes over the last `period` bars.
 * Returns null if fewer than `period` closes are available.
 */
export function ma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((sum, c) => sum + c, 0) / period;
}

/**
 * Average True Range over the last 14 bars.
 * Requires at least 15 bars (for prev_close on each of the 14 TRs).
 * Returns null if fewer than 15 bars are available.
 */
export function atr14(bars: Bar[]): number | null {
  if (bars.length < 15) return null;
  const slice = bars.slice(-15);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const bar = slice[i]!;
    const prevClose = slice[i - 1]!.c;
    const tr = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - prevClose),
      Math.abs(bar.l - prevClose),
    );
    sum += tr;
  }
  return sum / 14;
}

/**
 * Realized volatility: std dev of daily log returns over last 20 days,
 * annualized by multiplying by sqrt(252).
 * Returns null if fewer than 21 closes are available.
 */
export function realizedVol20d(closes: number[]): number | null {
  if (closes.length < 21) return null;
  const slice = closes.slice(-21);
  const logReturns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    logReturns.push(Math.log(slice[i]! / slice[i - 1]!));
  }
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * Z-score of the most recent volume vs the prior 20-day average and std dev.
 * Returns null if fewer than 21 volumes are available.
 */
export function volumeZ20d(volumes: number[]): number | null {
  if (volumes.length < 21) return null;
  const prior = volumes.slice(-21, -1); // 20 prior volumes
  const current = volumes[volumes.length - 1]!;
  const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
  const variance =
    prior.reduce((s, v) => s + (v - mean) ** 2, 0) / prior.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return (current - mean) / stdDev;
}

/**
 * Average daily volume over the last 20 bars.
 * Returns null if fewer than 20 volumes are available.
 */
export function adv20d(volumes: number[]): number | null {
  if (volumes.length < 20) return null;
  const slice = volumes.slice(-20);
  return slice.reduce((s, v) => s + v, 0) / 20;
}
