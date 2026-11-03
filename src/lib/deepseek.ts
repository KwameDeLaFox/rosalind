// Thin DeepSeek client. DeepSeek's API is OpenAI-compatible — same
// /chat/completions endpoint, same Bearer auth, same message shape,
// same image_url content block for vision. We use plain fetch so
// there's no extra dependency.
//
// Configure via the DEEPSEEK_API_KEY env var. The base URL defaults
// to https://api.deepseek.com and can be overridden with
// DEEPSEEK_BASE_URL (rare — only if you're proxying).

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash"; // current alias for V4.1-Flash, supports text + vision

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  model?: string;
}

export interface ChatCompletionResponse {
  choices: {
    message: {
      role: string;
      content: string | null;
    };
  }[];
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly isRateLimit: boolean,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

export function getDeepSeekConfig(): { baseUrl: string; apiKey: string; model: string } {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new DeepSeekError(
      "DEEPSEEK_API_KEY environment variable is not set. The app cannot call the LLM without it.",
      500,
      false,
    );
  }
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  return { baseUrl, apiKey, model };
}

export async function chatCompletion(
  options: ChatCompletionOptions,
): Promise<ChatCompletionResponse> {
  const { baseUrl, apiKey, model } = getDeepSeekConfig();
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model: options.model || model,
    messages: options.messages,
    temperature: options.temperature ?? 0.3,
    stream: false,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeepSeekError(`Network error calling DeepSeek: ${msg}`, 500, false);
  }

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    const isRateLimit = response.status === 429;
    const msg = isRateLimit
      ? "DeepSeek rate limit hit (429)"
      : `DeepSeek API error (HTTP ${response.status}): ${errorBody.slice(0, 200)}`;
    throw new DeepSeekError(msg, response.status, isRateLimit);
  }

  let data: ChatCompletionResponse;
  try {
    data = (await response.json()) as ChatCompletionResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeepSeekError(`Could not parse DeepSeek response: ${msg}`, 502, false);
  }

  return data;
}
