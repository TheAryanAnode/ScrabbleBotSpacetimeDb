#!/usr/bin/env node
/**
 * Runs `spacetime generate …` with PATH patched so rustc/rustup resolve
 * (same fix as former with-rust-path.sh, works under npm without bash).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withRustToolchainInPath } from "./rust-toolchain-path.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const env = withRustToolchainInPath();

// Use STDB_MODULE_PATH when your fork's spacetimedb/ schema differs from the DB
// you're connecting to (e.g. maincloud). Otherwise bindings won't deserialize.
const modulePath =
  process.env.STDB_MODULE_PATH?.trim() || join(root, "..", "spacetimedb");
console.log(`[run-generate] --module-path ${modulePath}`);

// macOS: `DYLD_FALLBACK_LIBRARY_PATH` is colon-separated. A ':' in the repo path
// (e.g. `Challenges:Hackathons`) makes Cargo fail joining paths. Build artifacts
// under ~/.cache/... avoid embedding that path in dyld-related env.
const cargoTargetDir = join(homedir(), ".cache", "scrabblebot-spacetimedb-target");
mkdirSync(cargoTargetDir, { recursive: true });
env.CARGO_TARGET_DIR = cargoTargetDir;
delete env.DYLD_FALLBACK_LIBRARY_PATH;
delete env.DYLD_LIBRARY_PATH;

const pre = spawnSync("rustc", ["--version"], { env, encoding: "utf8" });
if (pre.status !== 0) {
  console.error(
    "[run-generate] rustc not on PATH after toolchain prefix. Prepend e.g. ~/.cargo/bin and brew rustup bin to PATH, then retry.",
  );
  console.error(pre.stderr || pre.stdout || pre.error?.message || "");
  process.exit(1);
}

const args = [
  "generate",
  "--lang",
  "typescript",
  "--out-dir",
  "src/module_bindings",
  "--module-path",
  modulePath,
];

const r = spawnSync("spacetime", args, {
  cwd: root,
  env,
  stdio: "inherit",
});

if (r.error?.code === "ENOENT") {
  console.error(
    "[run-generate] `spacetime` not found on PATH. Install the CLI: https://spacetimedb.com/install",
  );
  process.exit(1);
}
if (r.error) {
  console.error(r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
