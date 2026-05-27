// Wordsmith bot starter.
//
// Before running:
//   1. `spacetime publish wordsmith --module-path ../spacetimedb`
//   2. `npm run generate`  (creates ./src/module_bindings)
//   3. Set BOT_NAME / STDB_DB / STDB_HOST via env if needed.
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
import { chooseWord, decideBid } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "wordsmith-gf28z";
const BOT_NAME = process.env.BOT_NAME ?? `bot-${Math.floor(Math.random() * 10000)}`;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8");
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
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick

let myIdentity: Identity | null = null;
let lastBidAuction: bigint | null = null;
let lastWordAttempt = 0;
const WORD_RETRY_MS = 500;

function rackFor(conn: DbConnection): Map<string, number> {
  // my_rack is a view that returns only this bot's own letters.
  const rack = new Map<string, number>();
  for (const h of conn.db.my_rack.iter()) {
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function myBalance(conn: DbConnection): number {
  if (!myIdentity) return 0;
  const me = conn.db.bot.identity.find(myIdentity);
  return me ? Number(me.balance) : 0;
}

function tryBid(conn: DbConnection, auctionId: bigint, letter: string) {
  if (lastBidAuction === auctionId) return;
  const amount = decideBid({
    letter,
    myBalance: myBalance(conn),
    myRack: rackFor(conn),
  });
  if (amount <= 0) return;
  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) });
  lastBidAuction = auctionId;
  console.log(`[${BOT_NAME}] bid ${amount} on '${letter}' (auction ${auctionId})`);
}

function tryPlayWord(conn: DbConnection) {
  const now = Date.now();
  if (now - lastWordAttempt < WORD_RETRY_MS) return;
  lastWordAttempt = now;
  const word = chooseWord({ myRack: rackFor(conn), dictionary: DICTIONARY });
  if (!word) return;
  console.log(`[${BOT_NAME}] playing '${word}'`);
  conn.reducers.submitWord({ word });
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);
      const existing = conn.db.bot.identity.find(identity);
      if (!existing) {
        console.log(`[${BOT_NAME}] registering as '${BOT_NAME}'`);
        conn.reducers.registerBot({ name: BOT_NAME });
      }
      for (const a of conn.db.auction.iter()) {
        if (a.status.tag === "Open") tryBid(conn, a.id, a.letter);
      }
      tryPlayWord(conn);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.letter);
  });
  conn.db.my_rack.onInsert(() => tryPlayWord(conn));
  conn.db.my_rack.onUpdate(() => tryPlayWord(conn));

  conn.db.auction_result.onInsert((_ctx, r) => {
    const winner = r.winner ? r.winner.toHexString().slice(0, 8) : "no-bid";
    console.log(
      `[${BOT_NAME}] auction ${r.auctionId} '${r.letter}' → ${winner} for ${r.winningBid}`,
    );
  });
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
