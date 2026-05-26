// WheelPicks API Proxy — Vercel Serverless Function
// Uses Massive.com (formerly Polygon.io) for options data — never blocked

const MASSIVE_KEY   = "kIjvBYnuGohoHzCO5wVmAjNuBoQjMwtr";
const GEMINI_KEY    = process.env.GEMINI_KEY  || "AIzaSyDgHKgm3Xk3aU8IFrWgFSjGKVS3_QELl1U";
const SUPABASE_URL  = "https://qpcugczsqsjnodlgdver.supabase.co";
const SERVICE_KEY   = "sb_secret_-Gklon3IGgPk70DZ5f9EUw_bEY5xH78";
const REST          = `${SUPABASE_URL}/rest/v1`;

const OPTIONS_TTL_MS = 4 * 60 * 60 * 1000;  // 4 hours
const QUOTES_TTL_MS  = 5 * 60 * 1000;        // 5 minutes

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const DB_HEADERS = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// ── Supabase cache helpers ─────────────────────────────────

async function dbGet(table, params) {
  try {
    const r = await fetch(`${REST}/${table}?${params}`, {
      headers: { ...DB_HEADERS, "Prefer": "return=representation" }
    });
    if (!r.ok) return [];
    return await r.json();
  } catch (_) { return []; }
}

async function dbUpsert(table, body) {
  try {
    await fetch(`${REST}/${table}`, {
      method: "POST",
      headers: { ...DB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(body),
    });
  } catch (_) {}
}

async function getCachedOptions(ticker, expTs) {
  const rows = await dbGet("options_cache",
    `ticker=eq.${ticker}&exp_ts=eq.${expTs}&select=data,updated_at&limit=1`);
  if (!rows.length) return null;
  const age = Date.now() - new Date(rows[0].updated_at).getTime();
  return age > OPTIONS_TTL_MS ? null : rows[0].data;
}

async function getStaleOptions(ticker, expTs) {
  const rows = await dbGet("options_cache",
    `ticker=eq.${ticker}&exp_ts=eq.${expTs}&select=data&limit=1`);
  return rows.length ? rows[0].data : null;
}

async function getCachedQuote(ticker) {
  const rows = await dbGet("quotes_cache",
    `ticker=eq.${ticker}&select=price,updated_at&limit=1`);
  if (!rows.length) return null;
  const age = Date.now() - new Date(rows[0].updated_at).getTime();
  return age > QUOTES_TTL_MS ? null : rows[0].price;
}

async function upsertOptions(ticker, expTs, data) {
  await dbUpsert("options_cache", {
    ticker, exp_ts: expTs, data, updated_at: new Date().toISOString()
  });
}

async function upsertQuote(ticker, price) {
  await dbUpsert("quotes_cache", {
    ticker, price, updated_at: new Date().toISOString()
  });
}

// ── Massive.com (Polygon) helpers ──────────────────────────

async function fetchMassiveQuote(ticker) {
  try {
    const r = await fetch(
      `https://api.polygon.io/v2/last/trade/${ticker}?apiKey=${MASSIVE_KEY}`
    );
    const j = await r.json();
    const price = j?.results?.p;
    if (price) return parseFloat(price.toFixed(2));

    // Fallback: previous close
    const r2 = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${MASSIVE_KEY}`
    );
    const j2 = await r2.json();
    const close = j2?.results?.[0]?.c;
    if (close) return parseFloat(close.toFixed(2));
  } catch (_) {}
  return null;
}

async function fetchMassiveOptions(ticker, expDate) {
  // expDate format: "2026-06-20"
  try {
    let url = `https://api.polygon.io/v3/snapshot/options/${ticker}?limit=250&apiKey=${MASSIVE_KEY}`;
    if (expDate) url += `&expiration_date=${expDate}`;

    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.results?.length) return null;

    // Transform Massive snapshot format → Yahoo-compatible format
    // that WheelPicks frontend already knows how to parse
    const puts = [];
    const calls = [];

    j.results.forEach(opt => {
      const d = opt.details || {};
      const g = opt.greeks || {};
      const day = opt.day || {};
      const contract = {
        strike:         d.strike_price,
        lastPrice:      opt.last_trade?.price || day.close || 0,
        bid:            opt.last_quote?.bid || 0,
        ask:            opt.last_quote?.ask || 0,
        openInterest:   opt.open_interest || 0,
        volume:         day.volume || 0,
        impliedVolatility: opt.implied_volatility || 0,
        delta:          g.delta || 0,
        theta:          g.theta || 0,
        gamma:          g.gamma || 0,
        vega:           g.vega || 0,
      };
      // Use mid price as premium
      if (contract.bid > 0 && contract.ask > 0) {
        contract.lastPrice = parseFloat(((contract.bid + contract.ask) / 2).toFixed(2));
      }
      if (d.contract_type === "put") puts.push(contract);
      else if (d.contract_type === "call") calls.push(contract);
    });

    // Sort by strike descending (ITM first for puts)
    puts.sort((a, b) => b.strike - a.strike);
    calls.sort((a, b) => a.strike - b.strike);

    // Get unique expiration dates from results
    const expDates = [...new Set(j.results.map(o => o.details?.expiration_date).filter(Boolean))];
    const expTimestamps = expDates.map(d => Math.floor(new Date(d).getTime() / 1000));

    // Wrap in Yahoo-compatible envelope so existing frontend code works unchanged
    return {
      optionChain: {
        result: [{
          underlyingSymbol: ticker,
          expirationDates: expTimestamps,
          strikes: [...new Set([...puts, ...calls].map(o => o.strike))].sort((a,b) => a-b),
          quote: { regularMarketPrice: opt?.underlying?.price || 0 },
          options: [{
            expirationDate: expDate ? Math.floor(new Date(expDate).getTime()/1000) : expTimestamps[0],
            puts,
            calls
          }]
        }]
      }
    };
  } catch (e) {
    console.log("Massive options error:", e.message);
    return null;
  }
}

// Convert unix timestamp to YYYY-MM-DD
function tsToDate(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().split("T")[0];
}

// ── Main handler ───────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    return res.status(200).end();
  }

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const { ticker = "", type = "quote", exp = "" } = req.query;

  try {

    // ── Gemini AI ──────────────────────────────────────────
    if (type === "gemini_news" || type === "gemini_sellers") {
      const body = req.body || {};
      const useSearch = type === "gemini_news";
      const geminiBody = {
        contents: [{ parts: [{ text: body.prompt || "" }] }],
        generationConfig: { maxOutputTokens: useSearch ? 800 : 600, temperature: 0.3 }
      };
      if (useSearch) geminiBody.tools = [{ google_search: {} }];
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) }
      );
      return res.status(200).json(await r.json());
    }

    // ── Quote ──────────────────────────────────────────────
    if (type === "quote") {
      // 1. Cache
      const cached = await getCachedQuote(ticker);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json({
          chart: { result: [{ meta: { regularMarketPrice: cached } }] }
        });
      }
      // 2. Live from Massive
      const price = await fetchMassiveQuote(ticker);
      if (price) {
        upsertQuote(ticker, price);
        res.setHeader("X-Cache", "MISS");
        return res.status(200).json({
          chart: { result: [{ meta: { regularMarketPrice: price } }] }
        });
      }
      return res.status(200).json({ chart: { result: [] } });
    }

    // ── News (still use Yahoo for news since it's not blocked) ──
    if (type === "news") {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}&newsCount=5&quotesCount=0`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
      );
      return res.status(200).json(await r.json());
    }

    // ── Options chain ──────────────────────────────────────
    const expTs = exp ? parseInt(exp) : 0;
    const expDate = expTs > 0 ? tsToDate(expTs) : "";

    // 1. Fresh cache
    const fresh = await getCachedOptions(ticker, expTs);
    if (fresh) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(fresh);
    }

    // 2. Live from Massive
    const live = await fetchMassiveOptions(ticker, expDate);
    if (live) {
      upsertOptions(ticker, expTs, live);
      res.setHeader("X-Cache", "MISS");
      return res.status(200).json(live);
    }

    // 3. Stale cache fallback
    const stale = await getStaleOptions(ticker, expTs);
    if (stale) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json(stale);
    }

    // 4. Nothing
    res.setHeader("X-Cache", "EMPTY");
    return res.status(200).json({ optionChain: { result: [] } });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
