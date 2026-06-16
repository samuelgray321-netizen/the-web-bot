/**
 * THE WEB — live paper-trading bot (Alpaca paper)
 * Pairs / relative-value engine. Frozen anchor (no chasing). Paper only.
 */

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;

const TRADE_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE  = "https://data.alpaca.markets";

if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.error("MISSING KEYS. Set ALPACA_KEY and ALPACA_SECRET in Railway Variables.");
  process.exit(1);
}

const SYMBOLS = [
  "JPM","GS","BAC",
  "XOM","CVX","COP",
  "KO","PEP","MDLZ",
];

const POLL_MS      = 60000;
const FORMATION    = 60;
const REFORM_EVERY = 600;
const ENTER_Z      = 2.0;
const EXIT_Z       = 0.5;
const STOP_Z       = 3.5;
const MAX_SPREADS  = 3;
const NOTIONAL     = 200;
const BREAKER_LOSS = 0.10;

const PAIRS = [];
for (let i = 0; i < SYMBOLS.length; i++)
  for (let j = i + 1; j < SYMBOLS.length; j++)
    PAIRS.push({ a: SYMBOLS[i], b: SYMBOLS[j], key: SYMBOLS[i] + "/" + SYMBOLS[j] });

const hist = {};
const anchor = {};
for (const p of PAIRS) { hist[p.key] = []; anchor[p.key] = { mean: 0, sd: 0, setAt: -1, valid: false }; }

let bars = 0;
let startEquity = null;
let breakerTripped = false;
let open = [];

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
  if (!r.ok) { console.error(`  order failed ${symbol} ${side} x${qty}: ${r.status} ${txt}`); return null; }
  console.log(`  ${side.toUpperCase()} ${qty} ${symbol}`);
  return JSON.parse(txt);
}

function logRatio(prices, p) {
  if (!prices[p.a] || !prices[p.b]) return null;
  return Math.log(prices[p.a] / prices[p.b]);
}
function freeze(p) {
  const h = hist[p.key];
  if (h.length < FORMATION) return;
  const m = h.reduce((x, y) => x + y, 0) / h.length;
  let v = 0; for (const x of h) v += (x - m) * (x - m);
  anchor[p.key] = { mean: m, sd: Math.sqrt(v / h.length), setAt: bars, valid: true };
}
function zscore(prices, p) {
  const a = anchor[p.key];
  if (!a.valid) return null;
  const r = logRatio(prices, p);
  if (r === null) return null;
  return (r - a.mean) / Math.max(a.sd, 1e-9);
}

async function tick() {
  try {
    let prices;
    try { prices = await getPrices(); }
    catch (e) { console.error("price fetch error:", e.message); return; }

    const haveAll = SYMBOLS.every(s => prices[s]);
    if (!haveAll) { console.log(`bar ${bars}: market closed / partial data - waiting`); return; }

    bars++;

    for (const p of PAIRS) {
      const r = logRatio(prices, p);
      if (r !== null) { hist[p.key].push(r); if (hist[p.key].length > FORMATION) hist[p.key].shift(); }
    }

    if (bars >= FORMATION) {
      for (const p of PAIRS) {
        const a = anchor[p.key];
        const held = open.some(o => o.key === p.key);
        if (!held && (!a.valid || bars - a.setAt >= REFORM_EVERY)) freeze(p);
      }
    }

    let equity = startEquity;
    try { const acct = await getAccount(); equity = parseFloat(acct.equity); if (startEquity === null) startEquity = equity; }
    catch (e) { console.error("account error:", e.message); }
    if (startEquity !== null && equity <= startEquity * (1 - BREAKER_LOSS) && !breakerTripped) {
      breakerTripped = true;
      console.log(`CIRCUIT BREAKER - equity ${equity} down from ${startEquity}. No new spreads.`);
    }

    if (bars < FORMATION) { console.log(`bar ${bars}/${FORMATION}: warming up, no trades yet`); return; }

    const stillOpen = [];
    for (const o of open) {
      const p = PAIRS.find(x => x.key === o.key);
      const z = zscore(prices, p);
      if (z === null) { stillOpen.push(o); continue; }
      const az = Math.abs(z);
      let reason = null;
      if (az <= EXIT_Z) reason = "SNAP-BACK";
      else if (az >= STOP_Z) reason = "STOP";
      if (reason) {
        console.log(`CLOSE ${o.key} - ${reason} (z=${z.toFixed(2)})`);
        await submitOrder(o.longSym, "sell", o.qtyLong);
        await submitOrder(o.shortSym, "buy", o.qtyShort);
      } else stillOpen.push(o);
    }
    open = stillOpen;

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
        const used = new Set(open.flatMap(o => [o.longSym, o.shortSym]));
        if (used.has(c.p.a) || used.has(c.p.b)) continue;
        const longSym  = c.z > 0 ? c.p.b : c.p.a;
        const shortSym = c.z > 0 ? c.p.a : c.p.b;
        const qtyLong  = Math.max(1, Math.floor(NOTIONAL / prices[longSym]));
        const qtyShort = Math.max(1, Math.floor(NOTIONAL / prices[shortSym]));
        console.log(`OPEN ${c.p.key} - long ${longSym} / short ${shortSym} (z=${c.z.toFixed(2)})`);
        const o1 = await submitOrder(longSym, "buy", qtyLong);
        const o2 = await submitOrder(shortSym, "sell", qtyShort);
        if (o1 && o2) open.push({ key: c.p.key, longSym, shortSym, qtyLong, qtyShort, openBar: bars });
      }
    }

    console.log(`bar ${bars} | equity ${equity} | open ${open.length} | ${new Date().toISOString()}`);
  } catch (e) {
    console.error("tick error:", e.message);
  }
}

console.log("THE WEB - Alpaca PAPER pairs bot starting");
console.log(`Symbols: ${SYMBOLS.join(", ")} | ${PAIRS.length} pairs watched`);
console.log("Paper endpoint hardcoded - cannot trade real money.");

tick();
setInterval(tick, POLL_MS);
