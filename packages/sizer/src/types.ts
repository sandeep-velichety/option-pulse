export interface PortfolioState {
  haltLevel: 0 | 1 | 2 | 3 | 4;
  currentNav: number;
  peakNav: number;
  dailyPnlUsd: number;
  /** Total notional USD currently open in asymmetric positions */
  asymmetricNotionalOpen: number;
  /**
   * Tickers with a LIVE trade intent: pending/claimed/submitted AND not yet expired.
   * (A 'submitted' intent past its expires_at is resolved — it must not block the ticker.)
   */
  openIntentTickers: ReadonlyArray<string>;
  /**
   * Tickers currently held as positions (intent-ticker format, e.g. "BTC/USD").
   * Optional for backward compatibility; omitted/empty disables the no_open_position check.
   */
  openPositionTickers?: ReadonlyArray<string>;
}

export interface GateConfig {
  /** Fraction of currentNav; daily P&L below -limit triggers rejection. Default 0.02 */
  dailyLossLimitFraction: number;
  /** Drawdown from peakNav above this fraction triggers rejection. Default 0.10 */
  maxDrawdownFraction: number;
  /** Minimum halt level that blocks a trade (inclusive). Default 2 */
  blockOnHaltLevel: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  dailyLossLimitFraction: 0.02,
  maxDrawdownFraction: 0.10,
  blockOnHaltLevel: 2,
};
