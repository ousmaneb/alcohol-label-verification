// Author: Dr. Ousmane Barry
/**
 * middleware.ts — access gate for the whole app.
 *
 * When APP_ACCESS_PASSWORD is set, every page and API call requires HTTP
 * Basic auth. The browser shows its native login prompt once and then sends
 * the credentials automatically with same-origin fetch() calls, so the UI
 * needs no changes. /api/verify re-checks access itself (defense in depth).
 *
 * In production without APP_ACCESS_PASSWORD, pages still load but
 * /api/verify answers 503 (see lib/security.ts checkAccess) unless
 * ALLOW_UNAUTHENTICATED=true.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkAccess } from "@/lib/security";

// Node runtime so process.env is read at request time (not inlined at build).
export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

let warned = false;

export function middleware(request: NextRequest) {
  const decision = checkAccess(request.headers.get("authorization"), process.env);
  if (decision.ok) return NextResponse.next();

  if (decision.status === 401) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="LabelProof", charset="UTF-8"' },
    });
  }

  // 503: production with no access control. Block only the paid API.
  if (!warned) {
    warned = true;
    console.error(
      "SECURITY: APP_ACCESS_PASSWORD is not set in production; /api/verify is " +
        "disabled. Set APP_ACCESS_PASSWORD, or ALLOW_UNAUTHENTICATED=true if an " +
        "upstream SSO/proxy already restricts access."
    );
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Server is not configured: access control is required (set APP_ACCESS_PASSWORD)." },
      { status: 503 }
    );
  }
  return NextResponse.next();
}
