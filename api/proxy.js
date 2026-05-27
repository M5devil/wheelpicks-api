// WheelPicks API Proxy — Vercel Serverless Function
// Uses Yahoo Finance with crumb+cookie auth (same method as ArkPicks)

const GEMINI_KEY   = "AIzaSyBKNlHzm1eutQGNdGu6DrsvGXmlU7W_Nek";
const SUPABASE_URL = "https://qpcugczsqsjnodlgdver.supabase.co";
const SERVICE_KEY  = "sb_secret_-Gklon3IGgPk70DZ5f9EUw_bEY5xH78";
const REST         = `${SUPABASE_URL}/rest/v1`;

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

// ── Yahoo Finance crumb+cookie auth ────────────────────────

const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Cache crumb in memory for the lifetime of this serverless instance
let _crumb = null;
let _cookie = null;
let _crumbTs = 0;
const CRUMB_TTL = 30 * 60 * 1000; // 30 minutes

async function getYahooCrumb() {
  // Return cached crumb if still fresh
  if (_crumb && _cookie && (Date.now() - _crumbTs) < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }

  // Step 1: Get a Yahoo session cookie by visiting the consent page
  const consentUrl = "https://guce.yahoo.com/consent?brandType=nonEu&lang=en-US&intl=us";
  try {
    const consentRes = await fetch(consentUrl, {
      headers: {
        "User-Agent": YAHOO_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const rawCookies = consentRes.headers.get("set-cookie") || "";
    // Extract A1 or B cookie
    const cookieMatch = rawCookies.match(/(?:A1|B)=[^;]+/);
    if (cookieMatch) _cookie = cookieMatch[0];
  } catch (_) {}

  // Step 2: If no cookie yet, try a direct quote page visit
  if (!_cookie) {
    try {
      const quoteRes = await fetch("https://finance.yahoo.com/quote/AAPL", {
        headers: {
          "User-Agent": YAHOO_UA,
          "Accept": "text/html",
        },
        redirect: "follow",
      });
      const rawCookies = quoteRes.headers.get("set-cookie") || "";
      const cookieMatch = rawCookies.match(/(?:A1|B)=[^;]+/);
      if (cookieMatch) _cookie = cookieMatch[0];
    } catch (_) {}
  }

  // Step 3: Get crumb using the cookie
  const crumbHeaders = {
    "User-Agent": YAHOO_UA,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
    "Origin": "https://finance.yahoo.com",
  };
  if (_cookie) crumbHeaders["Cookie"] = _cookie;

  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
        headers: crumbHeaders,
      });
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 0 && !text.includes("Unauthorized")) {
          _crumb = text.trim();
          _crumbTs = Date.now();
          console.log(`Got Yahoo crumb: ${_crumb?.substring(0,8)}... cookie: ${!!_cookie}`);
          return { crumb: _crumb, cookie: _cookie };
        }
      }
    } catch (_) {}
  }

  console.log("Failed to get Yahoo crumb");
  return { crumb: null, cookie: _cookie };
}

async function yahooFetch(url, crumb, cookie) {
  const fullUrl = crumb ? `${url}${url.includes("?") ? "&" : "?"}crumb=${encodeURIComponent(crumb)}` : url;
  const headers = {
    "User-Agent": YAHOO_UA,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
    "Origin": "https://finance.yahoo.com",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  };
  if (cookie) headers["Cookie"] = cookie;

  for (const host of ["query1", "query2"]) {
    try {
      const hostUrl = fullUrl.replace(/query[12]/, host);
      const r = await fetch(hostUrl, { headers });
      if (r.ok) {
        const j = await r.json();
        // Check for auth errors
        if (j?.finance?.error?.code === "Unauthorized") continue;
        if (j?.optionChain?.error?.code === "Unauthorized") continue;
        return j;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
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
      const { crumb, cookie } = await getYahooCrumb();

      // Fetch price + market cap in parallel
      const [chartJson, summaryJson] = await Promise.all([
        yahooFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`, crumb, cookie),
        yahooFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,price`, crumb, cookie)
      ]);

      const price = chartJson?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) upsertQuote(ticker, parseFloat(price.toFixed(2)));

      // Extract market cap from quoteSummary
      const mcapRaw = summaryJson?.quoteSummary?.result?.[0]?.price?.marketCap?.raw || 0;
      const meta = chartJson?.chart?.result?.[0]?.meta || {};
      if (mcapRaw > 0) meta.marketCap = mcapRaw;

      // Return enriched response
      const response = chartJson || { chart: { result: [] } };
      if (response?.chart?.result?.[0]) response.chart.result[0].meta = meta;

      res.setHeader("X-Cache", "MISS");
      return res.status(200).json(response);
    }

    // ── News ───────────────────────────────────────────────
    if (type === "news") {
      const { crumb, cookie } = await getYahooCrumb();
      const json = await yahooFetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}&newsCount=5&quotesCount=0`,
        crumb, cookie
      );
      return res.status(200).json(json || { news: [] });
    }

    // ── Options chain ──────────────────────────────────────
    const expTs = exp ? parseInt(exp) : 0;

    // 1. Fresh cache
    const fresh = await getCachedOptions(ticker, expTs);
    if (fresh) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(fresh);
    }

    // 2. Live from Yahoo with crumb auth
    const { crumb, cookie } = await getYahooCrumb();
    const baseUrl = expTs > 0
      ? `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${expTs}`
      : `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`;

    const live = await yahooFetch(baseUrl, crumb, cookie);
    const hasData = live?.optionChain?.result?.length > 0 &&
      (live.optionChain.result[0].options?.[0]?.puts?.length > 0 ||
       live.optionChain.result[0].options?.[0]?.calls?.length > 0);

    if (hasData) {
      upsertOptions(ticker, expTs, live);
      if (expTs > 0) upsertOptions(ticker, 0, live);
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
    console.error("Handler error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
