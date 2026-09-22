import { resolve } from "node:path";

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => { const n = Number(env(k)); return Number.isFinite(n) && env(k) !== "" ? n : d; };

export const config = {
  port: num("PORT", 8970),
  publicBase: env("PUBLIC_BASE").replace(/\/$/, ""),
  dataDir: env("SPACE_APP_DATA_DIR", "data"),
  /** ai-space's API and this app's token (handed over in space.env); every AI feature goes through them. */
  spaceApiUrl: env("SPACE_API_URL").replace(/\/$/, ""),
  spaceAppToken: env("SPACE_APP_TOKEN"),
  /** Model for every call; empty = the space's default. */
  model: env("TODO_MODEL"),
  /** Let an execution search the web (0 = off): WebSearch and WebFetch. */
  web: env("TODO_WEB", "1") !== "0",
  /** Wall-clock cap of one execution, seconds. */
  executeTimeoutSec: num("TODO_EXECUTE_TIMEOUT", 600),
  /** Language of the page and of the model's answers. */
  lang: env("TODO_LANG", "zh"),
  /** IANA zone the dates on the page are read in, when the page does not say. */
  timezone: env("TODO_TZ", "Asia/Shanghai"),
};

/** SQLite file: `DATABASE_URL` (sqlite:///abs/path) from ai-space, else data/main.db. */
export function databasePath(e: Record<string, string | undefined> = process.env): string {
  const url = (e.DATABASE_URL ?? "").trim();
  if (url === ":memory:") return url;
  if (url) {
    const m = /^sqlite:\/\/(.*)$/.exec(url);
    if (!m) throw new Error(`DATABASE_URL must be sqlite:///path, got ${url}`);
    return m[1]!.startsWith("/") ? m[1]! : resolve(m[1]!);
  }
  return resolve(e.SPACE_APP_DATA_DIR ?? "data", "main.db");
}
