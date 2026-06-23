/**
 * THE WEB — live paper-trading bot (Alpaca paper)
 * ------------------------------------------------
 * Pairs / relative-value engine. Watches every pair among a set of liquid,
 * shortable stocks. Freezes each pair's "normal" relationship from a formation
 * window (a FIXED anchor that does NOT chase price — this is what keeps wins
 * honest). When a pair's spread stretches past ENTER sigma, it holds BOTH legs
 * (long the cheap one, short the dear one) and closes when the spread snaps back
 * to the frozen mean (EXIT) or stops out (STOP).
 *
 * SAFETY:
 *  - Paper endpoint is hardcoded. It cannot touch a live-money account.
 *  - Formation period before any order is placed.
 *  - Max open spreads, fixed notional per leg, and an equity circuit breaker.
 *  - Keys come from environment variables (set them in Railway, never in code).
 *
 * EXPECT LOSING TRADES. On real prices, some "linked" pairs genuinely break
 * apart. That is the honest test. The guardrails keep each loss small.
 */

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;

// Hardcoded PAPER endpoints — cannot trade real money.
const swaplog = require("./swaplog");
const TRADE_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE  = "https://data.alpaca.markets";

if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.error("MISSING KEYS. Set ALPACA_KEY and ALPACA_SECRET in Railway → Variables.");
  process.exit(1);
}

// ── ONE-TIME HISTORY FETCH MODE ───────────────────────────────────────────
// Set env var FETCH_HISTORY=1 in Railway to download & print real historical
// prices (then it exits — no trading). Remove the var to run the bot normally.
if (process.env.FETCH_HISTORY === "1") {
  const SYMS = ["JPM","GS","BAC","WFC","C","XOM","CVX","COP","SLB","EOG","KO","PEP","MDLZ","CL","PG","AAPL","MSFT","NVDA","GOOGL","META","WMT","TGT","COST","HD","LOW","UNH","CVS","PFE","MRK","ABBV","AMD","INTC","TXN","QCOM","MU","CAT","DE","BA","GE","HON"];
  const HH = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };
  (async () => {
    for (const s of SYMS) {
      const bars = []; let token = null;
      do {
        const u = new URL("https://data.alpaca.markets/v2/stocks/" + s + "/bars");
        u.searchParams.set("timeframe","1Day"); u.searchParams.set("start","2023-01-01"); u.searchParams.set("end","2025-12-31");
        u.searchParams.set("limit","10000"); u.searchParams.set("adjustment","all");
        if (token) u.searchParams.set("page_token", token);
        const r = await fetch(u, { headers: HH });
        if (!r.ok) { console.error(s + ": " + r.status); break; }
        const d = await r.json();
        if (d.bars) for (const b of d.bars) bars.push([b.t.slice(0,10), +b.c.toFixed(2)]);
        token = d.next_page_token;
      } while (token);
      console.log("===A:" + s + "===");
      console.log(JSON.stringify(bars));
      console.log("===E:" + s + "===");
      await new Promise(r => setTimeout(r, 150));
    }
    console.error("ALL DONE — 40 assets printed. Upload the log file.");
    process.exit(0);
  })();
} else {

// ── CONFIG ────────────────────────────────────────────────────────────────
// Liquid, shortable large-caps grouped into linked families.
// Pairs WITHIN a family share real economic forces (more likely to revert).
// The engine watches ALL pairs but you'll see the edge concentrate on linked ones.
const SYMBOLS = [
  "JPM","GS","BAC",    // banks
  "XOM","CVX","COP",   // energy
  "KO","PEP","MDLZ",   // consumer staples
];

const POLL_MS      = 60_000;   // check prices once a minute (respects free data limits)
const FORMATION    = 60;       // bars to observe before trading (60 min ≈ 1 hour warm-up)
const REFORM_EVERY = 600;      // re-freeze anchors every 600 bars (~10h of market data)
const ENTER_Z      = 2.0;      // stretch needed to open
const EXIT_Z       = 0.5;      // snap-back to close (profit)
const STOP_Z       = 3.5;      // diverged further — cut the loss
const MAX_SPREADS  = 3;        // max simultaneous pairs held
const NOTIONAL     = 200;      // $ per leg (paper). Two legs = $400 gross per spread.
const BREAKER_LOSS = 0.10;     // halt new trades if equity drops 10% from start

// ── STATE ─────────────────────────────────────────────────────────────────
const PAIRS = [];
for (let i = 0; i < SYMBOLS.length; i++)
  for (let j = i + 1; j < SYMBOLS.length; j++)
    PAIRS.push({ a: SYMBOLS[i], b: SYMBOLS[j], key: SYMBOLS[i] + "/" + SYMBOLS[j] });

const hist   = {};   // key -> array of recent log-ratios
const anchor = {};   // key -> { mean, sd, setAt, valid }
for (const p of PAIRS) { hist[p.key] = []; anchor[p.key] = { mean: 0, sd: 0, setAt: -1, valid: false }; }

let bars = 0;
let startEquity = null;
let breakerTripped = false;
// open spreads: { key, longSym, shortSym, qtyLong, qtyShort, openBar }
let open = [];

// ── ALPACA HELPERS ──────────────────────────────────────────────────────────
const headers = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type": "application/json",
};

async function getAccount() {
  const r = await fetch(`${TRADE_BASE}/v2/account`, { headers });
  if (!r.ok) throw new Error(`account ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getPrices() {
  // latest trade price for each symbol
  const url = `${DATA_BASE}/v2/stocks/trades/latest?symbols=${SYMBOLS.join(",")}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`prices ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const out = {};
  for (const s of SYMBOLS) {
    const t = data.trades && data.trades[s];
    if (t && t.p) out[s] = t.p;
  }
  return out;
}

async function submitOrder(symbol, side, qty) {
  const body = JSON.stringify({ symbol, qty: String(qty), side, type: "market", time_in_force: "day" });
  const r = await fetch(`${TRADE_BASE}/v2/orders`, { method: "POST", headers, body });
  const txt = await r.text();
  if (!r.ok) { console.error(`  ✗ order failed ${symbol} ${side} x${qty}: ${r.status} ${txt}`); return null; }
  console.log(`  ✓ ${side.toUpperCase()} ${qty} ${symbol}`);
  return JSON.parse(txt);
}

// ── ENGINE MATH ──────────────────────────────────────────────────────────────
function logRatio(prices, p) {
  if (!prices[p.a] || !prices[p.b]) return null;
  return Math.log(prices[p.a] / prices[p.b]);
}
const MIN_SD = 0.0015;  // a pair's log-ratio must wobble at least this much to be tradeable.
                        // Guards against divide-by-near-zero producing garbage z-scores.
function freeze(p) {
  const h = hist[p.key];
  if (h.length < FORMATION) return;
  const m = h.reduce((x, y) => x + y, 0) / h.length;
  let v = 0; for (const x of h) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / h.length);
  // If the spread barely moves, its sd is unreliable — don't trust/trade this pair.
  if (sd < MIN_SD) { anchor[p.key] = { mean: m, sd, setAt: bars, valid: false }; return; }
  anchor[p.key] = { mean: m, sd, setAt: bars, valid: true };
}
function zscore(prices, p) {
  const a = anchor[p.key];
  if (!a.valid) return null;
  const r = logRatio(prices, p);
  if (r === null) return null;
  const z = (r - a.mean) / Math.max(a.sd, MIN_SD);   // real floor, not 1e-9
  if (!isFinite(z) || Math.abs(z) > 50) return null;  // sanity cap — reject impossible z-scores
  return z;
}

// ── MAIN LOOP ──────────────────────────────────────────────────────────────

// ── SHADOW ROTATION (measure-only; does NOT change trading) ───────────────────
// Family map: same sector = genuinely linked. Used only to tag swaps tethered/untethered.
const FAMILY = {};
SYMBOLS.forEach((s, i) => { FAMILY[s] = Math.floor(i / 3); }); // groups of 3 in the list
function pairTethered(a, b) { return FAMILY[a] === FAMILY[b]; }

// Each bar, for every OPEN pair, ask: is there a clearly-better candidate pair that
// shares NEITHER symbol? If so, that's a hypothetical rotation — log it (don't act).
// "Clearly better" = candidate |z| exceeds the held pair's |z| by a margin.
const SWITCH_MARGIN = 1.0;
function shadowRotations(prices) {
  for (const o of open) {
    const heldPair = PAIRS.find(x => x.key === o.key);
    const heldZ = Math.abs(zscore(prices, heldPair) || 0);
    // find best candidate not sharing a symbol with this held pair
    let best = null;
    for (const p of PAIRS) {
      if (p.key === o.key) continue;
      if (p.a === o.longSym || p.a === o.shortSym || p.b === o.longSym || p.b === o.shortSym) continue;
      const z = zscore(prices, p);
      if (z === null) continue;
      if (!best || Math.abs(z) > best.az) best = { p, z, az: Math.abs(z) };
    }
    if (best && best.az >= heldZ + SWITCH_MARGIN) {
      // hypothetical: rotate the LONG slot from o.longSym -> best's cheap leg
      const newLong  = best.z > 0 ? best.p.b : best.p.a;
      const newShort = best.z > 0 ? best.p.a : best.p.b;
      if (prices[o.longSym] && prices[newLong]) {
        swaplog.logSwap({
          pairKey: o.key + "->" + best.p.key, side: "long",
          assetOut: o.longSym, assetIn: newLong,
          priceOut: prices[o.longSym], priceIn: prices[newLong],
          tethered: pairTethered(newLong, newShort),
        });
      }
    }
  }
}

async function tick() {
  try {
    let prices;
    try { prices = await getPrices(); }
    catch (e) { console.error("price fetch error:", e.message); return; }

    const haveAll = SYMBOLS.every(s => prices[s]);
    if (!haveAll) { console.log(`bar ${bars}: market likely closed / partial data — waiting`); return; }

    bars++;

    // update histories
    for (const p of PAIRS) {
      const r = logRatio(prices, p);
      if (r !== null) { hist[p.key].push(r); if (hist[p.key].length > FORMATION) hist[p.key].shift(); }
    }

    // (re)freeze anchors when due, but never while that pair is open
    if (bars >= FORMATION) {
      for (const p of PAIRS) {
        const a = anchor[p.key];
        const held = open.some(o => o.key === p.key);
        if (!held && (!a.valid || bars - a.setAt >= REFORM_EVERY)) freeze(p);
      }
    }

    // circuit breaker
    let equity = startEquity;
    try { const acct = await getAccount(); equity = parseFloat(acct.equity); if (startEquity === null) startEquity = equity; }
    catch (e) { console.error("account error:", e.message); }
    if (startEquity !== null && equity <= startEquity * (1 - BREAKER_LOSS) && !breakerTripped) {
      breakerTripped = true;
      console.log(`🛑 CIRCUIT BREAKER — equity ${equity} down ${BREAKER_LOSS*100}% from ${startEquity}. No new spreads.`);
    }

    if (bars < FORMATION) { console.log(`bar ${bars}/${FORMATION}: warming up, no trades yet`); return; }

    // EXITS
    const stillOpen = [];
    for (const o of open) {
      const p = PAIRS.find(x => x.key === o.key);
      const z = zscore(prices, p);
      if (z === null) { stillOpen.push(o); continue; }
      const az = Math.abs(z);
      let reason = null;
      if (az <= EXIT_Z) reason = "SNAP-BACK (profit target)";
      else if (az >= STOP_Z) reason = "STOP (diverged further)";
      if (reason) {
        console.log(`CLOSE ${o.key} — ${reason} (z=${z.toFixed(2)})`);
        await submitOrder(o.longSym, "sell", o.qtyLong);   // unwind long
        await submitOrder(o.shortSym, "buy", o.qtyShort);  // cover short
      } else stillOpen.push(o);
    }
    open = stillOpen;

    // ENTRIES
    if (!breakerTripped) {
      const cands = [];
      for (const p of PAIRS) {
        if (open.some(o => o.key === p.key)) continue;
        const z = zscore(prices, p);
        if (z === null) continue;
        if (Math.abs(z) >= ENTER_Z) cands.push({ p, z, az: Math.abs(z) });
      }
      cands.sort((x, y) => y.az - x.az);
      for (const c of cands) {
        if (open.length >= MAX_SPREADS) break;
        // don't reuse a symbol already tied up in an open spread
        const used = new Set(open.flatMap(o => [o.longSym, o.shortSym]));
        if (used.has(c.p.a) || used.has(c.p.b)) continue;
        // z>0: ratio above normal => a is dear, b is cheap => short a, long b
        const longSym  = c.z > 0 ? c.p.b : c.p.a;
        const shortSym = c.z > 0 ? c.p.a : c.p.b;
        const qtyLong  = Math.max(1, Math.floor(NOTIONAL / prices[longSym]));
        const qtyShort = Math.max(1, Math.floor(NOTIONAL / prices[shortSym]));
        console.log(`OPEN ${c.p.key} — long ${longSym} / short ${shortSym} (z=${c.z.toFixed(2)})`);
        const o1 = await submitOrder(longSym, "buy", qtyLong);
        const o2 = await submitOrder(shortSym, "sell", qtyShort);
        if (o1 && o2) open.push({ key: c.p.key, longSym, shortSym, qtyLong, qtyShort, openBar: bars });
      }
    }

    shadowRotations(prices);
    console.log(`bar ${bars} | equity ${equity?.toFixed?.(2) ?? "?"} | open spreads ${open.length} | ${new Date().toISOString()}`);
  } catch (e) {
    console.error("tick error:", e.message);
  }
}

console.log("THE WEB — Alpaca PAPER pairs bot starting");
console.log(`Symbols: ${SYMBOLS.join(", ")}  |  ${PAIRS.length} pairs watched`);
console.log(`Warm-up ${FORMATION} bars, poll every ${POLL_MS/1000}s, ENTER ${ENTER_Z}σ EXIT ${EXIT_Z}σ STOP ${STOP_Z}σ`);
console.log("Paper endpoint hardcoded — cannot trade real money.\n");

tick();
setInterval(tick, POLL_MS);

// settle matured shadow swaps + print the verdict every 5 minutes
setInterval(async () => {
  try {
    const prices = await getPrices();
    swaplog.settle(sym => prices[sym] ?? null);
    swaplog.report();
  } catch (e) { console.error("swaplog settle error:", e.message); }
}, 5 * 60 * 1000);

} // end of normal-bot mode (FETCH_HISTORY not set)
