// Author: Dr. Ousmane Barry
/**
 * tests/security.test.mts — unit tests for lib/security.ts.
 *
 * Run with: npm test
 * Covers: the Basic auth gate (dev open, production refuses without a
 * password, wrong/right credentials), client-IP selection (never the
 * spoofable left-most X-Forwarded-For entry), the per-IP limiter and the
 * daily cap.
 */
import {
  checkAccess,
  DailyCap,
  FixedWindowLimiter,
  getClientIp,
  intFromEnv,
  safeEqual,
} from "../lib/security.ts";

let failures = 0;
function expect(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(
      `FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
    );
  } else {
    console.log(`ok   ${name}`);
  }
}

const basic = (u: string, p: string) => "Basic " + btoa(`${u}:${p}`);
const hdrs = (h: Record<string, string>) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
});

// --- safeEqual
expect("safeEqual same", safeEqual("abc", "abc"), true);
expect("safeEqual diff", safeEqual("abc", "abd"), false);
expect("safeEqual prefix", safeEqual("abc", "abcd"), false);
expect("safeEqual empty vs x", safeEqual("", "x"), false);

// --- checkAccess
expect("dev without password is open", checkAccess(null, { NODE_ENV: "development" }), { ok: true });
expect("prod without password refuses", checkAccess(null, { NODE_ENV: "production" }), { ok: false, status: 503 });
expect(
  "prod explicit opt-out",
  checkAccess(null, { NODE_ENV: "production", ALLOW_UNAUTHENTICATED: "true" }),
  { ok: true }
);
const env = { NODE_ENV: "production", APP_ACCESS_PASSWORD: "s3cret:with:colons" };
expect("no header -> 401", checkAccess(null, env), { ok: false, status: 401 });
expect("wrong password -> 401", checkAccess(basic("a", "nope"), env), { ok: false, status: 401 });
expect("right password", checkAccess(basic("anyone", "s3cret:with:colons"), env), { ok: true });
expect("garbage header", checkAccess("Basic !!!", env), { ok: false, status: 401 });
expect("bearer scheme rejected", checkAccess("Bearer s3cret", env), { ok: false, status: 401 });
const envUser = { ...env, APP_ACCESS_USER: "ttb" };
expect("wrong user -> 401", checkAccess(basic("bob", "s3cret:with:colons"), envUser), { ok: false, status: 401 });
expect("right user", checkAccess(basic("ttb", "s3cret:with:colons"), envUser), { ok: true });
expect(
  "password also required in dev when set",
  checkAccess(null, { NODE_ENV: "development", APP_ACCESS_PASSWORD: "x" }),
  { ok: false, status: 401 }
);

// --- getClientIp
const spoofed = hdrs({ "x-forwarded-for": "6.6.6.6, 10.0.0.1, 203.0.113.9" });
expect("no proxy trust -> unknown", getClientIp(spoofed, {}), "unknown");
expect("1 hop -> right-most", getClientIp(spoofed, { TRUST_PROXY_HOPS: "1" }), "203.0.113.9");
expect("2 hops", getClientIp(spoofed, { TRUST_PROXY_HOPS: "2" }), "10.0.0.1");
expect("more hops than entries -> unknown", getClientIp(spoofed, { TRUST_PROXY_HOPS: "9" }), "unknown");
expect("azure default 1 hop", getClientIp(spoofed, { WEBSITE_SITE_NAME: "app" }), "203.0.113.9");
expect(
  "azure ip:port stripped",
  getClientIp(hdrs({ "x-forwarded-for": "6.6.6.6, 198.51.100.4:51234" }), { WEBSITE_SITE_NAME: "app" }),
  "198.51.100.4"
);
expect(
  "ipv6 untouched",
  getClientIp(hdrs({ "x-forwarded-for": "2001:db8::1" }), { TRUST_PROXY_HOPS: "1" }),
  "2001:db8::1"
);
expect(
  "vercel header",
  getClientIp(hdrs({ "x-vercel-forwarded-for": "192.0.2.7", "x-forwarded-for": "6.6.6.6" }), { VERCEL: "1" }),
  "192.0.2.7"
);
expect(
  "custom header",
  getClientIp(hdrs({ "cf-connecting-ip": "192.0.2.8" }), { CLIENT_IP_HEADER: "CF-Connecting-IP" }),
  "192.0.2.8"
);

// --- FixedWindowLimiter
let now = 0;
const limiter = new FixedWindowLimiter(2, 60_000, () => now);
expect("hit 1", limiter.hit("a"), { allowed: true });
expect("hit 2", limiter.hit("a"), { allowed: true });
expect("hit 3 blocked", limiter.hit("a"), { allowed: false, retryAfterSec: 60 });
expect("other key independent", limiter.hit("b"), { allowed: true });
now = 30_000;
expect("still blocked, retry 30s", limiter.hit("a"), { allowed: false, retryAfterSec: 30 });
now = 60_000;
expect("new window", limiter.hit("a"), { allowed: true });

// --- DailyCap
let t = Date.parse("2026-01-01T23:59:00Z");
const cap = new DailyCap(2, () => t);
expect("cap 1", cap.take(), true);
expect("cap 2", cap.take(), true);
expect("cap exceeded", cap.take(), false);
t = Date.parse("2026-01-02T00:00:01Z");
expect("cap resets next UTC day", cap.take(), true);

// --- intFromEnv
expect("intFromEnv default", intFromEnv(undefined, 5), 5);
expect("intFromEnv zero", intFromEnv("0", 5), 0);
expect("intFromEnv garbage", intFromEnv("abc", 5), 5);
expect("intFromEnv negative", intFromEnv("-3", 5), 5);

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll security tests passed.");
