export interface PortfolioState {
  haltLevel: 0 | 1 | 2 | 3 | 4;
  currentNav: number;
  peakNav: number;
  dailyPnlUsd: number;
  /** Total notional USD currently open in asymmetric positions */
  asymmetricNotionalOpen: number;
  /** Tickers that already have a pending or claimed trade intent */
  openIntentTickers: ReadonlyArray<string>;
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
