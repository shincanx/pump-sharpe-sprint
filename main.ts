// Pump.fun Sharpe Sprint — early momentum, one shot per coin (v5: pyramid up).
//
// Lessons from v1-v3 (grade-local):
//  - v1 (buy after +30% pump, TP +25%): Sharpe -0.59, win rate 34%. Buying
//    after the pump is buying the top; the remaining upside rarely covers
//    the 2.5% round-trip fees plus the bleed.
//  - v2 (enter early + scale in, TP +50%): Sharpe -0.63, win rate 19%.
//    Scaling in while the price was merely "below 2x create" averaged DOWN
//    into losers, the +50% take-profit almost never fired, and 2,527 fills
//    bled 1.59 SOL of curve fees plus 0.27 SOL of tx fees.
//  - v3 (entry age <=300 slots, >=8 trades, buy share >=75%, momentum
//    >=+10%/3 trades, TP +35%): only 5 round trips on the whole dev set —
//    the gates were so strict the bot barely traded and failed the
//    >=20 distinct mints guardrail.
//  - v4 (the config below minus pyramiding): grade-local -0.039 SOL,
//    Sharpe -0.071, 102 trips / 97 distinct, win rate 19.6%.
//    20 wins (+0.234 SOL) vs 79 losses (-0.273 SOL); the -7% stop capped
//    losses (worst -0.009 SOL) but there were simply too many small
//    losers for the winners to pay for. Gross trading PnL was +0.061 SOL,
//    fees -0.100 SOL. The offline simulator had predicted +0.045 SOL for
//    this config, so the sim is optimistic by ~0.08 SOL (own market
//    impact, which the sim ignores, plus fill-timing details) — sim
//    rankings are indicative only; grade-local is the ground truth.
//  - v5 therefore pyramids UP: once a position is +12% over its average
//    cost, add the same size again (max 2 adds), so the winners that pay
//    for the 80% of trips that bleed to the stop carry 2-3x the size,
//    while losers never get an add. Adds never create a new position
//    (same mint), never reset the 300-slot time exit, and never move the
//    trailing-stop peak. Grade-local v5: +0.054 SOL, Sharpe +0.060,
//    102 trips / 97 distinct — the pyramid flipped v4's -0.039 SOL.
//  - v6/v7 tuning on grade-local (ground truth, ~30 s per run):
//    buy share 70% (vs 72%) is indistinguishable on this data
//    (102 trips, +0.058 SOL, Sharpe +0.064) and is kept; momentum 1.02
//    (vs 1.04) adds 40 trips (142 total, 135 distinct) but they are
//    losers — net -0.023 SOL, Sharpe -0.024 — so momentum stays at 1.04.
//    Final grade-local (this code): +0.058 SOL, Sharpe +0.064,
//    Sortino +0.188, max drawdown 1.5%, 102 trips, 97 distinct mints,
//    constraints compliant. The edge is thin and the 6 h graded replay
//    (~25 expected trips) is a different window, so this is a
//    breakeven-plus bot, not a moonshot machine — but it is positive,
//    compliant, and deterministic on the dev set.
//
// Offline analysis that shaped v4 (dev window, 24 h, 1,123 mints):
//  - ~40% of young coins spike to >=1.5x within ~4 minutes, but ~72% bleed
//    below 0.97x if held that long. The spike is the whole game, and it is
//    over fast.
//  - Coins that eventually peaked >=2x had, in their first 10 trades:
//    median 6 slots for 10 trades (losers: 103), median max single buy
//    2.4 SOL (losers: 1.0), median buy share 90% (losers: 67%). But buying
//    AFTER the pump to 1.4-2.5x still loses in simulation: at 2 slots of
//    latency the fill lands past the peak and the move mean-reverts. The
//    edge, such as it is, sits in entering EARLY (price <1.3x create) on
//    strong buy flow, then letting a trailing stop ride the right tail.
//  - A fast offline simulator replicating the engine math (exact-in buy
//    split, 95+30 bps curve fees, 105k lamports/order tx fee, 2-slot fill
//    latency, hourly Sharpe from equity marks) swept ~60 configs. The
//    surviving family: buy share >=72%, momentum >=+4% over 3 trades,
//    real reserve >=1 SOL, age <=2400 slots, no fixed take-profit, trailing
//    stop armed at +30% with a 10% pullback exit, stop loss -7%, max hold
//    300 slots (~2 min). Full-window sim: +0.045 SOL net, Sharpe +0.07,
//    107 round trips / 98 distinct mints, max drawdown ~1%. Neighbouring
//    configs are also >=0, which is what matters: the edge is thin
//    (half-window splits are -0.04 / +0.06), so this is a breakeven-plus
//    bot, not a moonshot machine. 107 trips/24 h projects to ~27 distinct
//    mints in a 6 h replay, clearing the >=20 mint guardrail with margin;
//    the stricter variants (30 trips/24 h) would NOT clear it.
//  - No fixed take-profit: a +20-25% TP caps the winners that pay for the
//    75-80% of trips that bleed to the -7% stop. The trailing stop is the
//    only exit that lets a winner run while the stop loss and the 300-slot
//    time exit keep the bleed short. Many small, short, independent round
//    trips spread realized gains across the hours, which is what an hourly
//    Sharpe ratio rewards.
//  - No randomness, no clock, no environment reads: every decision is a
//    pure function of the slots and events the harness delivered, so the
//    two grading executions agree byte for byte.

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning
const BUY_LAMPORTS = 100_000_000n; // 0.10 SOL target; the 1% reserve cap binds first
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip guardrail floor
const MAX_OPEN = 5;
const MAX_HOLD_SLOTS = 300; // ~2 min at 0.4 s/slot
const COOLDOWN_SLOTS = 600; // wait after exiting a mint before re-entering it
const SLIPPAGE_BPS = 800;

// Entry: young, still cheap, and strongly buy-dominated right now.
const MAX_AGE_SLOTS = 2400; // ~16 min after creation
const MIN_TRADES = 5; // enough flow to judge
const MAX_ENTRY_PUMP_NUM = 13n; // price < create * 13/10
const MAX_ENTRY_PUMP_DEN = 10n;
const RECENT_WINDOW = 8; // last N trades examined for flow
const MIN_RECENT_BUY_SHARE_NUM = 70; // >= 70% buys in the recent window
const MIN_RECENT_BUY_SHARE_DEN = 100;
const MIN_MOMENTUM_NUM = 104n; // price now >= price 3 trades ago * 104/100
const MIN_MOMENTUM_DEN = 100n;
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // real SOL reserve >= 1 SOL

// Exit, measured against the position's average entry cost (cost_lamports
// per token held, fees included): no fixed take-profit (see header), stop
// loss, trailing stop.
const TAKE_PROFIT_NUM = 10000n; // effectively disabled; the trail rides winners
const TAKE_PROFIT_DEN = 100n;
const STOP_LOSS_NUM = 93n; // mark <= avg cost * 93/100
const STOP_LOSS_DEN = 100n;
const TRAIL_ARM_NUM = 130n; // trailing stop arms once mark >= avg cost * 130/100
const TRAIL_ARM_DEN = 100n;
const TRAIL_DROP_NUM = 90n; // ... then sell on a 10% pullback from the peak
const TRAIL_DROP_DEN = 100n;

// Pyramiding up: add to a winner (never to a loser).
const ADD_TRIGGER_NUM = 112n; // mark >= avg cost * 112/100
const ADD_TRIGGER_DEN = 100n;
const MAX_ADDS = 2; // at most 2 adds per coin (3 buys total)
const ADD_MIN_GAP_SLOTS = 60; // at least ~24 s between adds
const ADD_MIN_AGE_SLOTS = 30; // first add no sooner than ~12 s after entry

// ------------------------------------------------------------------ helpers
// Compare two prices (quote/token ratios) without floats: a/b > c/d iff a*d > c*b.
function priceGte(q1: bigint, t1: bigint, q2: bigint, t2: bigint, num: bigint, den: bigint): boolean {
  // is q1/t1 >= (q2/t2) * (num/den) ?
  return q1 * t2 * den >= q2 * t1 * num;
}
function priceLte(q1: bigint, t1: bigint, q2: bigint, t2: bigint, num: bigint, den: bigint): boolean {
  return q1 * t2 * den <= q2 * t1 * num;
}

// ------------------------------------------------------------------ per-coin state
interface Coin {
  mint: string;
  createdSlot: number;
  createQ: bigint;
  createT: bigint;
  lastQ: bigint;
  lastT: bigint;
  trades: number;
  recent: { q: bigint; t: bigint; buy: boolean }[];
  lastTradeSlot: number;
  complete: boolean;
  cooldownUntil: number;
}

interface Held {
  mint: string;
  peakQ: bigint;
  peakT: bigint;
  buySlot: number;
  sellPending: boolean;
  adds: number;
  lastAddSlot: number;
}

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();

function trackCreate(mint: string, slot: number, vq: bigint, vt: bigint): void {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      mint,
      createdSlot: slot,
      createQ: vq,
      createT: vt,
      lastQ: vq,
      lastT: vt,
      trades: 0,
      recent: [],
      lastTradeSlot: slot,
      complete: false,
      cooldownUntil: 0,
    };
    coins.set(mint, c);
  }
}

function trackTrade(mint: string, slot: number, vq: bigint, vt: bigint, isBuy: boolean): void {
  let c = coins.get(mint);
  if (c === undefined) {
    // First sight is a trade, not a create: seed the create price from this trade.
    c = {
      mint,
      createdSlot: slot,
      createQ: vq,
      createT: vt,
      lastQ: vq,
      lastT: vt,
      trades: 0,
      recent: [],
      lastTradeSlot: slot,
      complete: false,
      cooldownUntil: 0,
    };
    coins.set(mint, c);
  }
  c.lastQ = vq;
  c.lastT = vt;
  c.lastTradeSlot = slot;
  c.trades += 1;
  c.recent.push({ q: vq, t: vt, buy: isBuy });
  if (c.recent.length > RECENT_WINDOW) c.recent.shift();
}

function recentBuyShare(c: Coin): number {
  if (c.recent.length === 0) return 0;
  let buys = 0;
  for (const r of c.recent) if (r.buy) buys += 1;
  return buys / c.recent.length;
}

function hasMomentum(c: Coin): boolean {
  // Price now vs the price 3 trades ago (or the oldest recent one we have).
  const n = c.recent.length;
  if (n < 3) return false;
  const old = c.recent[n - 3]!;
  return priceGte(c.lastQ, c.lastT, old.q, old.t, MIN_MOMENTUM_NUM, MIN_MOMENTUM_DEN);
}

function isEntryCandidate(state: BotState, c: Coin, slot: number): boolean {
  if (c.complete) return false;
  if (slot < c.cooldownUntil) return false;
  if (slot - c.createdSlot > MAX_AGE_SLOTS) return false;
  if (c.trades < MIN_TRADES) return false;
  if (held.has(c.mint)) return false;
  if (state.positions.has(c.mint)) return false;
  // Still cheap: below 1.3x its create price.
  if (!priceLte(c.lastQ, c.lastT, c.createQ, c.createT, MAX_ENTRY_PUMP_NUM, MAX_ENTRY_PUMP_DEN)) return false;
  // Recent flow strongly buy-dominated and still rising fast.
  if (recentBuyShare(c) * MIN_RECENT_BUY_SHARE_DEN < MIN_RECENT_BUY_SHARE_NUM) return false;
  if (!hasMomentum(c)) return false;
  // Big enough real reserve that a real buy fits the 1% size cap.
  const curve = state.curves.get(c.mint);
  if (curve === undefined) return false;
  if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) return false;
  if (state.maxBuyLamports(c.mint) < MIN_BUY_LAMPORTS) return false;
  return true;
}

// ------------------------------------------------------------------ the bot
await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // Fold this batch's fills back into held: a filled sell closes the
    // position record, a rejected/failed sell frees it for a retry, and a
    // rejected/failed buy frees the mint for a later retry.
    for (const f of batch.fills) {
      const c = coins.get(f.mint);
      if (f.side === 'buy' && f.status !== 'filled') {
        // A rejected FIRST buy frees the mint; a rejected ADD must not
        // drop the held record of the live position behind it.
        if (!state.positions.has(f.mint)) {
          held.delete(f.mint);
          if (c !== undefined) c.cooldownUntil = slot + COOLDOWN_SLOTS;
        }
      } else if (f.side === 'sell' && f.status === 'filled') {
        held.delete(f.mint);
        if (c !== undefined) c.cooldownUntil = slot + COOLDOWN_SLOTS;
      } else if (f.side === 'sell' && f.status !== 'filled') {
        const h = held.get(f.mint);
        if (h !== undefined) h.sellPending = false;
      }
    }

    // Fold this batch's events into per-coin state.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        trackCreate(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      } else if (e.event === 'TradeEvent') {
        trackTrade(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves), e.is_buy);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }

    // --- exits first: free slots before we consider new entries. Exits are
    // measured against the position's average entry cost (cost per token).
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let h = held.get(mint);
      if (h !== undefined && h.sellPending) continue;
      if (h === undefined) {
        // Position without a held record: anchor it at the current price so
        // the time exit still fires.
        h = {
          mint,
          peakQ: curve.virtual_quote_reserves,
          peakT: curve.virtual_token_reserves,
          buySlot: slot,
          sellPending: false,
          adds: 0,
          lastAddSlot: 0,
        };
        held.set(mint, h);
        continue;
      }
      const cost = pos.cost_lamports; // bigint SOL spent, fees included
      const tokens = pos.token_amount; // bigint tokens held
      const q = curve.virtual_quote_reserves;
      const t = curve.virtual_token_reserves;
      // Keep the peak mark current.
      if (q * h.peakT > h.peakQ * t) {
        h.peakQ = q;
        h.peakT = t;
      }
      // mark >= avgCost * num/den  <=>  q/t >= (cost/tokens) * num/den
      //   <=> q * tokens * den >= cost * t * num
      const tp = q * tokens * TAKE_PROFIT_DEN >= cost * t * TAKE_PROFIT_NUM;
      const sl = q * tokens * STOP_LOSS_DEN <= cost * t * STOP_LOSS_NUM;
      const timedOut = slot - h.buySlot >= MAX_HOLD_SLOTS;
      // Trailing stop: armed once the peak mark is +30% over avg cost, fires
      // on a 10% pullback from that peak.
      const peakVsCost = h.peakQ * tokens * TRAIL_ARM_DEN >= cost * h.peakT * TRAIL_ARM_NUM;
      const trailHit = peakVsCost && q * h.peakT * TRAIL_DROP_DEN <= h.peakQ * t * TRAIL_DROP_NUM;
      if (tp || sl || timedOut || trailHit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        h.sellPending = true;
      }
    }

    // --- pyramiding: add to winners only. Same size as the first buy,
    // capped at 1% of real reserve like every order. An add does not
    // create a new position and does not reset the time exit or the peak.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= 16) break;
      const h = held.get(mint);
      if (h === undefined || h.sellPending) continue;
      if (h.adds >= MAX_ADDS) continue;
      if (slot - h.buySlot < ADD_MIN_AGE_SLOTS) continue;
      if (h.lastAddSlot !== 0 && slot - h.lastAddSlot < ADD_MIN_GAP_SLOTS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cost = pos.cost_lamports;
      const tokens = pos.token_amount;
      const q = curve.virtual_quote_reserves;
      const t = curve.virtual_token_reserves;
      // mark >= avg cost * 112/100  <=>  q * tokens * 100 >= cost * t * 112
      if (q * tokens * ADD_TRIGGER_DEN < cost * t * ADD_TRIGGER_NUM) continue;
      const cap = state.maxBuyLamports(mint);
      let size = BUY_LAMPORTS < cap ? BUY_LAMPORTS : cap;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() - size - state.txFeeLamports() * 2n < 0n) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      h.adds += 1;
      h.lastAddSlot = slot;
    }

    // --- entries: one buy per coin, while a slot is free.
    if (state.committedPositionCount() < MAX_OPEN) {
      const free = state.freeCashLamports();
      const txFee = state.txFeeLamports();
      for (const c of coins.values()) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_OPEN) break;
        if (!isEntryCandidate(state, c, slot)) continue;
        const cap = state.maxBuyLamports(c.mint);
        let size = BUY_LAMPORTS < cap ? BUY_LAMPORTS : cap;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (free - size - txFee * 2n < 0n) continue;
        const curve = state.curves.get(c.mint)!;
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: size.toString(),
          max_slippage_bps: SLIPPAGE_BPS,
        });
        held.set(c.mint, {
          mint: c.mint,
          peakQ: curve.virtual_quote_reserves,
          peakT: curve.virtual_token_reserves,
          buySlot: slot,
          sellPending: false,
          adds: 0,
          lastAddSlot: 0,
        });
      }
    }

    return orders;
  },

  onDone(): void {
    // Nothing to do: the harness flattens what is left.
  },
});
