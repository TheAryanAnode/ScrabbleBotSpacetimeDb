/**
 * Homebrew rustup is keg-only; rustc/cargo shims live under ~/.cargo/bin and
 * /opt/homebrew/opt/rustup/bin. npm run scripts often omit those — Spacetime
 * then fails wasm32 checks with ENOENT when invoking rustc.
 */
import { join } from "node:path";

const SEP = process.platform === "win32" ? ";" : ":";

export function rustPathPrefix() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const parts = [
    join(home, ".cargo", "bin"),
    "/opt/homebrew/opt/rustup/bin",
    "/usr/local/opt/rustup/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return parts.join(SEP);
}

/** Return a copy of `env` with Rust toolchain dirs prepended to PATH. */
export function withRustToolchainInPath(env = process.env) {
  const prefix = rustPathPrefix();
  const tail = env.PATH ?? "";
  return { ...env, PATH: `${prefix}${SEP}${tail}` };
}
