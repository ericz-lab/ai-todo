/**
 * One page over several machines. Every machine keeps its own list; the instance whose ai-space has
 * peers running ai-todo shows theirs too. Each instance provides the bus capability `ops`
 * (`POST /api/remote`): one request for one of its own page routes, sent by ai-todo on another
 * space through ai-space's bus. The hub's page reaches a peer as `/api/m/<peer>/<route>`, which
 * this module forwards as `POST /api/call/<peer>/ai-todo/ops`.
 *
 * The bus carries only the body and its content type, and buffers the answer, so the method, path
 * and body (base64, so a multipart upload survives) travel in a JSON envelope, and the answer comes
 * back whole: status, content type and bytes (an image too). Streams do not cross: an execution on
 * a peer is started detached (`?detach=1`) and followed with `GET /api/runs/:id`; the AI panel's
 * chat runs on the hub and only its context and actions go to the machine.
 */

export const CAPABILITY = "ops";

/** What one request may carry through the bus (its limit is 4 MiB, base64 adds a third). */
export const MAX_FORWARD_BYTES = 2_900_000;

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** The page's routes a remote request may reach. Not the chat proxy, the run stream, the bus capabilities or this module's own. */
const ROUTES: [Method[], RegExp][] = [
  [["GET"], /^\/api\/widget$/],
  [["GET", "POST"], /^\/api\/todos$/],
  [["POST"], /^\/api\/todos\/bulk$/],
  [["POST"], /^\/api\/todos\/reorder$/],
  [["GET", "PATCH", "DELETE"], /^\/api\/todos\/\d+$/],
  [["POST"], /^\/api\/todos\/\d+\/review$/],
  [["GET", "POST"], /^\/api\/todos\/\d+\/records$/],
  [["GET", "PATCH", "DELETE"], /^\/api\/todos\/\d+\/records\/\d+$/],
  [["GET"], /^\/api\/todos\/\d+\/records\/\d+\/revisions$/],
  [["GET", "PUT"], /^\/api\/todos\/\d+\/plan$/],
  [["GET"], /^\/api\/todos\/\d+\/plan\/versions$/],
  [["POST"], /^\/api\/todos\/\d+\/execute$/],
  [["GET"], /^\/api\/todos\/\d+\/runs$/],
  [["GET"], /^\/api\/runs\/\d+$/],
  [["GET"], /^\/api\/execute\/models$/],
  [["POST"], /^\/api\/ai\/(parse|drafts|apply)$/],
  [["GET"], /^\/api\/ai\/context$/],
  [["GET"], /^\/blobs\/[A-Za-z0-9._\/-]+$/],
];

export interface Envelope { method: Method; path: string; contentType?: string; body64?: string }

/** The request in a call's body, or null when it names no allowed route. `path` keeps its query. */
export function readEnvelope(v: unknown): Envelope | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const method = typeof o.method === "string" ? o.method.toUpperCase() : "";
  const path = typeof o.path === "string" ? o.path : "";
  if (!path.startsWith("/") || path.includes("..") || path.includes("\\") || path.startsWith("//")) return null;
  let pathname: string;
  try { pathname = new URL(path, "http://x").pathname; } catch { return null; }
  if (!ROUTES.some(([methods, re]) => (methods as string[]).includes(method) && re.test(pathname))) return null;
  const contentType = typeof o.contentType === "string" ? o.contentType.slice(0, 200) : undefined;
  const body64 = typeof o.body64 === "string" && method !== "GET" ? o.body64 : undefined;
  return { method: method as Method, path, ...(contentType ? { contentType } : {}), ...(body64 ? { body64 } : {}) };
}

/** Only this app calls `ops`: here (`ai-todo`) or on a hub (`<hub>/ai-todo`). */
export function callerAllowed(caller: string | null, app: string): boolean {
  return Boolean(caller) && (caller === app || caller!.endsWith(`/${app}`));
}

export interface Machines {
  /** This machine's SPACE_NAME. */
  local: string;
  /** Peers of this space whose ai-space lists this app's `ops`, by the name this space calls them. */
  peers: string[];
  error: string | null;
}

/** A peer's app appears as `<peer>/<app>` with `peer` set. */
type CapabilityList = { apps?: { app?: string; peer?: string; provides?: unknown }[] };

const provides = (p: unknown, name: string): boolean =>
  Array.isArray(p) ? p.some((x) => (typeof x === "string" ? x : (x as { name?: string })?.name) === name) : Boolean(p && typeof p === "object" && name in (p as object));

/**
 * The peers running this app, read from ai-space's catalogue with the app token; kept for 30 s.
 * Past that the list kept is answered at once and read again behind it, so no request waits for the catalogue.
 */
export function machineFinder(o: { apiUrl: string; app: string; local: string; token: string; fetch?: typeof fetch; now?: () => number }) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  let cache: { at: number; value: Machines } | null = null;
  let reading: Promise<Machines> | null = null;
  const read = async (): Promise<Machines> => {
    let value: Machines;
    try {
      const res = await f(`${o.apiUrl}/api/capabilities`, { headers: o.token ? { authorization: `Bearer ${o.token}` } : {}, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`ai-space answered HTTP ${res.status}`);
      const d = (await res.json()) as CapabilityList;
      const peers = [...new Set((d.apps ?? []).filter((a) => a.peer && (a.app === o.app || a.app === `${a.peer}/${o.app}`) && provides(a.provides, CAPABILITY)).map((a) => a.peer!))].sort();
      value = { local: o.local, peers, error: null };
    } catch (e) {
      // Keep the last good list through a short outage; this machine always works.
      value = cache?.value ?? { local: o.local, peers: [], error: (e as Error).message };
    }
    cache = { at: now(), value };
    return value;
  };
  return async (): Promise<Machines> => {
    if (cache && now() - cache.at < 30_000) return cache.value;
    reading ??= read().finally(() => { reading = null; });
    return cache ? cache.value : reading;
  };
}

/** Send one request to a peer's instance through ai-space's bus; its answer comes back as it was given. */
export function forwarder(o: { apiUrl: string; app: string; token: string; fetch?: typeof fetch }) {
  const f = o.fetch ?? fetch;
  return async (peer: string, env: Envelope): Promise<Response> => {
    let res: Response;
    try {
      res = await f(`${o.apiUrl}/api/call/${encodeURIComponent(peer)}/${encodeURIComponent(o.app)}/${CAPABILITY}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        body: JSON.stringify(env),
        signal: AbortSignal.timeout(16 * 60_000),
      });
    } catch (e) {
      return Response.json({ ok: false, error: `${peer} unreachable: ${(e as Error).message}` }, { status: 502 });
    }
    const headers = new Headers({ "cache-control": "no-store" });
    const type = res.headers.get("content-type");
    if (type) headers.set("content-type", type);
    if (type?.startsWith("image/")) { headers.set("cache-control", "private, max-age=3600"); headers.set("x-content-type-options", "nosniff"); }
    return new Response(await res.arrayBuffer(), { status: res.status, headers });
  };
}

/** The page's request as an envelope; null when its body is over what the bus carries. */
export async function envelopeOf(req: Request, path: string): Promise<Envelope | null | "too-large"> {
  const method = req.method.toUpperCase();
  const base = readEnvelope({ method, path });
  if (!base) return null;
  if (method === "GET") return base;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_FORWARD_BYTES) return "too-large";
  const contentType = req.headers.get("content-type") ?? undefined;
  return { ...base, ...(contentType ? { contentType } : {}), ...(bytes.byteLength ? { body64: Buffer.from(bytes).toString("base64") } : {}) };
}
