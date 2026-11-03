// Build-time helper: write ./.z-ai-config from environment variables.
// The z-ai-web-dev-sdk only reads its config from a JSON file on disk
// (./.z-ai-config, ~/.z-ai-config, /etc/.z-ai-config) — there's no
// env-var path in the SDK itself. On hosts like Render where you
// can't commit a config file, this script reads the credentials
// from env vars and writes the file into the build output so the
// SDK can find it at runtime.
//
// In the sandbox (where /etc/.z-ai-config already exists and we
// don't set the env vars), this script is a no-op.

import fs from "node:fs";
import path from "node:path";

const { Z_AI_BASE_URL, Z_AI_API_KEY, Z_AI_CHAT_ID, Z_AI_USER_ID } = process.env;

if (!Z_AI_BASE_URL && !Z_AI_API_KEY) {
  // No env vars set — assume the SDK's default file lookup will work
  // (e.g. in the sandbox where /etc/.z-ai-config exists).
  console.log("build:write-zai-config — no Z_AI_* env vars, skipping");
  process.exit(0);
}

if (!Z_AI_BASE_URL || !Z_AI_API_KEY) {
  console.error(
    "build:write-zai-config — both Z_AI_BASE_URL and Z_AI_API_KEY must be set if either is set.",
  );
  process.exit(1);
}

const config = {
  baseUrl: Z_AI_BASE_URL,
  apiKey: Z_AI_API_KEY,
  ...(Z_AI_CHAT_ID ? { chatId: Z_AI_CHAT_ID } : {}),
  ...(Z_AI_USER_ID ? { userId: Z_AI_USER_ID } : {}),
};

const outPath = path.join(process.cwd(), ".z-ai-config");
fs.writeFileSync(outPath, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`build:write-zai-config — wrote ${outPath}`);
