// Server-side lead store, backed by Postgres.
//
// Uses the `pg` driver via @/lib/db. DO NOT import this file from a
// "use client" component. Client code that only needs the types should
// import from "@/lib/lead-types" instead.

import { execute, query } from "@/lib/db";
import {
  LIFECYCLE_STATUSES,
  type AiBrief,
  type CarePlan,
  type LeadAttribution,
  type LeadRecord,
  type LeadRoutedTo,
  type LifecycleStatus,
} from "@/lib/lead-types";

// Re-export types for files that already import from "@/lib/lead-store".
export {
  LIFECYCLE_STATUSES,
  type AiBrief,
  type CarePlan,
  type LeadAttribution,
  type LeadKind,
  type LeadRecord,
  type LeadRoutedTo,
  type LifecycleStatus,
} from "@/lib/lead-types";

type LeadRow = {
  id: string;
  kind: string;
  created_at: Date | string;
  vertical: string | null;
  full_name: string | null;
  phone: string | null;
  city: string | null;
  elder_name: string | null;
  condition: string | null;
  needs: string | null;
  relationship: string | null;
  situation: string | null;
  ab_variant: string | null;
  consent_given: boolean | null;
  status: string | null;
  care_manager: string | null;
  follow_up_date: string | null;
  click_target: string | null;
  user_agent: string | null;
  ip_hash: string | null;
  attribution: LeadAttribution | null;
  notes: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
  ai_brief: AiBrief | null;
  ai_brief_at: Date | string | null;
  call_recording_url: string | null;
  call_observations: string | null;
  call_transcript: string | null;
  call_transcript_at: Date | string | null;
  care_plan: CarePlan | null;
  care_plan_at: Date | string | null;
  care_plan_notes: string | null;
  routed_to: string | null;
  sales_forwarded_at: Date | string | null;
  sales_forward_status: string | null;
};

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToLead(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    kind: (row.kind as LeadRecord["kind"]) || "intake",
    created_at: toIso(row.created_at) ?? new Date().toISOString(),
    vertical: row.vertical ?? undefined,
    full_name: row.full_name ?? undefined,
    phone: row.phone ?? undefined,
    city: row.city ?? undefined,
    elder_name: row.elder_name ?? undefined,
    condition: row.condition ?? undefined,
    needs: row.needs ?? undefined,
    relationship: row.relationship ?? undefined,
    situation: row.situation ?? undefined,
    ab_variant: row.ab_variant ?? undefined,
    consent_given: row.consent_given ?? undefined,
    status: ((row.status as LifecycleStatus) || "new") as LifecycleStatus,
    care_manager: row.care_manager ?? undefined,
    follow_up_date: row.follow_up_date ?? undefined,
    click_target: row.click_target ?? undefined,
    user_agent: row.user_agent ?? undefined,
    ip_hash: row.ip_hash ?? undefined,
    attribution: row.attribution ?? {},
    ai_brief: row.ai_brief ?? undefined,
    ai_brief_at: toIso(row.ai_brief_at),
    notes: row.notes ?? undefined,
    call_recording_url: row.call_recording_url ?? undefined,
    call_observations: row.call_observations ?? undefined,
    call_transcript: row.call_transcript ?? undefined,
    call_transcript_at: toIso(row.call_transcript_at),
    care_plan: row.care_plan ?? undefined,
    care_plan_at: toIso(row.care_plan_at),
    care_plan_notes: row.care_plan_notes ?? undefined,
    routed_to: (row.routed_to as LeadRecord["routed_to"]) ?? undefined,
    sales_forwarded_at: toIso(row.sales_forwarded_at),
    sales_forward_status: row.sales_forward_status ?? undefined,
  };
}

// --- Writing ---------------------------------------------------------------

export async function appendLead(record: LeadRecord): Promise<void> {
  await execute(
    `INSERT INTO leads (
      id, kind, created_at, vertical, full_name, phone, city,
      elder_name, condition, needs, relationship, situation, ab_variant,
      consent_given, status, care_manager, follow_up_date,
      click_target, user_agent, ip_hash, attribution
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb
    )
    ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      record.kind || "intake",
      record.created_at,
      record.vertical ?? null,
      record.full_name ?? null,
      record.phone ?? null,
      record.city ?? null,
      record.elder_name ?? null,
      record.condition ?? null,
      record.needs ?? null,
      record.relationship ?? null,
      record.situation ?? null,
      record.ab_variant ?? null,
      record.consent_given ?? null,
      record.status ?? "new",
      record.care_manager ?? null,
      record.follow_up_date ?? null,
      record.click_target ?? null,
      record.user_agent ?? null,
      record.ip_hash ?? null,
      JSON.stringify(record.attribution ?? {}),
    ],
  );

  // Optional: dual-write to the Portea CRM when its endpoint is configured.
  // Dormant until PORTEA_CRM_API_URL is set. Best-effort, never blocks.
  void forwardToPorteaCrm(record);
}

async function forwardToPorteaCrm(record: LeadRecord) {
  const raw = process.env.PORTEA_CRM_API_URL?.trim();
  if (!raw) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  const apiKey = process.env.PORTEA_CRM_API_KEY?.trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Portea-Source": "portea-care-plan-lp",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...record, source: "portea-care-plan-lp" }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[lead-store] CRM forward failed", err);
  }
}

// --- Reading ---------------------------------------------------------------

export async function readLeads(limit = 500): Promise<LeadRecord[]> {
  const rows = await query<LeadRow>(
    `SELECT * FROM leads ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToLead);
}

export async function getLeadById(id: string): Promise<LeadRecord | null> {
  const rows = await query<LeadRow>(`SELECT * FROM leads WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ? rowToLead(rows[0]) : null;
}

// How many leads this IP (hashed) created since `sinceIso`. Used by the intake
// endpoint for per-IP rate limiting.
export async function countRecentByIpHash(
  ipHash: string,
  sinceIso: string,
): Promise<number> {
  const rows = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM leads WHERE ip_hash = $1 AND created_at >= $2`,
    [ipHash, sinceIso],
  );
  return rows[0]?.c ?? 0;
}

// --- Updating --------------------------------------------------------------

export type LeadUpdate = {
  id: string;
  status?: LifecycleStatus;
  care_manager?: string;
  follow_up_date?: string;
  note?: string;
  call_recording_url?: string;
  call_observations?: string;
  updated_by?: string;
};

export async function updateLead(update: LeadUpdate): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (update.status !== undefined) {
    sets.push(`status = $${i++}`);
    params.push(update.status);
  }
  if (update.care_manager !== undefined) {
    sets.push(`care_manager = $${i++}`);
    params.push(update.care_manager);
  }
  if (update.follow_up_date !== undefined) {
    sets.push(`follow_up_date = $${i++}`);
    params.push(update.follow_up_date || null);
  }
  if (update.note && update.note.trim()) {
    const stamped = `[${new Date().toISOString()}] ${update.note.trim()}`;
    sets.push(
      `notes = CASE WHEN notes IS NULL OR notes = '' THEN $${i} ELSE notes || E'\\n' || $${i} END`,
    );
    params.push(stamped);
    i++;
  }
  if (update.call_recording_url !== undefined) {
    sets.push(`call_recording_url = $${i++}`);
    params.push(update.call_recording_url || null);
  }
  if (update.call_observations !== undefined) {
    sets.push(`call_observations = $${i++}`);
    params.push(update.call_observations || null);
  }
  if (update.updated_by !== undefined) {
    sets.push(`updated_by = $${i++}`);
    params.push(update.updated_by);
  }

  // Nothing meaningful to change.
  if (sets.length === 0) return false;

  sets.push(`updated_at = now()`);
  params.push(update.id);

  const rowCount = await execute(
    `UPDATE leads SET ${sets.join(", ")} WHERE id = $${i}`,
    params,
  );
  return rowCount > 0;
}

// Patch the intake-side fields of an existing lead. Used by the intake route
// when the chatbot first captures name + phone early (a partial create) and
// then comes back to fill in the remaining details once the visitor finishes.
// Only fields that are explicitly provided (not undefined) are overwritten, so
// the early placeholders survive for anything the visitor never reached.
export type LeadIntakeUpdate = {
  id: string;
  full_name?: string;
  phone?: string;
  city?: string;
  vertical?: string;
  situation?: string;
  ab_variant?: string;
  elder_name?: string;
  condition?: string;
  needs?: string;
  relationship?: string;
  consent_given?: boolean;
  attribution?: LeadAttribution;
};

export async function updateLeadIntake(update: LeadIntakeUpdate): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    params.push(val);
  };

  if (update.full_name !== undefined) set("full_name", update.full_name);
  if (update.phone !== undefined) set("phone", update.phone);
  if (update.city !== undefined) set("city", update.city);
  if (update.vertical !== undefined) set("vertical", update.vertical);
  if (update.situation !== undefined) set("situation", update.situation);
  if (update.ab_variant !== undefined) set("ab_variant", update.ab_variant);
  if (update.elder_name !== undefined) set("elder_name", update.elder_name);
  if (update.condition !== undefined) set("condition", update.condition);
  if (update.needs !== undefined) set("needs", update.needs);
  if (update.relationship !== undefined) set("relationship", update.relationship);
  if (update.consent_given !== undefined) set("consent_given", update.consent_given);
  if (update.attribution !== undefined) {
    sets.push(`attribution = $${i++}::jsonb`);
    params.push(JSON.stringify(update.attribution));
  }

  if (sets.length === 0) return false;

  sets.push(`updated_at = now()`);
  params.push(update.id);

  const rowCount = await execute(
    `UPDATE leads SET ${sets.join(", ")} WHERE id = $${i}`,
    params,
  );
  return rowCount > 0;
}

// Record how a lead was routed. For paid leads forwarded to the sales team's
// ops webhook, routedTo is "sales", forwardStatus is the webhook outcome, and
// sales_forwarded_at is stamped. For organic leads, routedTo is "care_team".
export async function markLeadRouted(
  id: string,
  routedTo: LeadRoutedTo,
  forwardStatus?: string,
): Promise<boolean> {
  const rowCount = await execute(
    `UPDATE leads
        SET routed_to = $1,
            sales_forward_status = $2,
            sales_forwarded_at = CASE WHEN $1 = 'sales' THEN now() ELSE sales_forwarded_at END,
            updated_at = now()
      WHERE id = $3`,
    [routedTo, forwardStatus ?? null, id],
  );
  return rowCount > 0;
}

// Save a transcript and the time it was generated. Used by the transcribe
// route after Gemini returns successfully.
export async function updateLeadTranscript(
  id: string,
  transcript: string,
): Promise<boolean> {
  const rowCount = await execute(
    `UPDATE leads SET call_transcript = $1, call_transcript_at = now(), updated_at = now() WHERE id = $2`,
    [transcript, id],
  );
  return rowCount > 0;
}

// Persist a generated AI pre-call brief for one lead.
export async function updateLeadBrief(id: string, brief: AiBrief): Promise<boolean> {
  const rowCount = await execute(
    `UPDATE leads SET ai_brief = $1::jsonb, ai_brief_at = now() WHERE id = $2`,
    [JSON.stringify(brief), id],
  );
  return rowCount > 0;
}

// Persist a generated care plan plus the doctor's notes it was built from.
export async function updateLeadCarePlan(
  id: string,
  plan: CarePlan,
  notes: string,
): Promise<boolean> {
  const rowCount = await execute(
    `UPDATE leads SET care_plan = $1::jsonb, care_plan_at = now(), care_plan_notes = $2, updated_at = now() WHERE id = $3`,
    [JSON.stringify(plan), notes.trim() || null, id],
  );
  return rowCount > 0;
}

// --- Utilities -------------------------------------------------------------

export function maskPhone(phone?: string) {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `${digits.slice(0, 2)}******${digits.slice(-2)}`;
}
