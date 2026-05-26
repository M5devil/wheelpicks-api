// WheelPicks API Proxy — Vercel Serverless Function
// Uses Massive.com (formerly Polygon.io) for options + quotes

const MASSIVE_KEY   = "kIjvBYnuGohoHzCO5wVmAjNuBoQjMwtr";
const GEMINI_KEY    = "AIzaSyDgHKgm3Xk3aU8IFrWgFSjGKVS3_QELl1U";
const SUPABASE_URL  = "https://qpcugczsqsjnodlgdver.supabase.co";
const SERVICE_KEY   = "sb_secret_-Gklon3IGgPk70DZ5f9EUw_bEY5xH78";
const REST          = `${SUPABASE_URL}/rest/v1`;
const MASSIVE_BASE  = "https://api.massive.com";  // new base URL after rebrand

const OPTIONS_TTL_MS = 4 * 60 * 60 * 1000;
const QUOTES_TTL_MS  = 5 * 60 * 1000;

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

// ── Supabase cache ─────────────────────────────────────────

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
  await dbUpsert("options_cache", { ticker, exp_ts: expTs, data, updated_at: new Date().toISOString() });
}

async function upsertQuote(ticker, price) {
  await dbUpsert("quotes_cache", { ticker, price, updated_at: new Date().toISOString() });
}

// ── Massive.com API helpers ────────────────────────────────

async function massiveGet(path) {
  // Try new base first, fall back to polygon.io
  for (const base of [MASSIVE_BASE, "https://api.polygon.io"]) {
    try {
      const url = `${base}${path}${path.includes("?") ? "&" : "?"}apiKey=${MASSIVE_KEY}`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (r.ok) {
        const j = await r.json();
        if (j.status !== "ERROR" && j.status !== "NOT_AUTHORIZED") return j;
      }
    } catch (_) {}
  }
  return null;
}

async function fetchMassiveQuote(ticker) {
  // Try snapshot first (most reliable)
  const snap = await massiveGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
  const price = snap?.ticker?.day?.c || snap?.ticker?.prevDay?.c || snap?.ticker?.lastTrade?.p;
  if (price) return parseFloat(price.toFixed(2));

  // Fallback: previous close
  const prev = await massiveGet(`/v2/aggs/ticker/${ticker}/prev?adjusted=true`);
  const close = prev?.results?.[0]?.c;
  if (close) return parseFloat(close.toFixed(2));

  return null;
}

async function fetchMassiveOptions(ticker, expDate) {
  // Get options snapshot with Greeks
  let path = `/v3/snapshot/options/${ticker}?limit=250&contract_type=put`;
  if (expDate) path += `&expiration_date=${expDate}`;

  const putsData = await massiveGet(path);
  const callsPath = path.replace("contract_type=put", "contract_type=call");
  const callsData = await massiveGet(callsPath);

  if (!putsData?.results?.length && !callsData?.results?.length) return null;

  function transformContracts(results) {
    return (results || []).map(opt => {
      const d = opt.details || {};
      const g = opt.greeks || {};
      const day = opt.day || {};
      const quote = opt.last_quote || {};
      const bid = parseFloat((quote.bid || 0).toFixed(2));
      const ask = parseFloat((quote.ask || 0).toFixed(2));
      const mid = bid > 0 && ask > 0 ? parseFloat(((bid + ask) / 2).toFixed(2)) : (day.close || 0);
      return {
        strike:            d.strike_price || 0,
        lastPrice:         parseFloat((mid).toFixed(2)),
        bid,
        ask,
        openInterest:      opt.open_interest || 0,
        volume:            day.volume || 0,
        impliedVolatility: parseFloat(((opt.implied_volatility || 0) * 100).toFixed(1)),
        delta:             parseFloat((g.delta || 0).toFixed(4)),
        theta:             parseFloat((g.theta || 0).toFixed(4)),
        gamma:             parseFloat((g.gamma || 0).toFixed(4)),
        vega:              parseFloat((g.vega || 0).toFixed(4)),
        expiration:        d.expiration_date || expDate,
      };
    }).filter(c => c.strike > 0);
  }

  const puts  = transformContracts(putsData?.results).sort((a,b) => b.strike - a.strike);
  const calls = transformContracts(callsData?.results).sort((a,b) => a.strike - b.strike);

  // Get current price from underlying
  const underlyingPrice = putsData?.results?.[0]?.underlying?.price ||
                          callsData?.results?.[0]?.underlying?.price || 0;

  // Gather all unique expiration dates from results
  const allResults = [...(putsData?.results || []), ...(callsData?.results || [])];
  const expDates = [...new Set(allResults.map(o => o.details?.expiration_date).filter(Boolean))].sort();
  const expTimestamps = expDates.map(d => Math.floor(new Date(d + "T16:00:00Z").getTime() / 1000));

  const expTs = expDate ? Math.floor(new Date(expDate + "T16:00:00Z").getTime() / 1000) : (expTimestamps[0] || 0);

  return {
    optionChain: {
      result: [{
        underlyingSymbol: ticker,
        expirationDates: expTimestamps,
        strikes: [...new Set([...puts, ...calls].map(o => o.strike))].sort((a,b) => a-b),
        quote: { regularMarketPrice: underlyingPrice },
        options: [{ expirationDate: expTs, puts, calls }]
      }]
    }
  };
}

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
      const cached = await getCachedQuote(ticker);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json({ chart: { result: [{ meta: { regularMarketPrice: cached } }] } });
      }
      const price = await fetchMassiveQuote(ticker);
      if (price) {
        upsertQuote(ticker, price);
        res.setHeader("X-Cache", "MISS");
        return res.status(200).json({ chart: { result: [{ meta: { regularMarketPrice: price } }] } });
      }
      return res.status(200).json({ chart: { result: [] } });
    }

    // ── News ───────────────────────────────────────────────
    if (type === "news") {
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}&newsCount=5&quotesCount=0`,
          { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
        );
        return res.status(200).json(await r.json());
      } catch (_) {
        return res.status(200).json({ news: [] });
      }
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

    // 3. Stale cache
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

