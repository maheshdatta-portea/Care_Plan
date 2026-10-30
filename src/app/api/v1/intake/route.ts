import { randomUUID } from "node:crypto";

import { NextResponse, after } from "next/server";

import { isValidIndianMobile, normalizePhone } from "@/lib/chatbot";
import { verticals, type VerticalSlug } from "@/data/verticals";
import {
  appendLead,
  updateLeadIntake,
  getLeadById,
  markLeadRouted,
  maskPhone,
  countRecentByIpHash,
  type LeadAttribution,
} from "@/lib/lead-store";
import { classifyLeadSource } from "@/lib/lead-source";
import { forwardLeadToSales } from "@/lib/forward-to-sales";
import { notifyNewLead } from "@/lib/notify";
import { clientIp, ipHashOf, verifyRecaptcha } from "@/lib/intake-guard";

type IntakePayload = {
  full_name?: string;
  phone?: string;
  city?: string;
  situation?: string;
  vertical?: string;
  ab_variant?: string;
  elder_name?: string;
  condition?: string;
  needs?: string;
  relationship?: string;
  consent_given?: boolean;
  attribution?: LeadAttribution;
  // Early-capture support. `partial` marks the first save, made as soon as we
  // have name + phone, so a visitor who drops off mid-chat is never lost. The
  // backend returns the new lead's id; the client sends it back as `lead_id`
  // on the final submit so we patch that same row instead of creating a dupe.
  lead_id?: string;
  partial?: boolean;
  // reCAPTCHA v3 token from the browser. Verified server-side when keys are set.
  recaptcha_token?: string;
};

// Shown in the dashboard for fields the visitor has not reached yet on a
// partial (early-capture) lead. The care manager sees the lead immediately and
// these get overwritten the moment the visitor finishes the chat.
const PENDING = "Awaiting details";

function isVerticalSlug(value: string): value is VerticalSlug {
  return value in verticals;
}

// A completed lead is routed by source:
//  - paid   → forwarded to the sales team's ops webhook, flagged routed_to=sales.
//  - organic → stays with the care team; emailed unless it was already alerted
//    at partial-capture time (so organic leads are never double-emailed).
// Re-reads the lead so the forward payload reflects the final merged row (esp.
// on the partial → complete patch path). Best-effort; never throws.
async function routeCompletedLead(leadId: string, alreadyAlerted: boolean) {
  try {
    const lead = await getLeadById(leadId);
    if (!lead) return;

    if (classifyLeadSource(lead.attribution) === "paid") {
      const result = await forwardLeadToSales(lead);
      if (result.ok) {
        await markLeadRouted(leadId, "sales", result.status);
        return;
      }
      // Forward not delivered (webhook unset, HTTP error, or timeout). Never
      // drop a paid lead: fall back to the care team, record why, and alert.
      await markLeadRouted(leadId, "care_team", result.status);
      if (!alreadyAlerted) {
        await notifyNewLead({
          vertical: lead.vertical,
          city: lead.city,
          name: lead.full_name,
          phone: lead.phone,
        });
      }
      return;
    }

    await markLeadRouted(leadId, "care_team");
    if (!alreadyAlerted) {
      await notifyNewLead({ vertical: lead.vertical, city: lead.city });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[intake] routing failed (non-fatal)", err);
  }
}

// Early "new lead" alert fired the moment we have a name + phone (partial
// capture). Only organic leads are emailed here; paid leads wait for a
// completed submit (with consent + city) before being forwarded to sales,
// because the ops webhook overrides DND on the number.
async function earlyLeadAlert(
  leadId: string,
  attribution: LeadAttribution | undefined,
  vertical: string,
  city: string,
  name: string,
  phone: string,
) {
  try {
    if (classifyLeadSource(attribution) === "paid") return;
    await markLeadRouted(leadId, "care_team");
    await notifyNewLead({ vertical, city, name, phone });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[intake] early alert failed (non-fatal)", err);
  }
}

export async function POST(request: Request) {
  let body: IntakePayload;
  try {
    body = (await request.json()) as IntakePayload;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // --- Anti-abuse guard (runs on every submission, partial or final). ---
  const ip = clientIp(request);

  // 1. reCAPTCHA v3. Only enforced once RECAPTCHA_SECRET_KEY is set; until then
  //    this is a no-op, so the form keeps working. A real browser on our page
  //    produces a valid token; scripted floods from any IP cannot, so they are
  //    rejected here.
  const recaptcha = await verifyRecaptcha(body.recaptcha_token, ip);
  if (!recaptcha.ok) {
    // eslint-disable-next-line no-console
    console.warn("[intake] reCAPTCHA rejected", recaptcha.reason);
    return NextResponse.json(
      {
        error:
          "We could not verify your submission. Please reload the page and try again, or call us.",
      },
      { status: 403 },
    );
  }

  // 2. Per-IP rate limit (coarse backup). Caps bulk submissions from one IP in a
  //    short window. Never blocks a request if the count query itself fails.
  const ipHash = ipHashOf(ip);
  const rlMax = Number(process.env.INTAKE_RATE_LIMIT_MAX || "12");
  const rlWindowMin = Number(process.env.INTAKE_RATE_LIMIT_WINDOW_MIN || "10");
  if (ip !== "unknown") {
    try {
      const sinceIso = new Date(Date.now() - rlWindowMin * 60_000).toISOString();
      const recent = await countRecentByIpHash(ipHash, sinceIso);
      if (recent >= rlMax) {
        // eslint-disable-next-line no-console
        console.warn("[intake] rate limited", { recent, rlMax });
        return NextResponse.json(
          {
            error:
              "Too many requests from your network. Please try again in a few minutes, or call us.",
          },
          { status: 429 },
        );
      }
    } catch {
      /* rate-limit check is best-effort; do not block real users on a DB hiccup */
    }
  }

  const partial = body.partial === true;
  const leadId = body.lead_id?.trim() ?? "";

  const fullName = body.full_name?.trim() ?? "";
  const phone = body.phone?.trim() ?? "";
  const city = body.city?.trim() ?? "";
  const vertical = body.vertical?.trim() ?? "";

  // Name + phone + a valid vertical are required on every call, partial or not:
  // they are the minimum a care manager needs to make contact.
  if (!fullName || !phone || !vertical) {
    return NextResponse.json(
      { error: "Please share your name, phone and the care program." },
      { status: 400 },
    );
  }

  if (!isVerticalSlug(vertical)) {
    return NextResponse.json(
      { error: "Please provide a valid care vertical." },
      { status: 400 },
    );
  }

  if (!isValidIndianMobile(phone)) {
    return NextResponse.json(
      { error: "Please provide a valid 10-digit Indian mobile number (starts with 6, 7, 8 or 9)." },
      { status: 400 },
    );
  }
  const normalizedPhone = normalizePhone(phone);

  // City and consent are only enforced on the final submit. A partial early
  // capture happens before the visitor has necessarily reached those, and the
  // whole point is to not block on them.
  if (!partial) {
    if (!city) {
      return NextResponse.json(
        { error: "Please share the elder's city or area." },
        { status: 400 },
      );
    }
    if (!body.consent_given) {
      return NextResponse.json(
        { error: "We need your consent to call you back." },
        { status: 400 },
      );
    }
  }

  const receivedAt = new Date().toISOString();

  // The chatbot builds a rich narrative on the final submit. Before that, mark
  // the lead clearly as an early capture so a care manager knows the detail is
  // still incomplete.
  const situation =
    body.situation?.trim() ||
    (partial
      ? "Early capture: visitor shared name and phone but had not finished the chat. Care manager to gather full details on call."
      : "Landing page lead. Care manager to gather details on call.");

  // --- Update path: this lead already exists from an earlier partial capture.
  // Patch it with whatever we now have rather than inserting a duplicate.
  if (leadId) {
    try {
      const updated = await updateLeadIntake({
        id: leadId,
        full_name: fullName,
        phone: normalizedPhone,
        city: city || undefined,
        vertical,
        situation,
        ab_variant: body.ab_variant?.trim() || undefined,
        elder_name: body.elder_name?.trim() || undefined,
        condition: body.condition?.trim() || undefined,
        needs: body.needs?.trim() || undefined,
        relationship: body.relationship?.trim() || undefined,
        consent_given: body.consent_given ?? undefined,
        attribution: body.attribution,
      });

      if (updated) {
        // eslint-disable-next-line no-console
        console.log("[intake] patched", {
          patient_id: leadId,
          vertical,
          partial,
          phone: maskPhone(normalizedPhone),
        });
        // A patch that completes the lead (not another partial) is the point at
        // which we route it. The partial-create already sent the organic early
        // alert, so pass alreadyAlerted=true to avoid a second email; paid leads
        // are forwarded to sales here (their first external send).
        if (!partial) {
          after(() => routeCompletedLead(leadId, true));
        }
        return NextResponse.json({
          patient_id: leadId,
          status: "new",
          submittedAt: receivedAt,
          updated: true,
        });
      }
      // Row vanished (e.g. pruned). Fall through and create a fresh one.
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[intake] failed to patch lead", err);
      return NextResponse.json(
        { error: "We couldn't save your request. Please try again or call us." },
        { status: 503 },
      );
    }
  }

  // --- Create path: a fresh lead. For a partial capture, fill the fields the
  // visitor has not reached with a clear placeholder so the row is usable.
  const patientId = randomUUID();

  try {
    await appendLead({
      id: patientId,
      kind: "intake",
      created_at: receivedAt,
      vertical,
      full_name: fullName,
      phone: normalizedPhone,
      city: city || (partial ? PENDING : ""),
      situation,
      ab_variant: body.ab_variant?.trim() || undefined,
      elder_name: body.elder_name?.trim() || (partial ? PENDING : undefined),
      condition: body.condition?.trim() || (partial ? PENDING : undefined),
      needs: body.needs?.trim() || (partial ? PENDING : undefined),
      relationship: body.relationship?.trim() || (partial ? PENDING : undefined),
      consent_given: body.consent_given ?? (partial ? false : true),
      status: "new",
      attribution: body.attribution ?? {},
      ip_hash: ipHash,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[intake] failed to save lead", err);
    return NextResponse.json(
      { error: "We couldn't save your request. Please try again or call us." },
      { status: 503 },
    );
  }

  // eslint-disable-next-line no-console
  console.log("[intake]", {
    patient_id: patientId,
    vertical,
    partial,
    ab_variant: body.ab_variant ?? null,
    city: city || null,
    phone: maskPhone(normalizedPhone),
    utm_source: body.attribution?.utm_source ?? null,
    utm_campaign: body.attribution?.utm_campaign ?? null,
  });

  // Route the fresh lead by source. Runs via after() so the serverless function
  // stays alive until the email/webhook actually completes — a plain
  // fire-and-forget gets frozen on return and the outbound call is cut off.
  //  - Partial capture (name + phone only): organic leads get the early "new
  //    lead" email; paid leads wait for a completed submit before forwarding.
  //  - Completed submit in one shot: route now (paid → sales webhook, organic →
  //    care team + email). alreadyAlerted=false since there was no prior partial.
  if (partial) {
    after(() =>
      earlyLeadAlert(patientId, body.attribution, vertical, city, fullName, normalizedPhone),
    );
  } else {
    after(() => routeCompletedLead(patientId, false));
  }

  return NextResponse.json({
    patient_id: patientId,
    status: "new",
    submittedAt: receivedAt,
  });
}
