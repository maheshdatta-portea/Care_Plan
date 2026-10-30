"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  ChatMessage,
  clearQuickFormData,
  emptyFields,
  IntakeFieldKey,
  IntakeFields,
  intakeSteps,
  isValidIndianMobile,
  readQuickFormData,
  sanitizePhoneInput,
} from "@/lib/chatbot";
import type { VerticalConfig } from "@/data/verticals";
import { getIntakeApiUrl } from "@/lib/api";
import { readAttribution } from "@/lib/utm";
import { getRecaptchaToken } from "@/lib/recaptcha";

type FlowPhase = "typing" | "awaiting-input" | "consent" | "submitting" | "submitted";

type PersistedState = {
  currentStep: number;
  fields: IntakeFields;
  messages: ChatMessage[];
  consentGiven: boolean;
  submittedAt: string | null;
  // Set once the lead has been created early (as soon as we have name + phone).
  // The final submit sends this back so the server patches the same row instead
  // of inserting a duplicate. Null until the early capture succeeds.
  leadId: string | null;
};

type FlowState = PersistedState & {
  isOpen: boolean;
  phase: FlowPhase;
  error: string | null;
};

type FlowAction =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "UPDATE_FIELD"; key: IntakeFieldKey; value: string }
  | { type: "PROMPT_READY" }
  | { type: "ANSWER"; value: string }
  | { type: "CONSENT_TOGGLE"; value: boolean }
  | { type: "EARLY_LEAD_CREATED"; leadId: string }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_SUCCESS"; submittedAt: string }
  | { type: "SUBMIT_ERROR"; error: string }
  | {
      type: "PREFILL_AND_OPEN";
      fields: Partial<IntakeFields>;
      consentGiven: boolean;
      intro?: string;
    }
  | { type: "RESET" };

const TOTAL_STEPS = intakeSteps.length;

const DIRECT_GREETING =
  "Hi, I'm Portea's care assistant. I'll ask a few quick questions, then a doctor-led care manager will be in touch shortly.";

// A clean, blank intake. Used both for the very first conversation and to
// restart after a previous request was already submitted.
function freshChat(open: boolean): FlowState {
  return {
    currentStep: 0,
    fields: { ...emptyFields },
    messages: [makeMessage("assistant", DIRECT_GREETING)],
    consentGiven: false,
    submittedAt: null,
    leadId: null,
    isOpen: open,
    phase: "typing",
    error: null,
  };
}

function makeMessage(role: ChatMessage["role"], text: string) {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
  };
}

// Find the index of the first step whose field is still empty. Used to skip
// over steps that the visible lead form already captured (city, name, phone).
function findNextEmptyStep(fields: IntakeFields, startIdx: number): number {
  for (let i = startIdx; i < TOTAL_STEPS; i++) {
    const key = intakeSteps[i].key;
    if (!fields[key] || !fields[key].trim()) return i;
  }
  return TOTAL_STEPS;
}

function sanitizePersistedState(raw: string | null): PersistedState {
  const blank: PersistedState = {
    currentStep: 0,
    fields: { ...emptyFields },
    messages: [],
    consentGiven: false,
    submittedAt: null,
    leadId: null,
  };

  if (!raw) return blank;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      currentStep:
        typeof parsed.currentStep === "number" &&
        parsed.currentStep >= 0 &&
        parsed.currentStep <= TOTAL_STEPS
          ? parsed.currentStep
          : 0,
      fields: { ...emptyFields, ...(parsed.fields ?? {}) },
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.filter(
            (m): m is ChatMessage =>
              Boolean(m) &&
              (m.role === "assistant" || m.role === "user") &&
              typeof m.text === "string" &&
              typeof m.id === "string",
          )
        : [],
      consentGiven: Boolean(parsed.consentGiven),
      submittedAt: typeof parsed.submittedAt === "string" ? parsed.submittedAt : null,
      leadId: typeof parsed.leadId === "string" ? parsed.leadId : null,
    };
  } catch {
    return blank;
  }
}

function derivePhase(state: PersistedState): FlowPhase {
  if (state.submittedAt) return "submitted";
  if (state.currentStep >= TOTAL_STEPS) return "consent";
  if (state.messages.length === 0) return "typing";
  return state.messages[state.messages.length - 1]?.role === "user"
    ? "typing"
    : "awaiting-input";
}

function createInitialState(storageKey: string, verticalSlug: string): FlowState {
  if (typeof window === "undefined") {
    return {
      currentStep: 0,
      fields: { ...emptyFields },
      messages: [],
      consentGiven: false,
      submittedAt: null,
      leadId: null,
      isOpen: false,
      phase: "typing",
      error: null,
    };
  }

  const persisted = sanitizePersistedState(window.localStorage.getItem(storageKey));
  const quickForm = readQuickFormData(verticalSlug);

  // The lead form just handed off three fields. Start a COMPLETELY FRESH
  // intake: only name/city/phone are pre-filled; the four elder questions
  // start empty so the chatbot always asks them. We deliberately ignore any
  // stale `persisted` state from a previous session, which would otherwise
  // make the chatbot skip questions or jump straight to the review screen.
  if (quickForm) {
    const freshFields: IntakeFields = {
      ...emptyFields,
      name: quickForm.name,
      city: quickForm.city,
      phone: quickForm.phone,
    };
    const currentStep = findNextEmptyStep(freshFields, 0);
    // Consume the handoff so a reload doesn't re-trigger it.
    clearQuickFormData(verticalSlug);
    return {
      currentStep,
      fields: freshFields,
      messages: [
        makeMessage(
          "assistant",
          `Thanks${quickForm.name ? `, ${quickForm.name.split(" ")[0]}` : ""}. A few quick questions and your care manager will be in touch shortly.`,
        ),
      ],
      consentGiven: quickForm.consentGiven,
      submittedAt: null,
      leadId: null,
      isOpen: true,
      phase: currentStep >= TOTAL_STEPS ? "consent" : "typing",
      error: null,
    };
  }

  // A previous request was already submitted in this browser. Don't resurrect
  // that stale "thank you" screen — it would leave the chatbot permanently
  // stuck on the acknowledgment. Start a fresh conversation instead.
  if (persisted.submittedAt) {
    return freshChat(false);
  }

  // Direct-chatbot path: if the user has never interacted, seed a friendly
  // greeting so the very first visible line isn't a question with no context.
  if (persisted.messages.length === 0) {
    return freshChat(false);
  }

  return {
    ...persisted,
    isOpen: false,
    phase: derivePhase(persisted),
    error: null,
  };
}

function reducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "OPEN":
      // If a request was already submitted, reopening should start a brand new
      // conversation rather than show the old "thank you" screen.
      if (state.submittedAt) return freshChat(true);
      return { ...state, isOpen: true, error: null };
    case "CLOSE":
      return { ...state, isOpen: false, error: null };
    case "UPDATE_FIELD":
      return {
        ...state,
        fields: { ...state.fields, [action.key]: action.value },
        error: null,
      };
    case "PROMPT_READY": {
      const step = intakeSteps[state.currentStep];
      if (!step || state.phase === "submitted") return state;
      const last = state.messages[state.messages.length - 1];
      if (last?.role === "assistant" && last.text === step.prompt) {
        return { ...state, phase: "awaiting-input" };
      }
      return {
        ...state,
        phase: "awaiting-input",
        messages: [...state.messages, makeMessage("assistant", step.prompt)],
      };
    }
    case "ANSWER": {
      const step = intakeSteps[state.currentStep];
      if (!step) return state;
      const nextFields = { ...state.fields, [step.key]: action.value };
      const nextMessages = [...state.messages, makeMessage("user", action.value)];
      const nextStepIdx = findNextEmptyStep(nextFields, state.currentStep + 1);
      const isDone = nextStepIdx >= TOTAL_STEPS;
      // When every question is answered, go to the review screen. The user
      // checks (and can edit) everything before the final submit.
      const nextPhase: FlowPhase = isDone ? "consent" : "typing";
      return {
        ...state,
        fields: nextFields,
        messages: nextMessages,
        currentStep: nextStepIdx,
        phase: nextPhase,
        error: null,
      };
    }
    case "CONSENT_TOGGLE":
      return { ...state, consentGiven: action.value, error: null };
    case "EARLY_LEAD_CREATED":
      // Ignore a late-arriving early-capture id once the lead is already
      // submitted, or if one is somehow already set.
      if (state.submittedAt || state.leadId) return state;
      return { ...state, leadId: action.leadId };
    case "SUBMIT_START":
      return { ...state, phase: "submitting", error: null };
    case "SUBMIT_SUCCESS":
      return {
        ...state,
        phase: "submitted",
        submittedAt: action.submittedAt,
        error: null,
      };
    case "SUBMIT_ERROR":
      // On failure, drop into the consent panel for both paths. The user sees
      // a clear error message and a Submit button to retry. In the auto-submit
      // path the consent box is already ticked, so retrying is one click.
      return { ...state, phase: "consent", error: action.error };
    case "PREFILL_AND_OPEN": {
      // Fresh intake from the three form fields only. We do NOT merge
      // state.fields, so stale answers from a previous chatbot session can't
      // make the bot skip the elder questions or jump to the review screen.
      const mergedFields: IntakeFields = { ...emptyFields, ...action.fields };
      const nextStepIdx = findNextEmptyStep(mergedFields, 0);
      const intro =
        action.intro ??
        `Thanks${action.fields.name ? `, ${action.fields.name.split(" ")[0]}` : ""}. A few quick questions and your care manager will be in touch shortly.`;
      return {
        ...state,
        fields: mergedFields,
        consentGiven: action.consentGiven,
        submittedAt: null,
        leadId: null,
        currentStep: nextStepIdx,
        messages: [makeMessage("assistant", intro)],
        isOpen: true,
        phase: nextStepIdx >= TOTAL_STEPS ? "consent" : "typing",
        error: null,
      };
    }
    case "RESET":
      return {
        currentStep: 0,
        fields: { ...emptyFields },
        messages: [],
        consentGiven: false,
        submittedAt: null,
        leadId: null,
        isOpen: true,
        phase: "typing",
        error: null,
      };
    default:
      return state;
  }
}

function currentStepNumber(state: FlowState) {
  return Math.min(state.currentStep + 1, TOTAL_STEPS);
}

export function IntakeChatbot({ vertical }: { vertical: VerticalConfig }) {
  const router = useRouter();

  // v2 bump after the step order was changed. Without this, anyone who
  // started the chatbot under the old order would resume on the wrong step.
  const storageKey = useMemo(() => `portea-intake-v2:${vertical.slug}`, [vertical.slug]);
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialState(storageKey, vertical.slug),
  );
  const [variant] = useState(() => (Math.random() < 0.5 ? "flow_a" : "flow_b"));
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  // Guards the early-capture POST so a re-render mid-flight can't fire it twice.
  const earlyCaptureInFlightRef = useRef(false);

  // Inline editing on the review screen.
  const [editingKey, setEditingKey] = useState<IntakeFieldKey | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const activeStep = intakeSteps[state.currentStep];
  const activeValue = activeStep ? state.fields[activeStep.key] : "";

  // Persist the in-progress chatbot state to localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const persisted: PersistedState = {
      currentStep: state.currentStep,
      fields: state.fields,
      messages: state.messages,
      consentGiven: state.consentGiven,
      submittedAt: state.submittedAt,
      leadId: state.leadId,
    };
    window.localStorage.setItem(storageKey, JSON.stringify(persisted));
  }, [
    state.currentStep,
    state.fields,
    state.messages,
    state.consentGiven,
    state.submittedAt,
    state.leadId,
    storageKey,
  ]);

  // Autoscroll
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.messages, state.phase, state.isOpen]);

  // Typing -> reveal next prompt
  useEffect(() => {
    if (!state.isOpen || state.phase !== "typing") return;
    const t = window.setTimeout(() => dispatch({ type: "PROMPT_READY" }), 380);
    return () => window.clearTimeout(t);
  }, [state.isOpen, state.phase, state.currentStep]);

  // Listen for the form -> chatbot handoff event (from the lead form and the
  // chatbot trigger buttons).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { vertical?: string; fields?: Partial<IntakeFields>; consentGiven?: boolean }
        | undefined;
      if (detail?.vertical && detail.vertical !== vertical.slug) return;
      const quick = detail?.fields ?? readQuickFormData(vertical.slug);
      if (quick) {
        dispatch({
          type: "PREFILL_AND_OPEN",
          fields: {
            name: quick.name ?? "",
            city: quick.city ?? "",
            phone: quick.phone ?? "",
          },
          consentGiven: detail?.consentGiven ?? Boolean((quick as { consentGiven?: boolean }).consentGiven),
        });
      } else {
        dispatch({ type: "OPEN" });
      }
    };
    window.addEventListener("portea:open-chatbot", handler as EventListener);
    return () => window.removeEventListener("portea:open-chatbot", handler as EventListener);
  }, [vertical.slug]);

  // Early lead capture. The moment we have a name and a valid phone, create the
  // lead in the background with placeholders for whatever the visitor has not
  // reached yet. Every step of friction has dropoffs, so as soon as we have a
  // name and number that lead must be saved. The server returns its id, which
  // the final submit sends back so the same row is patched (no duplicate).
  useEffect(() => {
    if (!state.isOpen || state.leadId || state.submittedAt) return;
    if (earlyCaptureInFlightRef.current) return;
    const name = state.fields.name?.trim();
    const phone = state.fields.phone?.trim();
    if (!name || !phone || !isValidIndianMobile(phone)) return;

    earlyCaptureInFlightRef.current = true;
    let cancelled = false;
    const run = async () => {
      try {
        const recaptchaToken = await getRecaptchaToken("intake_partial");
        const response = await fetch(getIntakeApiUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partial: true,
            full_name: name,
            phone,
            city: state.fields.city || undefined,
            vertical: vertical.slug,
            ab_variant: variant,
            elder_name: state.fields.elderName || undefined,
            condition: state.fields.condition || undefined,
            needs: state.fields.needs || undefined,
            relationship: state.fields.relationship || undefined,
            consent_given: state.consentGiven,
            attribution: readAttribution(),
            recaptcha_token: recaptchaToken,
          }),
        });
        const result = (await response.json()) as { patient_id?: string; error?: string };
        if (!response.ok) throw new Error(result.error || "early capture failed");
        if (!cancelled && result.patient_id) {
          dispatch({ type: "EARLY_LEAD_CREATED", leadId: result.patient_id });
        }
      } catch (err) {
        // Non-fatal: the final submit still creates the lead if this failed.
        // eslint-disable-next-line no-console
        console.warn("[intake] early lead capture failed", err);
      } finally {
        earlyCaptureInFlightRef.current = false;
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    state.isOpen,
    state.leadId,
    state.submittedAt,
    state.fields,
    state.consentGiven,
    vertical.slug,
    variant,
  ]);

  // Submit when entering the submitting phase.
  useEffect(() => {
    if (state.phase !== "submitting") return;
    let cancelled = false;
    const run = async () => {
      try {
        const recaptchaToken = await getRecaptchaToken("intake_submit");
        const response = await fetch(getIntakeApiUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Patch the early-captured row when we have its id; otherwise this
            // creates the lead fresh.
            lead_id: state.leadId ?? undefined,
            full_name: state.fields.name,
            phone: state.fields.phone,
            city: state.fields.city,
            situation: `${state.fields.condition}. Needs: ${state.fields.needs}. Elder: ${state.fields.elderName}. Caller: ${state.fields.name} (${state.fields.relationship}).`,
            vertical: vertical.slug,
            ab_variant: variant,
            elder_name: state.fields.elderName,
            condition: state.fields.condition,
            needs: state.fields.needs,
            relationship: state.fields.relationship,
            consent_given: true,
            attribution: readAttribution(),
            recaptcha_token: recaptchaToken,
          }),
        });
        const result = (await response.json()) as {
          error?: string;
          patient_id?: string;
          status?: string;
          submittedAt?: string;
        };
        if (!response.ok) throw new Error(result.error || "We couldn't submit your request.");
        if (cancelled) return;

        // Clear handoff data so a refresh doesn't re-trigger the chatbot
        clearQuickFormData(vertical.slug);

        dispatch({
          type: "SUBMIT_SUCCESS",
          submittedAt: result.submittedAt || new Date().toISOString(),
        });

        // Redirect to /thank-you, which fires generate_lead via GTM with the
        // full context. Single source of truth for the conversion event.
        const params = new URLSearchParams({
          source: "intake_chatbot",
          vertical: vertical.slug,
          ab_variant: variant,
        });
        if (result.patient_id) params.set("patient_id", result.patient_id);
        if (state.fields.city) params.set("city", state.fields.city);
        router.push(`/thank-you?${params.toString()}`);
      } catch (err) {
        if (!cancelled) {
          dispatch({
            type: "SUBMIT_ERROR",
            error: err instanceof Error ? err.message : "We couldn't submit your request.",
          });
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.fields, state.leadId, vertical.slug, variant, router]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeStep) return;
    const trimmed = activeValue.trim();
    if (!trimmed) {
      dispatch({ type: "SUBMIT_ERROR", error: `Please enter your ${activeStep.label}.` });
      return;
    }
    if (activeStep.key === "phone" && !isValidIndianMobile(trimmed)) {
      dispatch({
        type: "SUBMIT_ERROR",
        error: "Please enter a valid 10-digit Indian mobile number (starts with 6, 7, 8 or 9).",
      });
      return;
    }
    dispatch({ type: "ANSWER", value: trimmed });
  };

  const handleConsentSubmit = () => {
    if (editingKey) {
      setEditError("Please save or cancel your edit first.");
      return;
    }
    if (!state.consentGiven) {
      dispatch({ type: "SUBMIT_ERROR", error: "Please confirm consent so we can call you back." });
      return;
    }
    dispatch({ type: "SUBMIT_START" });
  };

  // Review-screen inline editing.
  function startEdit(key: IntakeFieldKey) {
    setEditingKey(key);
    setEditDraft(state.fields[key] ?? "");
    setEditError(null);
  }
  function cancelEdit() {
    setEditingKey(null);
    setEditError(null);
  }
  function saveEdit() {
    if (!editingKey) return;
    const trimmed = editDraft.trim();
    if (!trimmed) {
      setEditError("This can't be left empty.");
      return;
    }
    if (editingKey === "phone" && !isValidIndianMobile(trimmed)) {
      setEditError("Enter a valid 10-digit Indian mobile number.");
      return;
    }
    dispatch({ type: "UPDATE_FIELD", key: editingKey, value: trimmed });
    setEditingKey(null);
    setEditError(null);
  }

  return (
    <>
      {state.isOpen ? (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm"
            onClick={() => dispatch({ type: "CLOSE" })}
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`${vertical.name} intake chatbot`}
            className="absolute inset-0 flex md:inset-y-0 md:right-0 md:left-auto md:w-full md:max-w-md"
          >
            <div className="flex h-full max-h-[100dvh] w-full flex-col bg-white shadow-2xl md:rounded-l-[2rem]">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                      {state.phase === "submitted"
                        ? "Request received"
                        : state.phase === "submitting"
                          ? "Sending"
                          : state.phase === "consent"
                            ? "Almost done"
                            : `Step ${currentStepNumber(state)} of ${TOTAL_STEPS}`}
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-slate-900">
                      {vertical.name} · Care assistant
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "CLOSE" })}
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    aria-label="Close chat"
                  >
                    Close
                  </button>
                </div>
              </div>

              {state.phase === "submitted" ? (
                <div className="flex flex-1 flex-col justify-center px-5 py-8">
                  <div
                    className={`rounded-[2rem] border ${vertical.theme.border} bg-gradient-to-br ${vertical.theme.surface} p-6`}
                  >
                    <div
                      className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl text-white ${vertical.theme.accent}`}
                      aria-hidden="true"
                    >
                      ✓
                    </div>
                    <h3 className="text-2xl font-semibold text-slate-900">
                      Thank you, {state.fields.name || "there"}.
                    </h3>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      Your care manager will call you on{" "}
                      <span className="font-semibold text-slate-800">{state.fields.phone}</span>{" "}
                      shortly.
                    </p>
                    <div className="mt-6 flex gap-3">
                      <button
                        type="button"
                        onClick={() => dispatch({ type: "CLOSE" })}
                        className={`rounded-full px-4 py-2 text-sm font-semibold text-white transition ${vertical.theme.accentStrong}`}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                </div>
              ) : state.phase === "consent" ? (
                <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-6">
                  {/* Editable review */}
                  <div className="rounded-[1.5rem] border border-slate-200 p-5">
                    <p className="text-sm font-semibold text-slate-900">Review your details</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Tap Edit to change anything before you submit.
                    </p>
                    <ul className="mt-3 divide-y divide-slate-100">
                      {intakeSteps.map((step) => {
                        const isEditing = editingKey === step.key;
                        return (
                          <li key={step.key} className="py-2.5">
                            {isEditing ? (
                              <div className="space-y-2">
                                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                  {step.label}
                                </p>
                                <input
                                  type={step.type}
                                  value={editDraft}
                                  onChange={(e) =>
                                    setEditDraft(
                                      step.key === "phone"
                                        ? sanitizePhoneInput(e.target.value)
                                        : e.target.value,
                                    )
                                  }
                                  inputMode={step.key === "phone" ? "numeric" : undefined}
                                  className="w-full rounded-full border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                                />
                                {editError ? (
                                  <p className="text-xs font-medium text-rose-600">{editError}</p>
                                ) : null}
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={saveEdit}
                                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold text-white transition ${vertical.theme.accentStrong}`}
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelEdit}
                                    className="rounded-full border border-slate-200 px-3.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                    {step.label}
                                  </p>
                                  <p className="mt-0.5 break-words text-sm text-slate-800">
                                    {state.fields[step.key] || "Not added"}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => startEdit(step.key)}
                                  className="flex-none text-xs font-semibold text-[#0f9aa8] transition hover:underline"
                                >
                                  Edit
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  {/* Consent + submit */}
                  <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      One last thing
                    </p>
                    <h3 className="mt-2 text-lg font-semibold text-slate-900">
                      Confirm we can call you back
                    </h3>
                    <label className="mt-4 flex items-start gap-3 text-sm leading-6 text-slate-700">
                      <input
                        type="checkbox"
                        checked={state.consentGiven}
                        onChange={(e) =>
                          dispatch({ type: "CONSENT_TOGGLE", value: e.target.checked })
                        }
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                      />
                      <span>
                        I agree that Portea may contact me about home care for{" "}
                        <strong>{state.fields.elderName || "the elder"}</strong> on{" "}
                        <strong>{state.fields.phone || "the number I shared"}</strong>, and process
                        the information shared in this chat under Portea&apos;s privacy policy.
                      </span>
                    </label>

                    {state.error ? (
                      <p className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
                        {state.error}
                      </p>
                    ) : null}

                    <button
                      type="button"
                      onClick={handleConsentSubmit}
                      className={`mt-5 w-full rounded-full px-4 py-3 text-sm font-semibold text-white transition ${vertical.theme.accentStrong}`}
                    >
                      Submit and we'll be in touch shortly
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
                    {state.messages.map((message) => (
                      <div
                        key={message.id}
                        className={`max-w-[85%] rounded-[1.5rem] px-4 py-3 text-sm leading-6 shadow-sm ${
                          message.role === "assistant"
                            ? "rounded-tl-md bg-slate-100 text-slate-800"
                            : `${vertical.theme.accent} ml-auto rounded-tr-md text-white`
                        }`}
                      >
                        {message.text}
                      </div>
                    ))}

                    {state.phase === "typing" ? (
                      <div className="inline-flex items-center gap-2 rounded-[1.5rem] rounded-tl-md bg-slate-100 px-4 py-3 text-slate-500 shadow-sm">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.2s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.1s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
                      </div>
                    ) : null}

                    {state.phase === "submitting" ? (
                      <div className="inline-flex items-center gap-2 rounded-[1.5rem] rounded-tl-md bg-slate-100 px-4 py-3 text-sm text-slate-500 shadow-sm">
                        Sending your request...
                      </div>
                    ) : null}

                    <div ref={scrollAnchorRef} />
                  </div>

                  <div
                    className="border-t border-slate-200 px-5 pt-4 pb-[max(4.5rem,calc(env(safe-area-inset-bottom)+1rem))]"
                  >
                    {state.error ? (
                      <p className="mb-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
                        {state.error}
                      </p>
                    ) : null}

                    {activeStep && state.phase === "awaiting-input" ? (
                      <>
                        <div className="mb-3">
                          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[#0b7c87]">
                            Current question
                          </p>
                          <p className="mt-1 text-sm font-medium leading-6 text-slate-800">
                            {activeStep.prompt}
                          </p>
                        </div>
                        <form onSubmit={handleSubmit} className="space-y-3">
                          <input
                            key={activeStep.key}
                            autoFocus
                          type={activeStep.type}
                          value={activeValue}
                          onChange={(event) =>
                            dispatch({
                              type: "UPDATE_FIELD",
                              key: activeStep.key,
                              value:
                                activeStep.key === "phone"
                                  ? sanitizePhoneInput(event.target.value)
                                  : event.target.value,
                            })
                          }
                          placeholder={activeStep.placeholder}
                          inputMode={activeStep.key === "phone" ? "numeric" : undefined}
                          autoComplete={
                            activeStep.key === "phone"
                              ? "tel"
                              : activeStep.key === "name"
                                ? "name"
                                : activeStep.key === "city"
                                  ? "address-level2"
                                  : "off"
                          }
                          className="w-full rounded-full border border-slate-200 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                        />
                        <button
                          type="submit"
                          className={`w-full rounded-full px-4 py-3 text-sm font-semibold text-white transition ${vertical.theme.accentStrong}`}
                        >
                          {findNextEmptyStep(state.fields, state.currentStep + 1) >= TOTAL_STEPS
                            ? "Review"
                            : "Next"}
                        </button>
                      </form>
                      </>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
