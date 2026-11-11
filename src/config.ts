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
  /** Let the AI panel search the web (0 = off): WebSearch and WebFetch. An execution is a full agent with its native tools. */
  web: env("TODO_WEB", "1") !== "0",
  /** A successful execution sends an open or doing todo to review (验收); 0 keeps its status. */
  autoReview: env("TODO_AUTO_REVIEW", "1") !== "0",
  /** Model of an execution, a full-mode agent run: `<runtime>/<tier>` or a model id (ai-space docs/model-tiers-and-modes.md); opus by default. */
  executeModel: env("TODO_EXECUTE_MODEL", "claude/intermediate"),
  /**
   * What an execution may do on the machine: `bypassPermissions` (default; the agent writes files and runs
   * commands without asking), `acceptEdits`, `plan`, or `default` for the runtime's read-only headless tier.
   */
  executePermission: env("TODO_EXECUTE_PERMISSION", "bypassPermissions"),
  /** Wall-clock cap of one execution, seconds. */
  executeTimeoutSec: num("TODO_EXECUTE_TIMEOUT", 600),
  /** Language of the page and of the model's answers. */
  lang: env("TODO_LANG", "zh"),
  /** IANA zone the dates on the page are read in, when the page does not say: the system zone. */
  timezone: appZone(),
};

/**
 * The zone due dates are read in when a request names none: the system's zone (the machine the
 * service runs on), or `TODO_TZ` when it is set to a valid zone (tests pin it).
 */
export function appZone(): string {
  const z = (process.env.TODO_TZ ?? "").trim();
  if (z) { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; } catch { /* not a zone: fall through */ } }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

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
