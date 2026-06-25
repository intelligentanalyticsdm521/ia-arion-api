// lib/brandIntakeClient.js — server-to-server upsert of the simplified
// onboarding Brand Intake into lumen.brand_voice_profile.
//
// Used by /onboarding/submit (arion-api Path A handler) when the
// QuestionnaireAnswers payload includes a `brandIntake` block captured by
// the BrandIntakeStep (Portal/src/components/BrandIntakeStep.tsx). The
// shape is intentionally loose at this boundary — same JSON the Portal
// types/brandIntake.ts emits — so an additive FE schema bump won't break
// this client.
//
// CONSTRAINT: failure here MUST NEVER block site provisioning. Brandon's
// rule (same as walkthroughClient.js) — best-effort; .catch-safe; aggressive
// timeout. Returns { ok: boolean, reason?: string }.
//
// LUMEN endpoint:
//   POST /api/v1/internal/my-brand/voice/profile/upsert
//   Header: x-internal-token: <LUMEN_INTERNAL_SERVICE_TOKEN | LUMEN_WALKTHROUGH_SEED_TOKEN>
//   Body:   { tenantId, tone_attributes, voice_examples }

const DEFAULT_TIMEOUT_MS = 4000;

function getLumenBase() {
  return (process.env.LUMEN_API_BASE_URL || process.env.SPARK_API_BASE_URL || "").replace(/\/+$/, "");
}

function getInternalToken() {
  return process.env.LUMEN_INTERNAL_SERVICE_TOKEN
    || process.env.LUMEN_WALKTHROUGH_SEED_TOKEN
    || process.env.WALKTHROUGH_SEED_INTERNAL_TOKEN
    || "";
}

/**
 * Sanitize a free-text-array → string[] capped per the LUMEN upsertProfile
 * limits. Filters out empties; trims. Used for differentiators + the
 * synthesized voice_examples payload.
 */
function cleanStrings(arr, maxLen = 2000, maxCount = 20) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().slice(0, maxLen))
    .slice(0, maxCount);
}

/**
 * Build the tone_attributes blob LUMEN expects. We always pass the full
 * structured intake — LUMEN's writeIntakeScalars mirror picks out the
 * sliders / lists / single-pick scalars into explicit columns; the JSON
 * blob in tone_attributes_json remains the canonical source.
 */
function buildToneAttributes({ intake, questionnaire }) {
  const out = {
    voice_traits: Array.isArray(intake?.voice_traits) ? intake.voice_traits : [],
    tones_to_avoid: Array.isArray(intake?.tones_to_avoid) ? intake.tones_to_avoid : [],
    sliders: (intake?.sliders && typeof intake.sliders === "object") ? intake.sliders : {},
    differentiators: cleanStrings(intake?.differentiators, 300, 5),
    visual_direction: typeof intake?.visual_direction === "string" ? intake.visual_direction : "",
    photography_preference: typeof intake?.photography_preference === "string" ? intake.photography_preference : "",
    admired_brands: typeof intake?.admired_brands === "string" ? intake.admired_brands : "",
    avoid_brand: typeof intake?.avoid_brand === "string" ? intake.avoid_brand : "",
    positioning_territories: Array.isArray(intake?.positioning_territories) ? intake.positioning_territories : [],
    source: "onboarding_wizard",
    captured_at: new Date().toISOString(),
  };
  // Mix in legacy questionnaire fields when present so the founder wizard
  // and Path A converge on the same canonical record shape.
  if (questionnaire) {
    if (questionnaire.brandVoice) out.legacy_brand_voice = questionnaire.brandVoice;
    if (questionnaire.stylePreference) out.style_preference = questionnaire.stylePreference;
    if (questionnaire.tagline) out.tagline = questionnaire.tagline;
  }
  return out;
}

/**
 * Build voice_examples — seeds for the embedding pass. We mix differentiators
 * + tagline + admired/avoid framing into a small string[] so even a minimal
 * intake produces meaningful embeddings. upsertProfile filters dupes / blanks.
 */
function buildVoiceExamples({ intake, questionnaire }) {
  const examples = [
    ...cleanStrings(intake?.differentiators, 500, 5),
  ];
  if (questionnaire?.tagline) examples.push(String(questionnaire.tagline).slice(0, 500));
  if (intake?.admired_brands) examples.push(`We want to sound brand-adjacent to: ${String(intake.admired_brands).slice(0, 300)}`);
  if (intake?.avoid_brand) examples.push(`We do NOT want to sound like: ${String(intake.avoid_brand).slice(0, 200)}`);
  return cleanStrings(examples, 2000, 20);
}

/**
 * Detect whether the captured intake is meaningfully non-empty. We don't
 * want to wipe an existing profile with empty defaults.
 */
function intakeHasContent(intake) {
  if (!intake || typeof intake !== "object") return false;
  const a = (k) => Array.isArray(intake[k]) && intake[k].length > 0;
  if (a("voice_traits") || a("tones_to_avoid") || a("positioning_territories")) return true;
  if (Array.isArray(intake.differentiators) && intake.differentiators.some((s) => typeof s === "string" && s.trim())) return true;
  if (typeof intake.visual_direction === "string" && intake.visual_direction) return true;
  if (typeof intake.photography_preference === "string" && intake.photography_preference) return true;
  if (typeof intake.admired_brands === "string" && intake.admired_brands.trim()) return true;
  if (typeof intake.avoid_brand === "string" && intake.avoid_brand.trim()) return true;
  const s = intake.sliders || {};
  if ([s.casual_formal, s.affordable_premium, s.traditional_modern, s.local_corporate]
        .some((n) => Number.isFinite(Number(n)) && Number(n) !== 5)) return true;
  return false;
}

/**
 * Fire-and-forget intake upsert. Resolves to { ok, reason? }.
 * NEVER throws (every error path is caught + reported).
 */
export async function upsertBrandIntake({ tenantId, intake, questionnaire, timeoutMs }) {
  if (!tenantId) return { ok: false, reason: "missing_tenant_id" };
  if (!intakeHasContent(intake)) return { ok: false, reason: "intake_empty" };

  const base = getLumenBase();
  if (!base) return { ok: false, reason: "lumen_base_not_configured" };
  const token = getInternalToken();
  if (!token) return { ok: false, reason: "no_internal_token" };

  const url = `${base}/api/v1/internal/my-brand/voice/profile/upsert`;
  const body = JSON.stringify({
    tenantId,
    tone_attributes: buildToneAttributes({ intake, questionnaire }),
    voice_examples: buildVoiceExamples({ intake, questionnaire }),
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": token,
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      console.warn(`[brandIntake] upsert returned ${res.status} for tenant=${tenantId}: ${detail}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[brandIntake] upsert failed for tenant=${tenantId}:`, err?.message || err);
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

export { intakeHasContent };
