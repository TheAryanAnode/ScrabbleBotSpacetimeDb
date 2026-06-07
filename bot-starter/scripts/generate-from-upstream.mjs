#!/usr/bin/env node
/**
 * Regenerate bot-starter bindings from clockworklabs/scrabblebot main (shallow clone).
 * Use this when connecting to maincloud but your fork's spacetimedb/ has diverged —
 * otherwise you'll get "Can't deserialize an option type, couldn't find N tag".
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const cloneDir = mkdtempSync(join(tmpdir(), "scrabblebot-upstream-"));

const git = spawnSync(
  "git",
  ["clone", "--depth", "1", "https://github.com/clockworklabs/scrabblebot.git", cloneDir],
  { stdio: "inherit", encoding: "utf8" },
);
if (git.status !== 0) {
  console.error("[generate-from-upstream] git clone failed");
  try {
    rmSync(cloneDir, { recursive: true, force: true });
  } catch {
    /* */
  }
  process.exit(git.status ?? 1);
}

const modulePath = join(cloneDir, "spacetimedb");
const run = spawnSync(
  "node",
  [join(__dirname, "run-generate.mjs")],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, STDB_MODULE_PATH: modulePath },
  },
);

try {
  rmSync(cloneDir, { recursive: true, force: true });
} catch {
  /* */
}

process.exit(run.status === null ? 1 : run.status);
