// TrailHunter — strict early-momentum paper bot for the pump.fun bonding-curve replay.
//
// Idea (from the dev-window data, not from any other entry): most pump.fun coins bleed after
// their first push, and the 2.5% round-trip curve fee eats any small edge, so the only exit
// shape that measured positive net per trade on this window was a LOW-ARM TRAILING STOP
// (arm +15%, trail 15% from the peak) behind a tight stop loss, entered only on strong,
// broad, still-rising momentum. Fixed take-profits measured worse (they cap the few real
// runners); holding losers measured far worse (they bleed to the floor). So: enter rarely,
// only when many distinct buyers push the price to its window high; cut losers at -5%; let
// the trailing stop bank whatever the runner gives.
//
// Every curve keeps a short rolling tape of its recorded trades. A buy fires when, over the
// last `window` slots, the price rose at least `minUp` on at least `minBuys` buys from at
// least `minBuyers` distinct wallets, net SOL inflow is at least `minNet`, the price sits
// near its window high, and (optionally) the newer half of the window out-inflows the older
// half. One buy per position; an optional single pyramid add buys more only while the
// position is already up. An optional first partial take-profit (`tp1` / `tp1frac`) banks
// part of a runner early.
//
// A pacing guardrail keeps the run above the 20-coin minimum even in a quiet stretch: when
// the bot's own fills or coins lag a pace set in block time, it opens tiny probe round trips
// (buy probeSol, sell it as soon as it lands).
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Momentum lookback in TRADES (0 = use the slot window instead): price now vs the price this many trades ago. */
  momTrades: number;
  /** Price now must stay below this multiple of the CreateEvent price (0 = off). */
  maxCreateMult: number;
  /** Buy-share window in TRADES (0 = use SOL-volume share over the slot window instead). */
  buyShareTrades: number;
  /** Minimum total trades on the curve before an entry is allowed. */
  minTrades: number;
  /** Entry window in slots. */
  window: number;
  /** Price now over price at the window start, minus 1. */
  minUp: number;
  /** Upper bound on that rise: skip curves that already ran too far inside one window. */
  maxUp: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNet: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Buys must be at least this share of the window's SOL volume (buys / (buys + sells)). */
  minBuyShare: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Newer-half net inflow must be at least this multiple of the older half's (acceleration). */
  accel: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxTopShare: number;
  /** Curve real SOL bounds at entry. */
  rqMin: number;
  rqMax: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  ageMin: number;
  /** Slots since the CreateEvent after which an entry is no longer allowed. */
  ageMax: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** SOL of the first buy of a position (<= stakeSol; the rest is pyramid room). */
  initialSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Sell once value falls this far below its peak. */
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** First partial take-profit: sell this share of the position here. 0 = off. */
  tp1: number;
  tp1frac: number;
  /** Keep adding to a position while it is up, up to stakeSol. */
  pyramid: boolean;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: target fills / coins over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  momTrades: 10,
  maxCreateMult: 1.3,
  buyShareTrades: 8,
  minTrades: 5,
  window: 30,
  minUp: 0.1,
  maxUp: 1.5,
  minNet: 0,
  minBuys: 0,
  minBuyers: 0,
  minBuyShare: 0.875,
  nearHigh: 0,
  accel: 0,
  maxTopShare: 1,
  rqMin: 1,
  rqMax: 1000,
  ageMin: 0,
  ageMax: 2400,
  stakeSol: 0.3,
  initialSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 800,
  stopLoss: 0.07,
  trailArm: 0.3,
  trail: 0.1,
  maxHold: 600,
  holdIfUp: 1000,
  cooldown: 600,
  maxEntries: 2,
  tp1: 0,
  tp1frac: 0,
  pyramid: true,
  addIfUp: 0.12,
  addStep: 0,
  addSol: 0.1,
  addNetSol: 0,
  maxMain: 5,
  targetCoins: 30,
  targetFills: 200,
  paceSecs: 10800,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 0.6,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS = 10000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  /** Price (virtual quote / virtual token) at the CreateEvent. */
  createPrice: number;
  trades: Trade[];
  /** Total trades ever seen on this curve (the tape itself is pruned). */
  totalTrades: number;
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  /** Highest mark price seen since entry (SOL per token, gross — fees are a constant drag, not part of the trigger). */
  peakPrice: number;
  /** Decision price of the first buy (mark price at the batch the buy was decided on). */
  entryPrice: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** Mark price at the latest batch. */
  lastPrice: number;
  /** Partial take-profit already banked. */
  banked: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, trades: [], totalTrades: 0, entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.rqMin || rqSol > p.rqMax) return false;
    if (t.created === null || now - t.created < p.ageMin || now - t.created > p.ageMax) return false;
    if (p.minTrades > 0 && t.totalTrades < p.minTrades) return false;
    const n = t.trades.length;
    if (n === 0) return false;
    const last = t.trades[n - 1]!.price;
    // Trade-count momentum: price now vs the price `momTrades` trades ago.
    if (p.momTrades > 0) {
      if (n <= p.momTrades) return false;
      const mom = last / t.trades[n - 1 - p.momTrades]!.price - 1;
      if (mom < p.minUp || mom > p.maxUp) return false;
    }
    // Never chase a coin that already ran far above its create price.
    if (p.maxCreateMult > 0 && t.createPrice > 0 && last >= t.createPrice * p.maxCreateMult) return false;
    // Buy share over the last `buyShareTrades` trades (count-based).
    if (p.buyShareTrades > 0) {
      const m = Math.min(p.buyShareTrades, n);
      let b = 0;
      for (let i = n - m; i < n; i++) if (t.trades[i]!.buy) b++;
      if (b < p.minBuyShare * m) return false;
    }
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let winLast = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      winLast = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNet) return false;
    if (p.buyShareTrades === 0 && p.minBuyShare > 0 && buySol < p.minBuyShare * (buySol + sellSol)) return false;
    if (startPrice <= 0) return false;
    // Slot-window momentum only when the trade-count momentum is not in use.
    if (p.momTrades === 0) {
      const up = winLast / startPrice - 1;
      if (up < p.minUp || up > p.maxUp) return false;
    }
    if (p.nearHigh > 0 && winLast < high * p.nearHigh) return false;
    if (p.accel > 0 && (netNew <= 0 || netNew < p.accel * netOld)) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxTopShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          t.totalTrades++;
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const price = vq / vt;
        if (price > h.peakPrice) h.peakPrice = price;
        h.lastValue = value;
        h.lastPrice = price;
        // All exit triggers are on the GROSS price move vs the entry price: the ~2.5%
        // round-trip fee is a constant drag, so judging the stop on net value would fire
        // it at only a -2.5% price move (whipsaw) and arm the trail at +18% instead of +15%.
        const up = h.entryPrice > 0 ? price / h.entryPrice - 1 : 0;
        // Partial take-profit: bank tp1frac of the position the first time it clears tp1.
        if (!h.exiting && p.tp1 > 0 && !h.banked && up >= p.tp1 && !pendingByMint.has(mint)) {
          if (orders.length < cap) {
            const sellTokens = BigInt(Math.floor(tokens * p.tp1frac));
            if (sellTokens > 0n) {
              orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10000 });
              h.banked = true;
              h.peakPrice = price;
              continue;
            }
          }
        }
        let exit = h.exiting;
        if (!exit && up < -p.stopLoss) exit = true;
        if (!exit && h.peakPrice >= h.entryPrice * (1 + p.trailArm) && price < h.peakPrice * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold && up < p.holdIfUp) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Pyramid into strength only: the position is up, the price stepped up from the
          // last add, and net SOL still flows in.
          if (!p.pyramid || h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastPrice < h.entryPrice * (1 + p.addIfUp)) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.rqMax) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakPrice: price, entryPrice: price, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0, lastPrice: price, banked: false });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
