import { get } from "@vercel/edge-config";

// Is admin sign-in currently closed? Two ways to flip it:
//  - Edge Config key `admin_login_disabled` (true/false). Flip it in the Vercel
//    dashboard and it takes effect in seconds with NO redeploy. This is the easy
//    on/off switch.
//  - ADMIN_LOGIN_DISABLED=true env var. A backup that needs a redeploy.
// Fails open: if the flag cannot be read, sign-in stays available so nobody is
// locked out by an infrastructure hiccup.
export async function isAdminLoginDisabled(): Promise<boolean> {
  if (process.env.ADMIN_LOGIN_DISABLED === "true") return true;
  if (!process.env.EDGE_CONFIG) return false;
  try {
    const value = await get("admin_login_disabled");
    return value === true || value === "true";
  } catch {
    return false;
  }
}
