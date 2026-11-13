import crypto from 'node:crypto';
import { TimeFrame } from '@alpacahq/alpaca-trade-api';
import { MarketSnapshot } from '@trading-council/contracts';
import type { MacroContext } from '@trading-council/contracts';
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

let vixWarned = false;

async function fetchVix(): Promise<{
  vix: number;
  vix_as_of: string;
  vix_stale_days: number;
}> {
  const fredKey = process.env['FRED_API_KEY'];
  if (!fredKey) {
    if (!vixWarned) {
      vixWarned = true;
      console.warn(
        '[execution] FRED_API_KEY is not set — snapshots carry vix=0/stale_days=999. ' +
          'The council treats this as "VIX unavailable", but set the key for real regime data.',
      );
    }
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

async function fetchMacroContext(includeCryptoHeadlines: boolean): Promise<MacroContext> {
  let fearGreedIndex: number | null = null;
  let fearGreedLabel: string | null = null;
  let fearGreedAsOf: string | null = null;

  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    if (res.ok) {
      const json = await res.json() as { data?: Array<{ value: string; value_classification: string; timestamp: string }> };
      const item = json.data?.[0];
      if (item) {
        fearGreedIndex = parseInt(item.value, 10);
        fearGreedLabel = item.value_classification;
        fearGreedAsOf = new Date(parseInt(item.timestamp, 10) * 1000).toISOString();
      }
    }
  } catch (err) {
    console.warn('[execution] fetchMacroContext: fear/greed fetch failed', err);
  }

  const headlines: Array<{ title: string; source: string; published_at: string; sentiment: 'positive' | 'negative' | 'neutral' | null }> = [];
  if (includeCryptoHeadlines) {
    const cryptoPanicKey = process.env['CRYPTOPANIC_API_KEY'];
    if (cryptoPanicKey) {
      try {
        const url = `https://cryptopanic.com/api/free/v1/posts/?auth_token=${cryptoPanicKey}&currencies=BTC,ETH&filter=hot&public=true`;
        const res = await fetch(url);
        if (res.ok) {
          const json = await res.json() as { results?: Array<{ title: string; source: { title: string }; published_at: string; votes?: { positive: number; negative: number } }> };
          for (const item of (json.results ?? []).slice(0, 8)) {
            const pos = item.votes?.positive ?? 0;
            const neg = item.votes?.negative ?? 0;
            const sentiment = pos > neg * 1.5 ? 'positive' : neg > pos * 1.5 ? 'negative' : 'neutral';
            headlines.push({
              title: item.title,
              source: item.source.title,
              published_at: item.published_at,
              sentiment,
            });
          }
        }
      } catch (err) {
        console.warn('[execution] fetchMacroContext: CryptoPanic fetch failed', err);
      }
    }
  }

  return {
    fear_greed_index: fearGreedIndex,
    fear_greed_label: fearGreedLabel,
    fear_greed_as_of: fearGreedAsOf,
    ...(includeCryptoHeadlines ? { crypto_headlines: headlines } : {}),
  };
}

const FORECASTER_URL = process.env['FORECASTER_URL'] ?? ''; // unset = forecaster disabled (fm_forecast: null)

async function callForecaster(
  symbol: string,
  closes: number[],
  horizonDays = 7,
): Promise<{ point: number; q10: number; q90: number; horizon_days: number } | null> {
  if (!FORECASTER_URL || closes.length < 64) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${FORECASTER_URL}/forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, prices: closes, horizon_days: horizonDays }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[execution] forecaster: non-2xx response ${res.status} for ${symbol}`);
      return null;
    }
    const json = await res.json() as { point: number; q10: number; q90: number; horizon_days: number };
    return json;
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      console.warn(`[execution] forecaster: call failed for ${symbol}`, err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function writeCryptoSnapshot(): Promise<void> {
  const watchRaw = process.env['WATCH_CRYPTO_SYMBOLS'];
  if (!watchRaw) return; // crypto is optional
  const symbols = watchRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0) return;

  // Crypto is always open (24/7)
  const session = 'open';
  const { vix, vix_as_of, vix_stale_days } = await fetchVix();
  const macroCtx = await fetchMacroContext(true);
  const missing: string[] = [];
  const symbolSnapshots: Record<string, unknown> = {};
  const startDate = new Date(Date.now() - 210 * 24 * 60 * 60 * 1000);

  for (const symbol of symbols) {
    try {
      const rawBars = await alpaca.data.getCryptoBarsFor(symbol, {
        timeframe: TimeFrame.Day,
        loc: 'us',
        start: startDate,
      });
      rawBars.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

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

      const fmForecast = await callForecaster(symbol, closes);

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
        tradable: true,
        shortable: false, // crypto shorting not supported on Alpaca paper
        halted: false,
        fm_forecast: fmForecast ?? null,
      };
    } catch (err) {
      console.error(`[execution] crypto snapshot error for ${symbol}`, err);
      missing.push(symbol);
    }
  }

  const snapshot = MarketSnapshot.parse({
    schema_version: 1,
    as_of: new Date().toISOString(),
    session,
    regime: { vix, vix_source: 'FRED:VIXCLS', vix_as_of, vix_stale_days },
    symbols: symbolSnapshots,
    data_quality: { feed: 'sip', missing, stale: [] },
    macro_context: macroCtx,
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
    `[execution] crypto snapshot written: ${symbols.length - missing.length}/${symbols.length} symbols`,
  );
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
  const macroCtx = await fetchMacroContext(false);

  const missing: string[] = [];
  const symbolSnapshots: Record<string, unknown> = {};

  for (const symbol of symbols) {
    try {
      // `start` is REQUIRED: without it Alpaca defaults to "from the start of today", so before
      // the open there are zero bars (last=0) and afterwards a single partial bar — never enough
      // for ma20/ma50/ATR/vol. (Stock snapshots had no technicals at all until this was fixed.)
      // ~420 calendar days ≈ 290 trading days, enough for the 200-day MA. No `limit`: with the
      // default ascending sort a limit would return the OLDEST bars and drop the latest ones.
      const rawBars = await alpaca.data.getStockBarsFor(symbol, {
        timeframe: TimeFrame.Day,
        start: new Date(Date.now() - 420 * 24 * 60 * 60 * 1000),
      });

      // Sort ascending by timestamp, keep the most recent 210
      rawBars.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      if (rawBars.length > 210) rawBars.splice(0, rawBars.length - 210);
      if (rawBars.length === 0) throw new Error(`no bars returned for ${symbol}`);

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
      if (!(last > 0)) throw new Error(`non-positive last price for ${symbol}`); // never write a zero price

      const asset = await alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
        symbolOrAssetId: symbol,
      });

      const fmForecast = await callForecaster(symbol, closes);

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
        fm_forecast: fmForecast ?? null,
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
    macro_context: macroCtx,
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
