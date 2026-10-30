import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Edge IP denylist. Set BLOCKED_IPS on Vercel to a comma-separated list of IPs
// to reject at the edge, before any route runs. Example:
//   BLOCKED_IPS=149.28.117.219,203.0.113.4
// This is a backstop. The Vercel Firewall is the preferred place to block IPs
// (no redeploy needed), and reCAPTCHA is the real defence against rotating IPs.

const BLOCKED = (process.env.BLOCKED_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "";
}

export function middleware(req: NextRequest) {
  if (BLOCKED.length > 0) {
    const ip = clientIp(req);
    if (ip && BLOCKED.includes(ip)) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = {
  // Run on all paths except Next's static assets and the icons.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)"],
};
