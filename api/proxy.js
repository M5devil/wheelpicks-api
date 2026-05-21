// WheelPicks API Proxy — Vercel Serverless Function
// Vercel IPs are not blocked by Yahoo Finance unlike AWS/Supabase

const GEMINI_KEY   = process.env.GEMINI_KEY   || "AIzaSyDgHKgm3Xk3aU8IFrWgFSjGKVS3_QELl1U";
const SUPABASE_URL = process.env.SUPABASE_URL  || "https://qpcugczsqsjnodlgdver.supabase.co";
const SERVICE_KEY  = process.env.SERVICE_KEY   || "sb_secret_-Gklon3IGgPk70DZ5f9EUw_bEY5xH78";
const REST         = `${SUPABASE_URL}/rest/v1`;

const OPTIONS_TTL_MS = 4 * 60 * 60 * 1000;  // 4 hours
const QUOTES_TTL_MS  = 5 * 60 * 1000;        // 5 minutes

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
};

const DB_HEADERS = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── Supabase REST helpers ──────────────────────────────────

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

// ── Yahoo helpers ──────────────────────────────────────────

async function fetchYahooOptions(ticker, expTs) {
  for (const q of ["query1", "query2"]) {
    const url = expTs
      ? `https://${q}.finance.yahoo.com/v7/finance/options/${ticker}?date=${expTs}`
      : `https://${q}.finance.yahoo.com/v7/finance/options/${ticker}`;
    try {
      const r = await fetch(url, { headers: YAHOO_HEADERS });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.optionChain?.result?.length > 0) return j;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function fetchYahooQuote(ticker) {
  for (const q of ["query1", "query2"]) {
    try {
      const r = await fetch(
        `https://${q}.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`,
        { headers: YAHOO_HEADERS }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) return { json: j, price: parseFloat(price.toFixed(2)) };
    } catch (_) {}
  }
  return null;
}

// ── Main handler ───────────────────────────────────────────

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    return res.status(200).end();
  }

  // Set CORS on all responses
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const { ticker = "", type = "quote", exp = "" } = req.query;

  try {

    // ── Gemini AI ────────────────────────────────────────────
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

    // ── Quote ─────────────────────────────────────────────────
    if (type === "quote") {
      // 1. Cache
      const cached = await getCachedQuote(ticker);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json({
          chart: { result: [{ meta: { regularMarketPrice: cached } }] }
        });
      }
      // 2. Live
      const result = await fetchYahooQuote(ticker);
      if (result) {
        upsertQuote(ticker, result.price);
        res.setHeader("X-Cache", "MISS");
        return res.status(200).json(result.json);
      }
      return res.status(200).json({ chart: { result: [] } });
    }

    // ── News ──────────────────────────────────────────────────
    if (type === "news") {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}&newsCount=5&quotesCount=0`,
        { headers: YAHOO_HEADERS }
      );
      return res.status(200).json(await r.json());
    }

    // ── Options chain ─────────────────────────────────────────
    const expTs = exp ? parseInt(exp) : 0;

    // 1. Fresh cache
    const fresh = await getCachedOptions(ticker, expTs);
    if (fresh) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).json(fresh);
    }

    // 2. Live fetch (Vercel IPs work with Yahoo)
    const live = await fetchYahooOptions(ticker, expTs > 0 ? String(expTs) : undefined);
    if (live) {
      upsertOptions(ticker, expTs, live);
      if (expTs > 0) upsertOptions(ticker, 0, live);
      res.setHeader("X-Cache", "MISS");
      res.setHeader("Cache-Control", "public, max-age=300");
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
