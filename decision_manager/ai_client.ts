/**
 * Thin wrapper around AI APIs.
 * All provider config (key, base URL, model) is read from the root .env file.
 * Precedence: env var > .env file > hardcoded default.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

// Backward-compatible exports used by other modules
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_MAX_TOKENS = 4096;

// ── .env reader ────────────────────────────────────────────────────

function readDotEnvValue(key: string): string | undefined {
  try {
    const envFile = join(__dirname || process.cwd(), ".env");
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() === key) {
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        return val || undefined;
      }
    }
  } catch {}
  return undefined;
}

/** Read config: env var > .env file */
function env(key: string): string | undefined {
  return process.env[key] || readDotEnvValue(key);
}

// ── Provider config ─────────────────────────────────────────────────

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const PROVIDERS = {
  dashscope: (): ProviderConfig => ({
    baseUrl:  env("DASHSCOPE_BASE_URL")  ?? "https://physmind-proxy.marvin-gao-cs.workers.dev/v1",
    apiKey:   env("DASHSCOPE_API_KEY")   ?? "",
    model:    env("DASHSCOPE_MODEL")     ?? "qwen-plus",
  }),
  anthropic: (): ProviderConfig => ({
    baseUrl:  env("ANTHROPIC_BASE_URL")  ?? "https://api.anthropic.com",
    apiKey:   env("ANTHROPIC_API_KEY")   ?? "",
    model:    env("ANTHROPIC_MODEL")     ?? "claude-sonnet-4-6",
  }),
  openai: (): ProviderConfig => ({
    baseUrl:  env("OPENAI_BASE_URL")     ?? "https://api.openai.com/v1",
    apiKey:   env("OPENAI_API_KEY")      ?? "",
    model:    env("OPENAI_MODEL")        ?? "gpt-4o",
  }),
  xai: (): ProviderConfig => ({
    baseUrl:  env("XAI_BASE_URL")        ?? "https://api.x.ai/v1",
    apiKey:   env("XAI_API_KEY")         ?? "",
    model:    env("XAI_MODEL")           ?? "grok-3",
  }),
} as const;

type ProviderName = keyof typeof PROVIDERS;

/** Detect the first available provider by priority. */
function detectProvider(): { name: ProviderName; config: ProviderConfig } {
  const active = env("ACTIVE_PROVIDER") as ProviderName | undefined;
  if (active && active in PROVIDERS) {
    const config = PROVIDERS[active]();
    if (config.apiKey) return { name: active, config };
  }
  // Auto-detect in order: dashscope > anthropic > openai > xai
  for (const name of ["dashscope", "anthropic", "openai", "xai"] as ProviderName[]) {
    const config = PROVIDERS[name]();
    if (config.apiKey) return { name, config };
  }
  throw new Error(
    "No API Key configured. Set at least one provider API_KEY in the .env file."
  );
}

// ── OpenAI-compatible API (shared by DashScope / OpenAI / xAI) ──────

interface DSMessage { role: "system" | "user" | "assistant"; content: string; }

async function openaiCall(baseUrl: string, apiKey: string, model: string, messages: DSMessage[], maxTokens: number, temperature?: number): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}) }),
  });
  if (!res.ok) throw new Error(`api returned ${res.status} ${res.statusText}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content;
}

async function openaiStream(baseUrl: string, apiKey: string, model: string, messages: DSMessage[], maxTokens: number, temperature: number | undefined, onChunk: (t: string) => void, onDone?: (t: string) => void): Promise<void> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true, ...(temperature !== undefined ? { temperature } : {}) }),
  });
  if (!res.ok) throw new Error(`api returned ${res.status} ${res.statusText}: ${await res.text()}`);

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let full = "", buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") break;
      try {
        const chunk = JSON.parse(payload) as { choices: { delta: { content?: string } }[] };
        const text = chunk.choices[0]?.delta?.content ?? "";
        if (text) { full += text; onChunk(text); }
      } catch {}
    }
  }
  onDone?.(full);
}

// ── Anthropic SDK calls ──────────────────────────────────────────────

function anthropicCall(config: ProviderConfig, system: string | undefined, messages: ChatMessage[], maxTokens: number, temperature?: number): Promise<Anthropic.Message> {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
  return client.messages.create({
    model: config.model, max_tokens: maxTokens, temperature,
    system, messages,
  });
}

function anthropicStream(config: ProviderConfig, system: string | undefined, messages: ChatMessage[], maxTokens: number, temperature: number | undefined, onChunk: (t: string) => void, onDone?: (t: string) => void): Promise<void> {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
  return (async () => {
    let fullText = "";
    const stream = await client.messages.stream({
      model: config.model, max_tokens: maxTokens, temperature,
      system, messages,
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullText += event.delta.text;
        onChunk(event.delta.text);
      }
    }
    onDone?.(fullText);
  })();
}

// ── Public API ──────────────────────────────────────────────────────

export interface ChatMessage { role: "user" | "assistant"; content: string; }

export interface AiCallOptions {
  system?: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function aiCall(opts: AiCallOptions): Promise<string> {
  const { name, config } = detectProvider();
  const model = opts.model ?? config.model;
  const maxTokens = opts.maxTokens ?? 4096;

  if (name === "anthropic") {
    const response = await anthropicCall(config, opts.system, opts.messages, maxTokens, opts.temperature);
    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type: " + block.type);
    return block.text;
  }

  // dashscope / openai / xai share the OpenAI-compatible interface
  const msgs: DSMessage[] = [];
  if (opts.system) msgs.push({ role: "system", content: opts.system });
  for (const m of opts.messages) msgs.push({ role: m.role, content: m.content });
  return openaiCall(config.baseUrl, config.apiKey, model, msgs, maxTokens, opts.temperature);
}

export interface StreamCallOptions extends AiCallOptions {
  onChunk: (text: string) => void;
  onDone?: (fullText: string) => void;
}

export async function aiStream(opts: StreamCallOptions): Promise<void> {
  const { name, config } = detectProvider();
  const model = opts.model ?? config.model;
  const maxTokens = opts.maxTokens ?? 4096;

  if (name === "anthropic") {
    return anthropicStream(config, opts.system, opts.messages, maxTokens, opts.temperature, opts.onChunk, opts.onDone);
  }

  const msgs: DSMessage[] = [];
  if (opts.system) msgs.push({ role: "system", content: opts.system });
  for (const m of opts.messages) msgs.push({ role: m.role, content: m.content });
  return openaiStream(config.baseUrl, config.apiKey, model, msgs, maxTokens, opts.temperature, opts.onChunk, opts.onDone);
}

// Exports for external use
export { detectProvider, env as readEnvConfig };
