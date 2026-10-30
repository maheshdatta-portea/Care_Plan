// Anti-abuse helpers for the public lead intake endpoint. Server-side only.
//
// Two layers:
//  - reCAPTCHA v3: the real defence against scripted/curl floods and attacks
//    spread across many IPs. A valid token can only be produced by a real
//    browser on our actual page, so token-less requests are rejected. Enforced
//    only when RECAPTCHA_SECRET_KEY is set, so the form keeps working until the
//    keys are added.
//  - Per-IP rate limiting: a coarse backup that caps how many submissions one
//    IP can make in a short window (handled by the route via countRecentByIpHash).

import { createHash } from "node:crypto";

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export function ipHashOf(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

export async function verifyRecaptcha(
  token: string | undefined,
  ip: string,
): Promise<{ ok: boolean; reason: string }> {
  const secret = process.env.RECAPTCHA_SECRET_KEY?.trim();
  // Not configured yet: skip so the live form is never blocked before keys exist.
  if (!secret) return { ok: true, reason: "not-configured" };
  if (!token) return { ok: false, reason: "missing-token" };

  try {
    const params = new URLSearchParams({ secret, response: token });
    if (ip && ip !== "unknown") params.set("remoteip", ip);
    const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as {
      success?: boolean;
      score?: number;
      "error-codes"?: string[];
    };
    const min = Number(process.env.RECAPTCHA_MIN_SCORE || "0.5");
    if (data.success && (data.score ?? 0) >= min) {
      return { ok: true, reason: `score:${data.score}` };
    }
    const codes = data["error-codes"]?.join(",");
    return { ok: false, reason: `rejected:${data.score ?? codes ?? "unknown"}` };
  } catch {
    // If Google is slow or unreachable, fail open so real users are not blocked.
    // Rate limiting still applies as the backstop.
    return { ok: true, reason: "verify-error-failopen" };
  }
}
