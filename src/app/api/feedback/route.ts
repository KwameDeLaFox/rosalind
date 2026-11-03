import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import {
  PROFILES,
  getProfileById,
  MIN_PROFILES,
  MAX_PROFILES,
  type ProfileId,
} from "@/lib/profiles";
import { RUBRIC, type RubricFeedback } from "@/lib/rubric";
import { fetchPageText, FetchPageError } from "@/lib/page-fetch";

export const runtime = "nodejs";

// v0 cap: nothing fancy, just keep the prototype from being abused.
const MAX_INPUT_CHARS = 20_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB after base64 decode

type InputKind = "url" | "text" | "screenshot";

interface PageInput {
  kind: InputKind;
  url?: string;
  text?: string;
  image?: string; // base64 data URL
}

interface FeedbackRequest {
  page_input: PageInput;
  profile_ids: string[];
}

interface ProfileResult {
  profile_id: ProfileId;
  profile_name: string;
  feedback: RubricFeedback;
}

interface FeedbackResponse {
  page_summary: {
    source: InputKind;
    title?: string;
    truncated?: boolean;
    note?: string;
  };
  results: ProfileResult[];
  warnings: string[];
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: FeedbackRequest;
  try {
    body = (await req.json()) as FeedbackRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { page_input, profile_ids } = body ?? {};

  if (!page_input || !page_input.kind) {
    return NextResponse.json(
      { error: "Missing page_input." },
      { status: 400 },
    );
  }

  if (!Array.isArray(profile_ids) || profile_ids.length < MIN_PROFILES) {
    return NextResponse.json(
      { error: `Select at least ${MIN_PROFILES} profiles.` },
      { status: 400 },
    );
  }
  if (profile_ids.length > MAX_PROFILES) {
    return NextResponse.json(
      { error: `Select at most ${MAX_PROFILES} profiles.` },
      { status: 400 },
    );
  }

  const selectedProfiles = profile_ids
    .map((id) => getProfileById(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  if (selectedProfiles.length !== profile_ids.length) {
    return NextResponse.json(
      { error: "Unknown profile id in selection." },
      { status: 400 },
    );
  }

  // Build the page content the per-profile calls will see.
  let pageContent: string;
  const warnings: string[] = [];
  const pageSummary: FeedbackResponse["page_summary"] = {
    source: page_input.kind,
  };

  try {
    if (page_input.kind === "url") {
      if (!page_input.url || !page_input.url.trim()) {
        return NextResponse.json(
          { error: "URL is required." },
          { status: 400 },
        );
      }
      const fetched = await fetchPageText(page_input.url.trim());
      pageSummary.title = fetched.title;
      pageSummary.truncated = fetched.truncated;
      pageContent = formatFetchedPage(fetched);
    } else if (page_input.kind === "text") {
      const text = (page_input.text ?? "").trim();
      if (!text) {
        return NextResponse.json(
          { error: "Paste some page copy first." },
          { status: 400 },
        );
      }
      if (text.length > MAX_INPUT_CHARS) {
        return NextResponse.json(
          { error: `Pasted copy is too long (max ${MAX_INPUT_CHARS} chars).` },
          { status: 400 },
        );
      }
      pageContent = text;
    } else if (page_input.kind === "screenshot") {
      const dataUrl = page_input.image ?? "";
      if (!dataUrl.startsWith("data:image/")) {
        return NextResponse.json(
          { error: "Screenshot must be a base64 data URL." },
          { status: 400 },
        );
      }
      // Rough size check from the data-URL prefix.
      const base64 = dataUrl.split(",", 2)[1] ?? "";
      const approxBytes = Math.floor((base64.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: `Screenshot is too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).` },
          { status: 400 },
        );
      }
      try {
        pageContent = await describeScreenshot(dataUrl);
        pageSummary.note =
          "Page content extracted from screenshot by a vision model — fine details may be missed.";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          { error: `Could not read the screenshot: ${msg}` },
          { status: 500 },
        );
      }
    } else {
      return NextResponse.json(
        { error: `Unknown input kind: ${String(page_input.kind)}` },
        { status: 400 },
      );
    }
  } catch (err) {
    if (err instanceof FetchPageError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.kind === "blocked" ? 403 : 400 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to prepare page content: ${msg}` },
      { status: 500 },
    );
  }

  if (!pageContent.trim()) {
    return NextResponse.json(
      { error: "Page content came back empty." },
      { status: 422 },
    );
  }

  // One LLM call per profile, in parallel. Each is constrained to the rubric.
  let zai: Awaited<ReturnType<typeof ZAI.create>>;
  try {
    zai = await ZAI.create();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not initialise the LLM: ${msg}` },
      { status: 500 },
    );
  }

  // Stream results as each profile finishes, instead of waiting for all
  // to complete and returning one JSON blob. Profile calls run SEQUENTIALLY
  // with a small gap between each — not in parallel — for two reasons:
  //   1. The LLM provider rate-limits per client. Firing N parallel calls
  //      causes a burst of simultaneous requests, most of which 429. A
  //      sequential stream with a small gap never spikes concurrency.
  //   2. It fits the streaming UX. Each profile arrives genuinely after
  //      the previous one, giving the reader a beat to actually look at
  //      each objection — which was the whole point of streaming.
  // 429s that still occur (provider-side hiccups, other clients on the
  // sandbox) are retried with exponential backoff below.
  const encoder = new TextEncoder();
  const selectedProfileIds = selectedProfiles.map((p) => p.id);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // controller already closed — ignore
        }
      };

      send("start", {
        page_summary: pageSummary,
        expected_profile_ids: selectedProfileIds,
      });

      const warnings: string[] = [];

      for (let i = 0; i < selectedProfiles.length; i++) {
        const profile = selectedProfiles[i];
        // Small gap before each call (skip on the first) to avoid
        // the burst pattern that triggers 429s. 300ms is enough to
        // keep the provider from seeing concurrent requests without
        // making the overall run feel slow.
        if (i > 0) await sleep(300);
        try {
          const feedback = await getFeedbackForProfile(
            zai,
            profile,
            pageContent,
          );
          send("profile_done", {
            profile_id: profile.id,
            profile_name: profile.name,
            feedback,
          } satisfies ProfileResult);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          warnings.push(`"${profile.name}" failed: ${reason}`);
          send("profile_failed", {
            profile_id: profile.id,
            profile_name: profile.name,
            feedback: {
              clarity: "(this profile failed to return a response)",
              trust: "",
              friction: "",
              next_action: "",
              top_objection: "",
            },
          } satisfies ProfileResult);
        }
      }

      send("done", { warnings });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry a call when the LLM provider returns 429 (Too Many Requests).
// The sandbox LLM is shared and rate-limited per client; 429s happen
// even with sequential calls. Exponential backoff: 1s, 2s, 4s. Only
// retries on 429 — other errors (parse failures, network) surface
// immediately so the user knows they're real.
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes("429") || /too many requests/i.test(msg);
      if (!isRateLimit || attempt === maxRetries) {
        throw err;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function formatFetchedPage(p: {
  title: string;
  metaDescription: string;
  text: string;
  url: string;
  truncated: boolean;
}): string {
  const parts: string[] = [];
  if (p.title) parts.push(`# ${p.title}`);
  if (p.metaDescription) parts.push(`> ${p.metaDescription}`);
  parts.push(`(source: ${p.url})`);
  parts.push("");
  parts.push(p.text);
  if (p.truncated) {
    parts.push("");
    parts.push("[page text truncated — only the first portion is shown]");
  }
  return parts.join("\n");
}

async function describeScreenshot(dataUrl: string): Promise<string> {
  const zai = await ZAI.create();
  const prompt = [
    "You are extracting the visible content of a single web page from a screenshot.",
    "Return ONLY the following, as plain text (no commentary):",
    "- The headline (largest text).",
    "- The subhead or first supporting line.",
    "- The value proposition, if there is one stated.",
    "- Every button or call-to-action label, prefixed with [CTA].",
    "- Every form label, prefixed with [form label].",
    "- Any visible body copy, in reading order.",
    "- Any pricing, social proof, logos, or trust signals you can see, in one line each.",
    "If something is not visible, omit it. Do not invent. Do not interpret.",
  ].join(" ");

  const response = await zai.chat.completions.createVision({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    thinking: { type: "disabled" },
  });

  const text = response.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("Vision model returned no content.");
  return text;
}

async function getFeedbackForProfile(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  profile: (typeof PROFILES)[number],
  pageContent: string,
): Promise<RubricFeedback> {
  const systemPrompt = buildSystemPrompt(profile);
  const userPrompt = buildUserPrompt(pageContent);

  // Retry on 429 with exponential backoff. The sandbox LLM provider
  // rate-limits per client; even with sequential calls, occasional
  // 429s happen. Most clear within a couple of seconds.
  // Schedule: 1s, 2s, 4s — up to 3 retries on top of the initial try.
  const maxRetries = 3;
  const baseDelayMs = 1000;

  let response: Awaited<ReturnType<typeof zai.chat.completions.create>>;
  try {
    response = await retryWithBackoff(
      () =>
        zai.chat.completions.create({
          messages: [
            { role: "assistant", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          // Low temperature for consistency across re-runs of the same page.
          // PRD §9: "Temperature low-ish for consistency."
          temperature: 0.3,
          thinking: { type: "disabled" },
        }),
      maxRetries,
      baseDelayMs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM call failed: ${msg}`);
  }

  const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) throw new Error("LLM returned empty content.");

  const parsed = parseRubricJSON(raw);
  if (!parsed) {
    throw new Error("Could not parse structured output from LLM.");
  }
  return parsed;
}

function buildSystemPrompt(profile: (typeof PROFILES)[number]): string {
  const fieldGuide = RUBRIC.map(
    (f) => `- "${f.key}": ${f.asks} Length: ${f.length}.`,
  ).join("\n");

  return [
    `You are role-playing a single synthetic visitor to a web page.`,
    `You are NOT an analyst giving a report. You ARE this person, reacting.`,
    ``,
    `Profile you are playing:`,
    `Name: ${profile.name}`,
    `Mindset: ${profile.description}`,
    `What you care about: ${profile.caresAbout}`,
    `How you tend to talk (use this voice, not analyst-speak):`,
    ...profile.voiceExamples.map((v) => `  ${v}`),
    ``,
    `You will be shown the page content. React from inside this profile's head.`,
    `Stay in character. Do not speak to other profiles. Do not generalise to "users".`,
    `Be specific to this page — name actual elements (a CTA label, a missing price,`,
    `a vague subhead, an unlabelled form field). Avoid generic observations like`,
    `"could be clearer" or "might benefit from more detail". If you can't find a`,
    `concrete anchor for a field, say what you would have wanted to see instead.`,
    ``,
    `Respond with a single JSON object and NOTHING ELSE. No prose, no markdown,`,
    `no code fences, no explanation before or after. The object must have exactly`,
    `these five keys and nothing else:`,
    ``,
    `{`,
    `  "clarity": string,`,
    `  "trust": string,`,
    `  "friction": string,`,
    `  "next_action": string,`,
    `  "top_objection": string`,
    `}`,
    ``,
    `Field requirements:`,
    fieldGuide,
    ``,
    `The "top_objection" field is the most important. It must be a specific`,
    `question this profile would actually ask before acting — not a generic`,
    `question like "what does it cost?" unless the page genuinely forces that.`,
  ].join("\n");
}

function buildUserPrompt(pageContent: string): string {
  return [
    `Here is the page content:`,
    ``,
    `----- PAGE START -----`,
    pageContent,
    `----- PAGE END -----`,
    ``,
    `Now respond with the JSON object only.`,
  ].join("\n");
}

function parseRubricJSON(raw: string): RubricFeedback | null {
  // Try direct parse first.
  try {
    const obj = JSON.parse(raw);
    return normalise(obj);
  } catch {
    // fall through
  }

  // Fallback: extract the first {...} block from the raw text.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return normalise(obj);
  } catch {
    return null;
  }
}

function normalise(obj: unknown): RubricFeedback | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const out: RubricFeedback = {
    clarity: stringify(o.clarity),
    trust: stringify(o.trust),
    friction: stringify(o.friction),
    next_action: stringify(o.next_action),
    top_objection: stringify(o.top_objection),
  };
  // If everything came back empty, the parse didn't really work.
  if (Object.values(out).every((v) => v.length === 0)) return null;
  return out;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => stringify(x)).join(" ").trim();
  if (v && typeof v === "object") return JSON.stringify(v);
  return "";
}
