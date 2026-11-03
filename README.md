# Synthetic Page Feedback — Playground v0

A single-page web app that takes a landing page (URL, pasted copy, or
screenshot), runs 3–5 hardcoded synthetic "visitor" profiles against
it, and streams structured feedback per profile across a fixed
rubric: **Clarity · Trust · Friction · Next · Top objection**.

The prototype exists to answer one question: *is the output
non-obvious enough that a real product marketer would learn
something, or is it generic mush?*

- **No persistence** — refresh loses everything.
- **No auth** — not behind a login.
- **No scores** — adding numbers invites users to treat the output
  as measurement, which is the exact failure mode this prototype
  is trying to avoid.
- **No real-user grounding** — the profiles are deliberately
  archetypal, not realistic. The point is variation, not realism.

## Stack

- [Next.js 16](https://nextjs.org/) (App Router, TypeScript)
- [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)
- [z-ai-web-dev-sdk](https://www.npmjs.com/package/z-ai-web-dev-sdk)
  for the LLM (chat completions + vision)

## Getting started (local dev)

```bash
# 1. Install dependencies
npm install

# 2. Configure the LLM
#    The SDK reads a JSON config from one of:
#      ./.z-ai-config            (project root — recommended)
#      ~/.z-ai-config
#      /etc/.z-ai-config
#    See .env.example for the shape. The simplest approach for local
#    dev: create ./.z-ai-config with your credentials.

# 3. Run the dev server
npm run dev
# Open http://localhost:3000
```

## Deploy to Render

The repo includes a `render.yaml` Blueprint, so you can create the
web service in one click.

### One-click via Blueprint

1. Push this repo to GitHub.
2. On Render, go to **New > Blueprint** and select the repo.
3. Render reads `render.yaml` and pre-fills the service config.
4. Fill in the four `Z_AI_*` env vars when prompted (Render marks
   them `sync: false` so you enter them in the dashboard):
   - `Z_AI_BASE_URL` — the Z.ai API base URL (must end in `/v1`)
   - `Z_AI_API_KEY` — your Z.ai API key
   - `Z_AI_CHAT_ID` — optional
   - `Z_AI_USER_ID` — optional
5. Click **Apply**. Render builds and deploys.

### Manual setup (if you'd rather configure by hand)

1. On Render, **New > Web Service**, connect your GitHub repo.
2. Settings:
   - **Runtime**: Node
   - **Build command**: `npm install && npm run build`
   - **Start command**: `npm start`
   - **Plan**: Free (or paid if you need more)
3. Under **Environment**, add the same `Z_AI_*` env vars above.
4. **Create Web Service**.

### How the SDK auth works on Render

The `z-ai-web-dev-sdk` reads credentials from a JSON file on disk
(`.z-ai-config`), not env vars. To bridge this on hosts where you
can't commit a config file, `npm run build` runs a `prebuild` step
(`scripts/write-zai-config.mjs`) that reads `Z_AI_*` env vars and
writes `.z-ai-config` into the build output, where the SDK finds
it at runtime. In local dev (no env vars set), the prebuild is a
no-op and the SDK falls back to `~/.z-ai-config` or `/etc/.z-ai-config`.

## How it works

1. **Input.** Paste a URL (fetched server-side and stripped to text),
   paste page copy directly (most reliable — no fetch step to fail),
   or upload a screenshot (read once by a vision model to extract
   text).
2. **Profiles.** Pick 3–5 of 5 hardcoded archetypal profiles
   (Skeptical researcher, Time-poor founder, Cautious buyer,
   Comparison shopper, First-time visitor). 3 are pre-selected.
3. **Streaming.** One LLM call per profile, run **sequentially** with
   a small gap between each (to avoid rate-limit bursts) and
   **retried on 429** with exponential backoff (1s, 2s, 4s).
   Results stream in via Server-Sent Events — each profile's
   objection card fades in as it arrives, in arrival order, with
   placeholders for the profiles still thinking.
4. **Rubric.** Every profile answers the same five fields, no
   free-form chat. The **Top objection** field is the one that
   earns or kills the prototype — it's rendered in a distinct
   side-by-side strip above the full per-profile cards.
5. **Gut check.** Each objection can be marked *New to me* or
   *Knew this*. The aggregate is the actual signal the PRD's
   success criteria ask for.
6. **Closing question.** *"Would this change what you'd test with
   real users?"* — free text, not saved, not submitted anywhere.

## File layout

```
src/
  app/
    api/feedback/route.ts   # SSE endpoint: one call per profile, sequential + retry
    page.tsx                # single-page UI (input, profiles, streaming results)
    layout.tsx              # metadata
    globals.css             # Tailwind + theme
  lib/
    profiles.ts            # 5 hardcoded profiles + voice anchors
    rubric.ts              # 5-field rubric + prompt fragments
    page-fetch.ts          # server-side URL fetcher (strip HTML → text)
  components/ui/           # shadcn/ui components
```

## Rate limiting

The LLM provider rate-limits per client. Profile calls are
sequential with a 300ms gap, and each call retries on 429 with
exponential backoff. A 5-profile run takes ~10s end-to-end. That
trade-off is deliberate — see `src/app/api/feedback/route.ts` for
the rationale.

## Disclaimer

> These are synthetic, directional reactions generated by an LLM.
> They are not real user evidence. Use them to generate hypotheses
> to test with real people, not to make decisions.

## Status

v0. The success criteria are in the PRD (not included here). The
prototype succeeds if, across 5 real pages you already understand,
at least one profile surfaces a top objection you hadn't considered
on at least 2 of the 5 pages, the five profiles produce materially
different objections, and the friction field identifies something
concrete on the page rather than a generic observation.

If it fails those, that's a useful result — it tells you the problem
is in the prompting, the rubric, or the underlying premise — and it
costs three days instead of three months.
