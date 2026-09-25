import crypto from 'node:crypto';
import { TimeFrame } from '@alpacahq/alpaca-trade-api';
import { MarketSnapshot } from '@trading-council/contracts';
import { alpaca } from './alpaca.js';
import { pool } from './db.js';
import {
  ma,
  atr14,
  realizedVol20d,
  volumeZ20d,
  adv20d,
  type Bar,
} from './compute-technicals.js';

async function fetchVix(): Promise<{
  vix: number;
  vix_as_of: string;
  vix_stale_days: number;
}> {
  const fredKey = process.env['FRED_API_KEY'];
  if (!fredKey) {
    return { vix: 0, vix_as_of: new Date().toISOString(), vix_stale_days: 999 };
  }
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${fredKey}&sort_order=desc&limit=2&file_type=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FRED response ${res.status}`);
    const json = (await res.json()) as {
      observations: Array<{ date: string; value: string }>;
    };
    const obs = json.observations[0];
    if (!obs) throw new Error('No FRED observations');
    const vixValue = parseFloat(obs.value);
    const obsDate = new Date(obs.date);
    const now = new Date();
    const staleDays = Math.floor(
      (now.getTime() - obsDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    return {
      vix: isNaN(vixValue) ? 0 : vixValue,
      vix_as_of: obsDate.toISOString(),
      vix_stale_days: staleDays,
    };
  } catch (err) {
    console.error('[execution] fetchVix error', err);
    return { vix: 0, vix_as_of: new Date().toISOString(), vix_stale_days: 999 };
  }
}

export async function writeSnapshot(): Promise<void> {
  const watchRaw = process.env['WATCH_SYMBOLS'];
  if (!watchRaw) throw new Error('[execution] WATCH_SYMBOLS is required');
  const symbols = watchRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const clockResp = await alpaca.trading.clock.legacyClock();
  const session = clockResp.isOpen ? 'open' : 'closed';

  const { vix, vix_as_of, vix_stale_days } = await fetchVix();

  const missing: string[] = [];
  const symbolSnapshots: Record<string, unknown> = {};

  for (const symbol of symbols) {
    try {
      const rawBars = await alpaca.data.getStockBarsFor(symbol, {
        timeframe: TimeFrame.Day,
        limit: 210,
      });

      // Sort ascending by timestamp
      rawBars.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Map Alpaca Bar -> contracts Bar shape
      const bars: Bar[] = rawBars.map((b) => ({
        t: b.timestamp.toISOString(),
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
        v: b.volume,
      }));

      const closes = bars.map((b) => b.c);
      const volumes = bars.map((b) => b.v);

      const last = closes[closes.length - 1] ?? 0;
      const prevClose = closes[closes.length - 2] ?? last;

      const asset = await alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
        symbolOrAssetId: symbol,
      });

      symbolSnapshots[symbol] = {
        last,
        prev_close: prevClose,
        bars_1d: bars,
        ma20: ma(closes, 20),
        ma50: ma(closes, 50),
        ma200: ma(closes, 200),
        atr_14: atr14(bars),
        realized_vol_20d: realizedVol20d(closes),
        iv_rank: null,
        volume_z_20d: volumeZ20d(volumes),
        adv_20d: adv20d(volumes),
        tradable: asset.tradable,
        shortable: asset.shortable,
        halted: asset.status !== 'active',
      };
    } catch (err) {
      console.error(`[execution] snapshot error for ${symbol}`, err);
      missing.push(symbol);
    }
  }

  const snapshot = MarketSnapshot.parse({
    schema_version: 1,
    as_of: new Date().toISOString(),
    session,
    regime: {
      vix,
      vix_source: 'FRED:VIXCLS',
      vix_as_of,
      vix_stale_days,
    },
    symbols: symbolSnapshots,
    data_quality: {
      feed: 'sip',
      missing,
      stale: [],
    },
  });

  const inputHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');

  await pool.query(
    `INSERT INTO market_snapshots (as_of, session, input_hash, snapshot)
     VALUES ($1, $2, $3, $4)`,
    [snapshot.as_of, snapshot.session, inputHash, JSON.stringify(snapshot)],
  );

  console.log(
    `[execution] snapshot written: ${symbols.length - missing.length}/${symbols.length} symbols, session=${session}`,
  );
}
