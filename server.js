const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Prices endpoint (replaces Netlify prices function) ──
app.post('/api/prices', async (req, res) => {
  try {
    const alpacaKey    = process.env.ALPACA_KEY;
    const alpacaSecret = process.env.ALPACA_SECRET;

    if (!alpacaKey || !alpacaSecret) {
      return res.status(400).json({ error: 'Alpaca keys not configured' });
    }

    const { symbols, optionsChain, ticker, expiration } = req.body;
    const ah = {
      'APCA-API-KEY-ID': alpacaKey,
      'APCA-API-SECRET-KEY': alpacaSecret
    };

    // Options chain request
    if (optionsChain && ticker) {
      try {
        const expiryDate = expiration || getNextFriday();
        const optRes = await fetch(
          `https://data.alpaca.markets/v1beta1/options/snapshots/${ticker}?expiration_date=${expiryDate}&feed=indicative&limit=50`,
          { headers: ah }
        );
        if (!optRes.ok) return res.json({ options: [], error: `Options API: ${optRes.status}` });
        const optData = await optRes.json();
        const snapshots = optData.snapshots || {};
        const calls = [], puts = [];
        for (const [symbol, snap] of Object.entries(snapshots)) {
          const greeks  = snap.greeks || {};
          const quote   = snap.latestQuote || {};
          const trade   = snap.latestTrade || {};
          const details = snap.details || {};
          const item = {
            symbol, strike: details.strikePrice || 0,
            expiry: details.expirationDate || expiryDate,
            type: details.optionType || 'call',
            bid: quote.bp || 0, ask: quote.ap || 0,
            mark: ((quote.bp || 0) + (quote.ap || 0)) / 2,
            last: trade.p || 0, volume: snap.dailyBar?.v || 0,
            openInterest: snap.openInterest || 0,
            iv: snap.impliedVolatility ? (snap.impliedVolatility * 100).toFixed(1) : null,
            delta: greeks.delta?.toFixed(4) || null,
            theta: greeks.theta?.toFixed(4) || null,
            gamma: greeks.gamma?.toFixed(4) || null,
            vega:  greeks.vega?.toFixed(4)  || null,
          };
          if (details.optionType === 'call') calls.push(item);
          else puts.push(item);
        }
        calls.sort((a,b) => a.strike - b.strike);
        puts.sort((a,b)  => a.strike - b.strike);
        return res.json({ options: { calls, puts }, ticker });
      } catch(e) {
        return res.json({ options: [], error: e.message });
      }
    }

    // Stock prices request
    if (!symbols) return res.status(400).json({ error: 'Missing symbols' });
    const syms = symbols.join(',');
    const d35  = new Date(); d35.setDate(d35.getDate() - 35);

    // Try sip feed first (live account), fall back to iex
    let tradeRes, barRes;
    try {
      [tradeRes, barRes] = await Promise.all([
        fetch(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${syms}&feed=sip`, { headers: ah }),
        fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=${syms}&timeframe=1Day&start=${d35.toISOString().split('T')[0]}&limit=35&feed=sip`, { headers: ah })
      ]);
      if (!tradeRes.ok && (tradeRes.status === 403 || tradeRes.status === 402)) {
        throw new Error('sip not available');
      }
    } catch(e) {
      console.log('SIP failed, trying IEX:', e.message);
      [tradeRes, barRes] = await Promise.all([
        fetch(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${syms}&feed=iex`, { headers: ah }),
        fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=${syms}&timeframe=1Day&start=${d35.toISOString().split('T')[0]}&limit=35&feed=iex`, { headers: ah })
      ]);
    }

    if (!tradeRes.ok) {
      const errBody = await tradeRes.text();
      console.error('Trades API error:', tradeRes.status, errBody);
      throw new Error(`Trades API ${tradeRes.status}: ${errBody}`);
    }
    const tradeData = await tradeRes.json();
    const barData   = barRes.ok ? await barRes.json() : { bars: {} };

    const result = {};
    for (const sym of symbols) {
      const trade = tradeData?.trades?.[sym];
      const bars  = barData?.bars?.[sym] || [];
      const price = trade?.p || (bars.length ? bars[bars.length-1].c : 0);
      const prev  = bars.length > 1 ? bars[bars.length-2].c : price;
      result[sym] = { price, prevClose: prev, bars: bars.slice(-35) };
    }
    res.json(result);

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Signals endpoint (replaces Netlify signals function) ──
app.post('/api/signals', async (req, res) => {
  try {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

    const body = { ...req.body };
    const isTrumpWatch = body.trump_watch === true;
    const isNewsSearch = body.news_search === true;
    delete body.trump_watch;
    delete body.news_search;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    };

    if (isTrumpWatch || isNewsSearch) {
      headers['anthropic-beta'] = 'web-search-2025-03-05';
      body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    }

    const apiRes  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const data = await apiRes.json();
    const extractedText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    res.status(apiRes.status).json({ ...data, extractedText });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getNextFriday() {
  const d = new Date();
  d.setDate(d.getDate() + (5 - d.getDay() + 7) % 7 || 7);
  return d.toISOString().split('T')[0];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OptionPulse running on port ${PORT}`));
