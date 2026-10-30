import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import {
  attemptLogin,
  audit,
  buildSessionPayload,
  COOKIE_NAME,
  extractClientIp,
  getSession,
  isLoginRateLimited,
  loginAttemptsRemaining,
  recordLoginAttempt,
  SESSION_TTL_SECONDS,
  signSession,
} from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Temporary kill-switch. Set ADMIN_LOGIN_DISABLED=true on Vercel to close
  // sign-in for everyone (for example during an active attack), unset to reopen.
  if (process.env.ADMIN_LOGIN_DISABLED === "true") {
    return NextResponse.json(
      { error: "Sign-in is temporarily disabled. Please try again later." },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const { email, password } = body as { email?: unknown; password?: unknown };
  // Coerce to strings before any string work. Attackers send arrays/objects as
  // email/password to crash the handler, so never call string methods on raw
  // input.
  const emailStr = typeof email === "string" ? email : "";
  const passwordStr = typeof password === "string" ? password : "";

  const ip = extractClientIp(request) ?? "unknown";
  const ua = request.headers.get("user-agent")?.slice(0, 200) ?? undefined;
  // Rate-limit key. Email-based makes brute force slower per account;
  // IP-based catches credential stuffing. We combine both.
  const rateKey = `${ip}|${emailStr.toLowerCase()}`;
  const ts = new Date().toISOString();

  if (!passwordStr) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }

  if (isLoginRateLimited(rateKey)) {
    audit({
      type: "auth.login.rate_limited",
      ts,
      email: emailStr || undefined,
      ip,
      user_agent: ua,
    });
    return NextResponse.json(
      {
        error:
          "Too many failed sign-in attempts. Please wait 15 minutes and try again.",
      },
      { status: 429 },
    );
  }

  const result = await attemptLogin(emailStr || undefined, passwordStr);

  if (!result.ok) {
    recordLoginAttempt(rateKey, false);
    audit({
      type: "auth.login.failure",
      ts,
      email: emailStr || undefined,
      ip,
      user_agent: ua,
      reason: result.reason,
    });

    if (result.reason === "not_configured") {
      return NextResponse.json(
        {
          error:
            "Admin auth is not configured on this server. Set PORTEA_USERS_JSON (and PORTEA_AUTH_SECRET) on Vercel.",
        },
        { status: 500 },
      );
    }
    const remaining = loginAttemptsRemaining(rateKey);
    const tail = remaining > 0 ? ` ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.` : "";
    return NextResponse.json(
      { error: `Incorrect email or password.${tail}` },
      { status: 401 },
    );
  }

  recordLoginAttempt(rateKey, true);
  audit({
    type: "auth.login.success",
    ts,
    email: result.user.email,
    user_id: result.user.id,
    ip,
    user_agent: ua,
  });

  const payload = buildSessionPayload(result.user);
  const token = signSession(payload);

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.json({
    success: true,
    user: {
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
      must_change_password: result.user.mustChangePassword,
    },
  });
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
  return NextResponse.json({
    authenticated: true,
    user: {
      email: session.email,
      name: session.name,
      role: session.role,
      exp: session.exp,
    },
  });
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (session) {
    audit({
      type: "auth.logout",
      ts: new Date().toISOString(),
      email: session.email,
      user_id: session.sub,
      ip: extractClientIp(request) ?? undefined,
    });
  }
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
  return NextResponse.json({ success: true });
}
