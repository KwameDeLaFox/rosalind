// Server-side URL fetcher. Fetches a page and strips it to text.
// We don't try to render or screenshot. We extract headline, subhead,
// body, CTA labels (button + prominent link text), and form labels.

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 12_000; // keep prompt sizes sane

const BLOCK_TAGS = [
  "p",
  "div",
  "section",
  "article",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "footer",
  "nav",
  "main",
  "br",
  "tr",
];

const STRIP_TAGS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "template",
  "head",
  "meta",
  "link",
];

export interface FetchedPage {
  url: string;
  title: string;
  metaDescription: string;
  text: string;
  truncated: boolean;
}

export class FetchPageError extends Error {
  constructor(
    message: string,
    public readonly kind: "network" | "blocked" | "non-html" | "empty" = "network",
  ) {
    super(message);
    this.name = "FetchPageError";
  }
}

export async function fetchPageText(rawUrl: string): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchPageError("That doesn't look like a valid URL.", "network");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchPageError("Only http and https URLs are supported.", "network");
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SyntheticPageFeedbackBot/0.1; +https://example.com/bot)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted")) {
      throw new FetchPageError("Timed out fetching that page.", "network");
    }
    throw new FetchPageError(`Could not fetch the page: ${msg}`, "network");
  }

  if (!response.ok) {
    throw new FetchPageError(
      `The page returned HTTP ${response.status}.`,
      response.status === 401 || response.status === 403 ? "blocked" : "network",
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new FetchPageError(
      `That URL doesn't return HTML (got ${contentType || "unknown content type"}).`,
      "non-html",
    );
  }

  const html = await response.text();
  if (!html || html.trim().length === 0) {
    throw new FetchPageError("The page came back empty.", "empty");
  }

  const extracted = extractText(html);
  if (!extracted.text.trim()) {
    throw new FetchPageError("Could not extract readable text from that page.", "empty");
  }

  const truncated = extracted.text.length > MAX_TEXT_LENGTH;
  return {
    url: url.toString(),
    title: extracted.title,
    metaDescription: extracted.metaDescription,
    text: truncated ? extracted.text.slice(0, MAX_TEXT_LENGTH) : extracted.text,
    truncated,
  };
}

function extractText(html: string): {
  title: string;
  metaDescription: string;
  text: string;
} {
  // Pull title and meta description first.
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

  const metaDescMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i,
  );
  const metaDescription = metaDescMatch ? stripTags(metaDescMatch[1]).trim() : "";

  // Drop the head entirely (we already have title + meta description).
  const noHead = html.replace(/<head[\s\S]*?<\/head>/gi, "");

  // Remove script/style/etc blocks entirely.
  let cleaned = noHead;
  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi");
    cleaned = cleaned.replace(re, " ");
    const selfClosing = new RegExp(`<${tag}\\b[^>]*?/?>`, "gi");
    cleaned = cleaned.replace(selfClosing, " ");
  }

  // Convert block-level closing tags to newlines so structure survives.
  for (const tag of BLOCK_TAGS) {
    const open = new RegExp(`<${tag}\\b[^>]*?>`, "gi");
    const close = new RegExp(`</${tag}>`, "gi");
    cleaned = cleaned.replace(open, "\n");
    cleaned = cleaned.replace(close, "\n");
  }

  // Annotate CTAs (button text + form labels) so the LLM can see them clearly.
  cleaned = cleaned.replace(/<button\b[^>]*>([\s\S]*?)<\/button>/gi, (_, t) =>
    `\n[CTA button] ${stripTags(t).trim()}\n`,
  );
  cleaned = cleaned.replace(/<label\b[^>]*>([\s\S]*?)<\/label>/gi, (_, t) =>
    `\n[form label] ${stripTags(t).trim()}\n`,
  );

  // Drop everything else tag-like.
  const textOnly = stripTags(cleaned);

  // Collapse whitespace, drop blank lines, trim long runs.
  const lines = textOnly
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  // Dedupe adjacent duplicate lines (common on templated pages).
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }

  return {
    title,
    metaDescription,
    text: deduped.join("\n"),
  };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}
