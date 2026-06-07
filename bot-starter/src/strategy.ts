// Sophisticated ScrabbleBot strategy.
//
// The whole game reduces to one objective: maximise total word reward, because
// reward feeds BOTH score (ranking) and balance (future bids). Two levers:
//   1. decideBid  — what a letter is worth to us right now.
//   2. chooseWord — when to convert letters into reward vs. hoard for the 3x.
//
// Core ideas implemented here (all cheap enough for the 1s auction window):
//   • Anagram/equity engine: a reward-sorted dictionary index lets us find the
//     best playable word with an early-out scan, and score a rack's "equity".
//   • Marginal valuation: a letter is worth equity(rack+L) − equity(rack).
//     Equity blends the best word playable NOW with the discounted expected
//     value of long words we could COMPLETE given the (reconstructed) bag.
//   • Bag-aware option value: opponents + we drain a known 98-tile bag; we feed
//     the live remaining-bag estimate in so completion odds are real, not guessed.
//   • Auction-theoretic bidding: Vickrey ⇒ bid true marginal value (dominant
//     strategy); First-price ⇒ shade below value, calibrated to observed
//     clearing prices to dodge the winner's curse.
//   • Hoard/harvest word policy: hold short words while a longer word is
//     reachable; cash out on endgame, low liquidity, or rack overflow.

export type AuctionType = "Vickrey" | "FirstPrice";

// Standard Scrabble letter values.
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

// Standard 98-tile bag (no blanks) — mirrors the module's DEFAULT_BAG.
export const INITIAL_BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1,
  K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6,
  U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};

const A = 65;
const VOWELS = "AEIOU";

function valueOf(letter: string): number {
  return LETTER_VALUE[letter] ?? 0;
}

// Exact reward the module grants for a word (integer base*num/denom math).
export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  const len = word.length;
  const [num, denom] =
    len <= 3 ? [1, 1] : len === 4 ? [3, 2] : len === 5 ? [2, 1] : len === 6 ? [5, 2] : [3, 1];
  return Math.floor((base * num) / denom);
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const POTENTIAL_SCAN = 4000; // how many top-reward words to consider as build targets
const COMPLETION_DISCOUNT = 0.8; // value decay per still-missing tile
const EQUITY_W = 1.0; // weight of marginal equity in a bid (currency units)
const INTRINSIC_W = 0.9; // weight of the static letter prior

const ENDGAME_TILES = 14; // bag at/below this ⇒ stop hoarding, cash out
const BALANCE_FLOOR = 28; // below this ⇒ refuel by playing a word
const RACK_SOFT_CAP = 13; // rack bigger than this ⇒ relieve it
const HOARD_RATIO = 1.3; // hold only if reachable long word ≥ this × best-now

const FIRST_PRICE_MIN_SHADE = 0.5;
const FIRST_PRICE_MAX_SHADE = 0.85;
const BID_CAP_FRACTION_EARLY = 0.55; // never spend more than this share of balance early
const BID_HARD_CAP = 40;

// ---------------------------------------------------------------------------
// Precomputed dictionary engine (built once, lazily, from the shared wordlist)
// ---------------------------------------------------------------------------

interface Entry {
  word: string;
  counts: Int8Array; // letter histogram, A=0..Z=25
  reward: number;
  len: number;
}

interface Engine {
  entries: Entry[]; // reward-descending
  scanTop: Entry[]; // prefix used for option-value scans
  placeability: Float64Array; // 0..1 per letter: share of words containing it
}

let ENGINE: Engine | null = null;
let ENGINE_SRC: string[] | null = null;

function buildEngine(dictionary: string[]): Engine {
  const entries: Entry[] = [];
  const containing = new Float64Array(26);
  for (const raw of dictionary) {
    const word = raw;
    if (word.length < 2) continue;
    const counts = new Int8Array(26);
    let ok = true;
    for (let k = 0; k < word.length; k++) {
      const i = word.charCodeAt(k) - A;
      if (i < 0 || i > 25) {
        ok = false;
        break;
      }
      counts[i]++;
    }
    if (!ok) continue;
    for (let i = 0; i < 26; i++) if (counts[i] > 0) containing[i]++;
    entries.push({ word, counts, reward: wordReward(word), len: word.length });
  }
  entries.sort((a, b) => b.reward - a.reward || b.len - a.len);
  const total = Math.max(1, entries.length);
  const placeability = new Float64Array(26);
  let maxShare = 1e-9;
  for (let i = 0; i < 26; i++) {
    placeability[i] = containing[i] / total;
    if (placeability[i] > maxShare) maxShare = placeability[i];
  }
  for (let i = 0; i < 26; i++) placeability[i] /= maxShare; // normalise to 0..1
  return { entries, scanTop: entries.slice(0, POTENTIAL_SCAN), placeability };
}

function engine(dictionary: string[]): Engine {
  if (ENGINE === null || ENGINE_SRC !== dictionary) {
    ENGINE = buildEngine(dictionary);
    ENGINE_SRC = dictionary;
  }
  return ENGINE;
}

// ---------------------------------------------------------------------------
// Rack / bag helpers
// ---------------------------------------------------------------------------

function toCounts(m: Map<string, number>): { counts: Int8Array; size: number } {
  const counts = new Int8Array(26);
  let size = 0;
  for (const [letter, n] of m.entries()) {
    if (n <= 0) continue;
    const i = letter.charCodeAt(0) - A;
    if (i >= 0 && i <= 25) {
      counts[i] += n;
      size += n;
    }
  }
  return { counts, size };
}

function fits(word: Int8Array, rack: Int8Array): boolean {
  for (let i = 0; i < 26; i++) if (word[i] > rack[i]) return false;
  return true;
}

// Highest-reward word currently playable from `rack` (or null).
function bestNow(rack: Int8Array, size: number, eng: Engine): Entry | null {
  if (size < 2) return null;
  for (const e of eng.entries) {
    if (e.len > size) continue;
    if (fits(e.counts, rack)) return e;
  }
  return null;
}

// Option value: discounted expected reward of the best long word we could still
// COMPLETE, given letters we're missing are drawable from the live bag.
function potential(
  rack: Int8Array,
  size: number,
  eng: Engine,
  bag: Int8Array,
  bagTotal: number,
  expectedWins: number,
): number {
  let best = 0;
  for (const e of eng.scanTop) {
    if (e.reward <= best) break; // reward-sorted: nothing better remains
    let missing = 0;
    let feasible = 1;
    for (let i = 0; i < 26; i++) {
      const need = e.counts[i] - rack[i];
      if (need <= 0) continue;
      const have = bag[i];
      if (have < need) {
        feasible = 0;
        break;
      }
      missing += need;
      // crude per-letter availability: rarer in the bag ⇒ lower odds
      feasible *= bagTotal > 0 ? Math.min(1, (have / bagTotal) * 6) : 0;
    }
    if (!feasible) continue;
    if (missing === 0) {
      if (e.reward > best) best = e.reward;
      continue;
    }
    if (missing > expectedWins * 1.5 + 2) continue; // unlikely to gather in time
    const winShare = expectedWins > 0 ? Math.min(1, expectedWins / missing) : 0;
    const est = e.reward * feasible * winShare * Math.pow(COMPLETION_DISCOUNT, missing);
    if (est > best) best = est;
  }
  return best;
}

// Blend of immediate best word and reachable long-word option value.
function equity(
  rack: Int8Array,
  size: number,
  eng: Engine,
  bag: Int8Array,
  bagTotal: number,
  expectedWins: number,
): number {
  const now = bestNow(rack, size, eng);
  const nowReward = now ? now.reward : 0;
  const opt = potential(rack, size, eng, bag, bagTotal, expectedWins);
  return Math.max(nowReward, opt);
}

// Static prior so we still bid sensibly when the rack is near-empty (marginal≈0).
function intrinsic(letter: string, rack: Map<string, number>, eng: Engine): number {
  const i = letter.charCodeAt(0) - A;
  const place = i >= 0 && i <= 25 ? eng.placeability[i] : 0;
  const face = valueOf(letter);
  let v = 0.5 * face + 3.0 * place;

  // Letters that need support are worth less without it.
  const have = (l: string) => (rack.get(l) ?? 0) > 0;
  if (letter === "Q" && !have("U")) v *= 0.35;
  if ("JXZ".includes(letter)) {
    const hasVowel = [...VOWELS].some(have);
    if (!hasVowel) v *= 0.6;
  }
  if (letter === "S") v += 1.5; // pluralises / hooks almost anything
  return v;
}

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  auctionType: AuctionType;
  tilesRemaining: number;
  // Optional intel (defaults keep the bot functional without it):
  dictionary?: string[];
  bagRemaining?: Map<string, number>;
  numOpponents?: number;
  recentClearingPrices?: number[];
}

export function decideBid(ctx: BidContext): number {
  const dictionary = ctx.dictionary ?? [];
  const eng = engine(dictionary);

  const { counts: rack, size } = toCounts(ctx.myRack);
  const bagMap = ctx.bagRemaining ?? new Map<string, number>();
  const { counts: bag, size: bagTotal } = toCounts(bagMap);
  const opponents = Math.max(1, ctx.numOpponents ?? 5);
  const players = opponents + 1;
  // How many more letters can we realistically win?
  const expectedWins = Math.max(0, ctx.tilesRemaining) / players;

  // Marginal value: how much our equity improves if we add this letter.
  let value: number;
  if (eng.entries.length > 0) {
    const base = equity(rack, size, eng, bag, bagTotal, expectedWins);
    const i = ctx.letter.charCodeAt(0) - A;
    if (i >= 0 && i <= 25) rack[i]++;
    const withL = equity(rack, size + 1, eng, bag, bagTotal, expectedWins);
    if (i >= 0 && i <= 25) rack[i]--;
    const marginal = Math.max(0, withL - base);
    value = EQUITY_W * marginal + INTRINSIC_W * intrinsic(ctx.letter, ctx.myRack, eng);
  } else {
    value = valueOf(ctx.letter) + 2;
  }

  // Endgame: a letter we can't deploy before the bag empties is near-worthless.
  if (ctx.tilesRemaining <= ENDGAME_TILES) {
    const usableNow = bestNow(rack, size, eng);
    if (!usableNow) value *= 0.45;
  }

  // First-price: shade below true value to avoid the winner's curse, calibrated
  // to how hot recent auctions have been.
  if (ctx.auctionType === "FirstPrice") {
    const prices = ctx.recentClearingPrices ?? [];
    const avg = prices.length
      ? prices.reduce((s, p) => s + p, 0) / prices.length
      : value * 0.5;
    // Hotter market (avg close to our value) ⇒ shade less; cold ⇒ shade hard.
    const heat = value > 0 ? Math.min(1, avg / value) : 0;
    const shade = FIRST_PRICE_MIN_SHADE + (FIRST_PRICE_MAX_SHADE - FIRST_PRICE_MIN_SHADE) * heat;
    value *= shade;
  } else {
    // Vickrey: truthful is dominant. Nudge +1 to win ties (we pay 2nd price).
    value += 1;
  }

  // Liquidity management: keep dry powder while many letters remain.
  let bid = Math.round(value);
  const reserve = ctx.tilesRemaining > ENDGAME_TILES ? Math.min(10, Math.round(ctx.myBalance * 0.08)) : 0;
  const cap =
    ctx.tilesRemaining > ENDGAME_TILES
      ? Math.min(BID_HARD_CAP, Math.floor(ctx.myBalance * BID_CAP_FRACTION_EARLY))
      : BID_HARD_CAP;
  bid = Math.min(bid, cap, Math.max(0, ctx.myBalance - reserve));
  return Math.max(0, bid);
}

// ---------------------------------------------------------------------------
// Word play
// ---------------------------------------------------------------------------

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  tilesRemaining: number;
  myBalance: number;
  bagRemaining?: Map<string, number>;
  numOpponents?: number;
}

export function chooseWord(ctx: WordContext): string | null {
  const eng = engine(ctx.dictionary);
  const { counts: rack, size } = toCounts(ctx.myRack);
  const best = bestNow(rack, size, eng);
  if (!best) return null;

  // Forced cash-outs.
  if (ctx.tilesRemaining <= ENDGAME_TILES) return best.word; // nothing carries over
  if (ctx.myBalance < BALANCE_FLOOR) return best.word; // need bidding fuel
  if (size >= RACK_SOFT_CAP) return best.word; // rack overflow
  if (best.len >= 7) return best.word; // already at the 3x ceiling — take it

  // Otherwise consider hoarding toward a longer (higher-multiplier) word.
  const bagMap = ctx.bagRemaining ?? new Map<string, number>();
  const { counts: bag, size: bagTotal } = toCounts(bagMap);
  const players = Math.max(1, (ctx.numOpponents ?? 5) + 1);
  const expectedWins = Math.max(0, ctx.tilesRemaining) / players;
  const reachable = potential(rack, size, eng, bag, bagTotal, expectedWins);

  if (reachable >= best.reward * HOARD_RATIO) return null; // hold for the bigger word
  return best.word;
}
