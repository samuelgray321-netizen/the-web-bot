/**
 * swaplog.js — the rotation-edge meter
 * ------------------------------------
 * Clips onto the engine without touching trade logic. Answers ONE question,
 * on real prices, honestly:
 *
 *   Does the asset you rotate INTO subsequently beat the one you rotated OUT of,
 *   measured FORWARD, marked to market, net of fees — often enough to be net positive?
 *
 * Three honesty guards (each a previously-found mirage-killer):
 *   1) FORWARD-measured  — scores the rotated-out asset on what it does AFTER the swap,
 *      never the gain it already made before. (That pre-swap gain is the booking illusion.)
 *   2) MARKED TO MARKET  — every swap is settled at a fixed forward horizon using live
 *      prices, losers included. No realised-only cherry-picking.
 *   3) SPLIT tethered vs untethered — displacement only predicts reversion inside the
 *      genuine web. If untethered also reads positive, a leak is still hiding. Prediction:
 *      tethered mean > 0, untethered mean ~ 0.
 *
 * Persists to a JSON file so SSH/Railway restarts lose nothing.
 *
 * IMPORTANT: set HORIZON_MIN once and never change it mid-run, or the test self-corrupts.
 */

const fs = require("fs");
const PATH = process.env.SWAPLOG_PATH || "./swaplog.json";
const HORIZON_MIN = 60;          // forward horizon in minutes — SET ONCE, NEVER CHANGE
const FEE = 0.0005;              // per-leg fee assumption, matches engine

let state = { pending: [], settled: [] };
try { state = JSON.parse(fs.readFileSync(PATH, "utf8")); } catch { /* fresh start */ }

function save() {
  try { fs.writeFileSync(PATH, JSON.stringify(state)); }
  catch (e) { console.error("swaplog save error:", e.message); }
}

/**
 * Call this at the EXACT moment the engine rotates a slot:
 * it dropped `assetOut` (was held) and took on `assetIn`.
 *  - side: "long" or "short" (which slot rotated)
 *  - priceOut / priceIn: current prices of each at the swap instant
 *  - tethered: boolean — is the NEW position a genuinely tethered pair?
 */
function logSwap({ pairKey, side, assetOut, assetIn, priceOut, priceIn, tethered }) {
  state.pending.push({
    pairKey, side, assetOut, assetIn,
    priceOut, priceIn,
    tethered: !!tethered,
    swappedAt: Date.now(),
  });
  save();
}

/**
 * Call on a timer. For every pending swap older than the horizon, read CURRENT
 * prices of both assets and book the forward result:
 *
 *   fwd_out = return the rotated-OUT asset would have made if KEPT (in its held direction)
 *   fwd_in  = return the rotated-IN asset ACTUALLY made (in its held direction)
 *   swap_value = fwd_in - fwd_out - fee
 *
 * Positive swap_value means the rotation beat staying put. We want the mean of these,
 * split by tethered, to be positive net of fees.
 *
 * getPrice(symbol) -> current price (number) or null if unavailable.
 */
function settle(getPrice) {
  const now = Date.now();
  const horizonMs = HORIZON_MIN * 60 * 1000;
  const keep = [];
  for (const s of state.pending) {
    if (now - s.swappedAt < horizonMs) { keep.push(s); continue; }
    const pOutNow = getPrice(s.assetOut);
    const pInNow = getPrice(s.assetIn);
    if (pOutNow == null || pInNow == null) { keep.push(s); continue; } // try again later

    // direction sign: long slot profits when price rises, short slot when it falls
    const sign = s.side === "long" ? 1 : -1;
    const fwdOut = sign * (pOutNow / s.priceOut - 1);   // what keeping the old asset would have earned
    const fwdIn  = sign * (pInNow / s.priceIn - 1);     // what the new asset actually earned
    const swapValue = fwdIn - fwdOut - 2 * FEE;          // net of the round-trip fee of swapping

    state.settled.push({ tethered: s.tethered, swapValue, pairKey: s.pairKey });
  }
  state.pending = keep;
  save();
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

/** Print the running verdict. */
function report() {
  const all = state.settled;
  const teth = all.filter(x => x.tethered).map(x => x.swapValue);
  const unte = all.filter(x => !x.tethered).map(x => x.swapValue);
  const mAll = mean(all.map(x => x.swapValue));
  const mTeth = mean(teth);
  const mUnte = mean(unte);
  console.log("──────── SWAPLOG VERDICT ────────");
  console.log(`settled swaps: ${all.length} (pending ${state.pending.length})`);
  console.log(`  ALL        mean swap-value: ${mAll === null ? "—" : (mAll * 100).toFixed(4) + "%"}`);
  console.log(`  TETHERED   mean swap-value: ${mTeth === null ? "—" : (mTeth * 100).toFixed(4) + "%"}  (${teth.length})  <- the one that matters`);
  console.log(`  UNTETHERED mean swap-value: ${mUnte === null ? "—" : (mUnte * 100).toFixed(4) + "%"}  (${unte.length})  <- must sit near zero`);
  console.log("  Read: rotation has a real edge ONLY if TETHERED is clearly positive");
  console.log("        AND untethered is ~zero. If untethered is also positive, a leak remains.");
  console.log("─────────────────────────────────");
}

module.exports = { logSwap, settle, report };
