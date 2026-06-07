// ScrabbleBot bot starter.
//
// Auth (pick one):
//   • Team JWT — on https://scrabblebot.vercel.app/team click *Generate token*,
//     copy the full `eyJ…` string into `.token-<BOT_NAME>` or set `BOT_TOKEN=…`
//     once (it is saved to the file on first successful connect).
//   • First-time CLI claim — mint a nonce (`spacetime call … mint_credential_nonce`
//     or from the team UI), then run with **no** saved bot token and:
//       `BOT_NONCE=<12-char code> npm start`
//     The bot connects anonymously, redeems the nonce, and persists the new
//     token to `.token-<BOT_NAME>`.
//
// Subsequent runs: `BOT_NAME=… npm start` (uses `.token-<BOT_NAME>`).
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  chooseWord,
  decideBid,
  wordReward,
  INITIAL_BAG,
  type AuctionType,
} from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_NONCE = process.env.BOT_NONCE; // only used on first run
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  if (BOT_TOKEN) return BOT_TOKEN;
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
// The strategy engine builds its own reward-sorted index from this list.

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

// ---- Live match intel (reconstructed from public events) ----
// The bag, opponents' competition, etc. are all derivable from auction_result.
const wonLettersByMatch = new Map<string, Map<string, number>>(); // matchId -> letter -> tiles permanently removed
const clearingPricesByMatch = new Map<string, number[]>(); // matchId -> recent `paid` values
const CLEARING_HISTORY = 24;

function recordAuctionResult(
  matchId: bigint,
  letter: string,
  hadWinner: boolean,
  paid: number,
) {
  const key = String(matchId);
  if (hadWinner) {
    let won = wonLettersByMatch.get(key);
    if (!won) {
      won = new Map();
      wonLettersByMatch.set(key, won);
    }
    won.set(letter, (won.get(letter) ?? 0) + 1);
  }
  let prices = clearingPricesByMatch.get(key);
  if (!prices) {
    prices = [];
    clearingPricesByMatch.set(key, prices);
  }
  prices.push(paid);
  if (prices.length > CLEARING_HISTORY) prices.shift();
}

// Estimated remaining bag composition: initial distribution minus tiles won.
function bagRemainingForMatch(matchId: bigint): Map<string, number> {
  const won = wonLettersByMatch.get(String(matchId));
  const bag = new Map<string, number>();
  for (const [letter, count] of Object.entries(INITIAL_BAG)) {
    const remaining = count - (won?.get(letter) ?? 0);
    if (remaining > 0) bag.set(letter, remaining);
  }
  return bag;
}

function numOpponentsForMatch(conn: DbConnection, matchId: bigint): number {
  let count = 0;
  for (const p of conn.db.match_participant.iter()) {
    if (p.matchId === matchId) count++;
  }
  return Math.max(1, count - 1);
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.bot_credential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.my_rack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.match_participant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

function tilesRemainingForMatch(conn: DbConnection, matchId: bigint): number {
  const m = conn.db.match_state.id.find(matchId);
  return m ? Number(m.bagTotal) : 0;
}

function auctionTypeForMatch(conn: DbConnection, matchId: bigint): AuctionType {
  const m = conn.db.match_state.id.find(matchId);
  return m?.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey";
}

// Cap on how many words to submit in a single tick (e.g. when dumping the rack
// in the endgame), so we don't spin forever on a degenerate strategy.
const MAX_WORDS_PER_TICK = 10;

function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
    auctionType: auctionTypeForMatch(conn, matchId),
    tilesRemaining: tilesRemainingForMatch(conn, matchId),
    dictionary: DICTIONARY,
    bagRemaining: bagRemainingForMatch(matchId),
    numOpponents: numOpponentsForMatch(conn, matchId),
    recentClearingPrices: clearingPricesByMatch.get(String(matchId)) ?? [],
  });
  if (amount <= 0) return;
  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) });
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  const matches = new Set<bigint>();
  for (const p of conn.db.match_participant.iter()) {
    if (p.botId === myBotId) matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);

    const participant = participantForMatch(conn, matchId);
    if (!participant) continue;
    const tilesRemaining = tilesRemainingForMatch(conn, matchId);

    // The server rack only updates after a round-trip, so simulate consumption
    // locally to plan (and submit) several words in one tick — important for
    // emptying the rack quickly when the bag is about to run out.
    const rack = rackForMatch(conn, matchId);
    const bagRemaining = bagRemainingForMatch(matchId);
    const numOpponents = numOpponentsForMatch(conn, matchId);
    let balance = participant.balance;
    for (let i = 0; i < MAX_WORDS_PER_TICK; i++) {
      const word = chooseWord({
        myRack: rack,
        dictionary: DICTIONARY,
        tilesRemaining,
        myBalance: balance,
        bagRemaining,
        numOpponents,
      });
      if (!word) break;
      console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
      conn.reducers.submitWord({ matchId, word });
      for (const c of word) {
        const n = (rack.get(c) ?? 0) - 1;
        if (n > 0) rack.set(c, n);
        else rack.delete(c);
      }
      balance += wordReward(word);
    }
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers.claimCredential({ code: BOT_NONCE });
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          const hintPath = TOKEN_PATH;
          console.error(
            `[${BOT_NAME}] no BotCredential for this identity — the server does not recognize this token as your team's bot.`,
          );
          console.error(
            `  Use the JWT from the site: /team → "Generate token" (long string starting with eyJ).`,
          );
          console.error(
            `  Save it: printf '%s' 'eyJ…' > ${hintPath}   or once: BOT_TOKEN='eyJ…' npm start`,
          );
          console.error(
            `  Do not use: hex identity (0x…), connect_id, or your browser's normal ScrabbleBot login token.`,
          );
          console.error(
            `  Or mint a nonce and run with a fresh anon connection (delete ${hintPath}, unset BOT_TOKEN):`,
          );
          console.error(`    BOT_NONCE=<12-char code> npm start`);
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(`[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.my_rack.onInsert(() => tryPlayWord(conn));
  conn.db.my_rack.onUpdate(() => tryPlayWord(conn));
  conn.db.bot_credential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auction_result.onInsert((_ctx, r) => {
    const hadWinner = r.winnerBotId !== undefined && r.winnerBotId !== null;
    // Track the bag + market regardless of which bot we are.
    recordAuctionResult(r.matchId, r.letter, hadWinner, Number(r.paid));
    if (myBotId === null) return;
    const winner = hadWinner ? String(r.winnerBotId) : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.match_state.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.match_participant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      // Drop per-match intel so the maps don't grow without bound.
      const key = String(neu.id);
      wonLettersByMatch.delete(key);
      clearingPricesByMatch.delete(key);
      lastWordAttemptByMatch.delete(key);
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.match_participant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.match_state.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobby_member.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({});
}

function bootstrapActivity(conn: DbConnection) {
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
