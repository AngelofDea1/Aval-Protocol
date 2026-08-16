// Stage 2 of the model: a bounded LLM adjustment over unstructured context.
//
// The structured model sees numbers. It cannot see that a protocol was exploited last week,
// that its main integrator is winding down, or that a governance vote just cut fees. An LLM
// can read that. What it must never do is move the number far enough to originate a loan
// the structured model would have refused.
//
// So its influence is hard-clamped to +/-MAX_ADJUSTMENT of the base PD, enforced here in
// code rather than requested in the prompt. A prompt is a suggestion; a clamp is a bound.
//
// Failure policy: if the LLM errors, times out, or returns malformed output, underwriting
// proceeds with zero adjustment and the failure is recorded in the rationale. A missing
// qualitative overlay must never block a decision, and must never be silent.

export const MAX_ADJUSTMENT = 0.30; // +/-30% of base PD

const SYSTEM_PROMPT = `You are a credit analyst reviewing an automated underwriting decision for a short-term advance against a crypto protocol's fee revenue.

A statistical model has produced a base probability of default. Your job is to assess whether qualitative context justifies a modest adjustment.

You must respond with ONLY a JSON object, no prose outside it:
{
  "adjustment": <number between -1 and 1>,
  "confidence": "low" | "medium" | "high",
  "rationale": "<2-4 sentences of specific reasoning>",
  "risk_factors": ["<short phrase>", ...],
  "mitigants": ["<short phrase>", ...]
}

"adjustment" is a RELATIVE change to the base probability of default:
  -1.0 = strongly argues the model overstates risk
   0.0 = no qualitative information either way
  +1.0 = strongly argues the model understates risk

Your adjustment will be scaled down and clamped before use. Do not attempt to force a large
change; report your honest assessment. If the context is thin or uninformative, return 0.0
and say so. Speculation presented as insight is worse than an honest zero.`;

function buildUserPrompt({ obligor, basePd, features, context }) {
  return `Obligor: ${obligor}

Statistical model output:
  base probability of default (30d): ${(basePd * 100).toFixed(2)}%

Key features the model used:
${Object.entries(features)
  .map(([k, v]) => `  ${k}: ${typeof v === "number" ? v.toFixed(4) : v}`)
  .join("\n")}

Qualitative context:
${context && context.trim() ? context : "(none supplied)"}

Assess whether this context justifies adjusting the base probability.`;
}

function parseResponse(text) {
  // Models sometimes wrap JSON in prose or fences despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object found in response");

  const parsed = JSON.parse(candidate.slice(start, end + 1));
  const adjustment = Number(parsed.adjustment);
  if (!Number.isFinite(adjustment)) throw new Error("`adjustment` missing or not a number");
  if (adjustment < -1.0001 || adjustment > 1.0001) throw new Error(`adjustment ${adjustment} outside [-1, 1]`);

  return {
    adjustment: Math.max(-1, Math.min(1, adjustment)),
    confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "low",
    rationale: String(parsed.rationale ?? "").slice(0, 2000),
    riskFactors: Array.isArray(parsed.risk_factors) ? parsed.risk_factors.map(String).slice(0, 10) : [],
    mitigants: Array.isArray(parsed.mitigants) ? parsed.mitigants.map(String).slice(0, 10) : [],
  };
}

/**
 * Apply the clamped adjustment.
 *
 * The clamp is multiplicative on the base PD and additionally bounded to [0.0005, 0.9995]
 * so no adjustment can drive the probability to a degenerate 0 or 1.
 */
export function applyAdjustment(basePd, rawAdjustment) {
  const clamped = Math.max(-1, Math.min(1, Number(rawAdjustment) || 0));
  const effective = clamped * MAX_ADJUSTMENT;
  const adjusted = basePd * (1 + effective);
  return {
    adjustedPd: Math.max(0.0005, Math.min(0.9995, adjusted)),
    effectiveMultiplier: effective,
    clampedFrom: clamped,
    hitClamp: Math.abs(clamped) >= 0.9999,
  };
}

/**
 * Query the LLM for a qualitative adjustment. Never throws.
 *
 * @returns {{ok: boolean, adjustment: number, ...}}
 */
export async function getQualitativeAdjustment({
  obligor,
  basePd,
  features,
  context = "",
  apiKey = process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY,
  model = process.env.GROQ_API_KEY ? (process.env.LLM_MODEL ?? "llama3-70b-8192") : (process.env.LLM_MODEL ?? "claude-sonnet-5"),
  timeoutMs = 30000,
} = {}) {
  const skip = (reason) => ({
    ok: false,
    skipped: true,
    reason,
    adjustment: 0,
    confidence: "none",
    rationale: `No qualitative overlay applied: ${reason}. Decision rests on the structural model alone.`,
    riskFactors: [],
    mitigants: [],
  });

  if (!apiKey) return skip("no API key configured");
  
  const isGroq = !!process.env.GROQ_API_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    
    if (isGroq) {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt({ obligor, basePd, features, context }) }
          ]
        }),
      });
    } else {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt({ obligor, basePd, features, context }) }],
        }),
      });
    }

    if (!res.ok) return skip(`API returned HTTP ${res.status}`);

    const body = await res.json();
    
    let text = "";
    if (isGroq) {
      text = body.choices?.[0]?.message?.content ?? "";
    } else {
      text = (body.content ?? []).map((c) => c.text ?? "").join("");
    }
    
    if (!text) return skip("empty response body");

    return { ok: true, skipped: false, model, ...parseResponse(text) };
  } catch (err) {
    return skip(err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err.message);
  } finally {
    clearTimeout(timer);
  }
}
