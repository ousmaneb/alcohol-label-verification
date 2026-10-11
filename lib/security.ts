// Author: Dr. Ousmane Barry
/**
 * lib/security.ts — access control and abuse limits for /api/verify.
 *
 * Every call to /api/verify spends Anthropic credits, so the route must not
 * be usable by anyone who can merely reach the server. This module provides:
 *
 *   - checkAccess(): optional HTTP Basic auth gate (APP_ACCESS_PASSWORD).
 *     In production the API refuses to serve without it unless
 *     ALLOW_UNAUTHENTICATED=true is set explicitly (e.g. when Azure App
 *     Service Authentication / an SSO proxy already protects the site).
 *   - getClientIp(): the client IP, read only from headers the hosting
 *     platform controls, never the spoofable left-most X-Forwarded-For entry.
 *   - FixedWindowLimiter / DailyCap: in-memory per-IP rate limiting and a
 *     global daily request cap (a simple spend ceiling).
 *
 * Pure functions with injectable env/clock so they can be unit tested with
 * plain Node (see tests/security.test.mts). No Node-only imports, so this
 * file also works in the middleware runtime.
 */

export type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Constant-time string comparison (no early exit on the first mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function isTrue(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}

export type AccessDecision =
  | { ok: true }
  // 401: credentials missing or wrong; the browser shows its login prompt.
  | { ok: false; status: 401 }
  // 503: production deployment with no access control configured.
  | { ok: false; status: 503 };

/**
 * Decides whether a request may proceed.
 *
 * - APP_ACCESS_PASSWORD set: require HTTP Basic auth with that password
 *   (username must equal APP_ACCESS_USER when set; otherwise any username).
 * - Not set, NODE_ENV !== "production": open (local development).
 * - Not set, production: refuse (503) unless ALLOW_UNAUTHENTICATED=true.
 */
export function checkAccess(
  authorizationHeader: string | null,
  env: Env
): AccessDecision {
  const password = env.APP_ACCESS_PASSWORD;
  if (!password) {
    if (env.NODE_ENV !== "production" || isTrue(env.ALLOW_UNAUTHENTICATED)) {
      return { ok: true };
    }
    return { ok: false, status: 503 };
  }

  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorizationHeader ?? "");
  if (!match) return { ok: false, status: 401 };
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(
      Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0))
    );
  } catch {
    return { ok: false, status: 401 };
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return { ok: false, status: 401 };
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  // Evaluate both comparisons so timing does not reveal which one failed.
  const userOk = env.APP_ACCESS_USER ? safeEqual(user, env.APP_ACCESS_USER) : true;
  const passOk = safeEqual(pass, password);
  return userOk && passOk ? { ok: true } : { ok: false, status: 401 };
}

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

type HeaderGetter = { get(name: string): string | null };

/** Strips an optional port ("1.2.3.4:5678", "[::1]:443") and whitespace. */
function cleanIp(raw: string): string {
  let ip = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) return bracketed[1];
  // IPv4 with port (exactly one colon). Bare IPv6 has several colons.
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  return ip;
}

/**
 * Returns the client IP, or "unknown" when no trustworthy source exists.
 *
 * Sources, in order:
 *  1. CLIENT_IP_HEADER (e.g. "x-real-ip", "cf-connecting-ip"): a header your
 *     proxy sets and overwrites. Only set this if clients cannot forge it.
 *  2. On Vercel (VERCEL env set): x-vercel-forwarded-for / x-real-ip, which
 *     Vercel's edge sets and overwrites.
 *  3. TRUST_PROXY_HOPS = N (> 0): the N-th entry from the RIGHT of
 *     X-Forwarded-For, i.e. the address the outermost trusted proxy saw.
 *     Defaults to 1 on Azure App Service (WEBSITE_SITE_NAME set), whose
 *     front end appends exactly one entry; 0 elsewhere.
 *
 * The left-most X-Forwarded-For entry is never used: clients control it.
 */
export function getClientIp(headers: HeaderGetter, env: Env): string {
  const custom = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (custom) {
    const v = headers.get(custom);
    if (v) return cleanIp(v.split(",")[0]);
    return "unknown";
  }

  if (env.VERCEL) {
    const v = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
    if (v) return cleanIp(v.split(",")[0]);
  }

  const defaultHops = env.WEBSITE_SITE_NAME ? 1 : 0;
  const parsed = Number.parseInt(env.TRUST_PROXY_HOPS ?? "", 10);
  const hops = Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultHops;
  if (hops > 0) {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      const entry = parts[parts.length - hops];
      if (entry) return cleanIp(entry);
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Fixed-window counter per key, held in memory. Per server instance: on a
 * multi-instance or serverless deployment each instance counts separately,
 * so the effective limit is (limit x instances). Good enough to stop a
 * single runaway client; use a shared store (e.g. Redis) for hard limits.
 */
export class FixedWindowLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private limit: number;
  private windowMs: number;
  private now: () => number;
  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Records one hit. Returns retryAfter seconds when over the limit. */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const t = this.now();
    if (this.windows.size > 10_000) this.prune(t);
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)),
      };
    }
    w.count++;
    return { allowed: true };
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) {
      if (t - w.start >= this.windowMs) this.windows.delete(k);
    }
  }
}

/** Global cap on requests per UTC day (per server instance). */
export class DailyCap {
  private day = "";
  private count = 0;
  private cap: number;
  private now: () => number;
  constructor(cap: number, now: () => number = Date.now) {
    this.cap = cap;
    this.now = now;
  }

  /** Records one request; false when today's cap is already reached. */
  take(): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.count >= this.cap) return false;
    this.count++;
    return true;
  }
}

/** Reads a non-negative integer env var, falling back on bad/missing input. */
export function intFromEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
