// main.ts — a free-model aggregator: one server, two public wires, ten
// simulated free-tier providers behind them.
//
// How a trial looks from in here:
//   1. The trial brief sits in the file MAKEFUN_PROMPT_FILE names. It holds
//      three JSON documents: the provider directory, the quality table and
//      the workload manifest. Everything this program decides is derived
//      from those documents plus what the providers answer along the way.
//   2. Each provider is asked for its own model list, and the answers are
//      folded into one catalog document. That document is what --list
//      prints and what registration hands to the environment, unchanged.
//   3. The server binds an ephemeral port on 0.0.0.0 and registers
//      {protocol_version, port, catalog} with the environment. The client
//      then walks the manifest, one request at a time, and this server
//      answers each with a single successful call to the strongest free
//      model that may serve it, stepping sideways to the next candidate
//      whenever a provider refuses.
//   4. A background loop polls the environment's /work route; when it
//      reports the workload done, the process exits 0.
//
// Providers are always called without streaming: their recorded answer is
// the same either way, and the client's stream, when it asks for one, is
// assembled here from the whole answer. No decision reads the wall clock.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Small shapes and helpers

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The origin of the environment, trailing slashes stripped ('' when unset). */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  return raw === undefined ? "" : raw.replace(/\/+$/, "");
}

/** One fetch against the environment with a hard deadline. */
async function envCall(path: string, init: RequestInit, deadlineMs: number): Promise<Response> {
  return fetch(`${envOrigin()}${path}`, { ...init, signal: AbortSignal.timeout(deadlineMs) });
}

// ---------------------------------------------------------------------------
// The trial brief: three JSON documents embedded in one text file.

interface ProviderDir {
  id: string;
  name: string;
  wire: string; // openai | anthropic | gemini
  auth: string; // bearer | x-api-key | x-goog-api-key | none
  keyEnv: string;
  key: string;
  path: string; // e.g. /p/groq
}

interface ModelRow {
  provider: string;
  model: string;
  rating: number;
  context: number;
  tools: boolean;
  vision: boolean;
  json: boolean;
}

interface ManifestEntry {
  id: string;
  api: string; // openai | anthropic
  stream: boolean;
  weight: number;
  requires: { tools?: boolean; vision?: boolean; json?: boolean; min_context?: number };
}

interface Brief {
  providers: ProviderDir[];
  rows: ModelRow[];
  manifest: ManifestEntry[];
}

/** Pull one balanced JSON document out of the brief text by its schema tag. */
function extractDocument(text: string, schema: string): Json {
  const marker = `{"schema":"${schema}"`;
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`the brief holds no document with schema ${schema}`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const value: unknown = JSON.parse(text.slice(at, i + 1));
        if (!isRecord(value)) throw new Error(`the ${schema} document is not an object`);
        return value;
      }
    }
  }
  throw new Error(`the ${schema} document never closes`);
}

function readBrief(): Brief {
  const file = process.env.MAKEFUN_PROMPT_FILE;
  if (file === undefined || file === "") throw new Error("MAKEFUN_PROMPT_FILE is not set");
  const text = readFileSync(file, "utf8");
  const dirDoc = extractDocument(text, "free-model-aggregator-01/providers/v1");
  const ratingsDoc = extractDocument(text, "free-model-aggregator-01/ratings/v1");
  const workloadDoc = extractDocument(text, "free-model-aggregator-01/workload/v1");

  const providers: ProviderDir[] = [];
  for (const raw of dirDoc.providers as unknown[]) {
    if (!isRecord(raw)) continue;
    providers.push({
      id: String(raw.id),
      name: String(raw.name),
      wire: String(raw.wire),
      auth: String(raw.auth),
      keyEnv: String(raw.key_env),
      key: String(raw.key),
      path: String(raw.path),
    });
  }
  const rows: ModelRow[] = [];
  for (const raw of ratingsDoc.ratings as unknown[]) {
    if (!isRecord(raw) || raw.free !== true) continue;
    rows.push({
      provider: String(raw.provider),
      model: String(raw.model),
      rating: Number(raw.rating_milli),
      context: Number(raw.context_length),
      tools: raw.tools === true,
      vision: raw.vision === true,
      json: raw.json === true,
    });
  }
  const manifest: ManifestEntry[] = [];
  for (const raw of workloadDoc.manifest as unknown[]) {
    if (!isRecord(raw)) continue;
    const requires = isRecord(raw.requires) ? (raw.requires as ManifestEntry["requires"]) : {};
    manifest.push({
      id: String(raw.id),
      api: String(raw.api),
      stream: raw.stream === true,
      weight: Number(raw.weight) || 1,
      requires,
    });
  }
  return { providers, rows, manifest };
}

// ---------------------------------------------------------------------------
// The catalog: probed from the providers themselves, one canonical document.

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: string;
  models: CatalogModel[];
}

interface Catalog {
  providers: CatalogProvider[];
}

/** Headers a provider expects for its own routes, from its auth scheme. */
function providerHeaders(p: ProviderDir): Record<string, string> {
  const headers: Record<string, string> = {};
  if (p.auth === "bearer") headers.authorization = `Bearer ${p.key}`;
  else if (p.auth === "x-api-key") headers["x-api-key"] = p.key;
  else if (p.auth === "x-goog-api-key") headers["x-goog-api-key"] = p.key;
  if (p.wire === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return headers;
}

function providerBase(p: ProviderDir): string {
  return `${envOrigin()}${p.path}`;
}

/** Ask one provider for its model list and fold the answer into catalog rows. */
async function probeCatalog(p: ProviderDir): Promise<CatalogModel[] | null> {
  const route = p.wire === "gemini" ? "/v1beta/models" : "/v1/models";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await envCall(`${p.path}${route}`, { headers: providerHeaders(p) }, 5_000);
      if (res.status < 200 || res.status >= 300) continue;
      const body: unknown = await res.json();
      if (!isRecord(body)) continue;
      const models: CatalogModel[] = [];
      if (p.wire === "gemini") {
        for (const raw of body.models as unknown[]) {
          if (!isRecord(raw) || typeof raw.name !== "string") continue;
          models.push({
            id: raw.name.replace(/^models\//, ""),
            free: raw.free === true,
            context_length: typeof raw.context_length === "number" ? raw.context_length : null,
          });
        }
      } else {
        for (const raw of body.data as unknown[]) {
          if (!isRecord(raw) || typeof raw.id !== "string") continue;
          models.push({
            id: raw.id,
            free: raw.free === true,
            context_length: typeof raw.context_length === "number" ? raw.context_length : null,
          });
        }
      }
      if (models.length > 0) return models;
    } catch {
      // A provider that will not answer its catalog route is retried once,
      // then the caller falls back to the quality table's rows for it.
    }
  }
  return null;
}

async function buildCatalog(brief: Brief): Promise<Catalog> {
  // One full probe round; when every provider stayed silent the environment
  // itself is probably still starting, so wait a breath and probe once more
  // before settling for the quality table's rows.
  for (let round = 0; round < 2; round++) {
    const providers: CatalogProvider[] = [];
    let answered = 0;
    for (const p of brief.providers) {
      const models = await probeCatalog(p);
      if (models !== null) answered++;
      providers.push({ id: p.id, base_url: p.path, key_env: p.keyEnv, wire: p.wire, models: models ?? [] });
    }
    if (answered > 0 || round === 1) {
      for (const entry of providers) {
        if (entry.models.length === 0) {
          entry.models = brief.rows
            .filter((r) => r.provider === entry.id)
            .map((r) => ({ id: r.model, free: true, context_length: r.context }));
        }
      }
      return { providers };
    }
    await sleep(500);
  }
  throw new Error("unreachable");
}

/** The free model ids of the catalog, each once, in catalog order. */
function freeModelIds(catalog: Catalog): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const p of catalog.providers) {
    for (const m of p.models) {
      if (m.free && !seen.has(m.id)) {
        seen.add(m.id);
        ids.push(m.id);
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Canonical requests: a client body, reduced to what every wire must carry
// identically — system text, the message thread, tool names and definitions,
// the token cap, the stop list, the JSON-mode flag and the temperature.

interface ImagePart {
  media: string | null;
  data: string | null; // base64 payload when the image travels inline
  url: string | null; // the image's address when it travels by reference
}

interface Block {
  text?: string;
  image?: ImagePart;
}

interface ThreadMessage {
  role: string;
  blocks: Block[];
}

interface Canon {
  system: string;
  messages: ThreadMessage[];
  tools: { name: string; description: string | null; schema: unknown }[];
  maxTokens: number | null;
  stops: string[];
  wantsJson: boolean;
  temperature: number | null;
}

/** Text of a wire content value: a plain string, or its text blocks joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function openAIBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content === "" ? [] : [{ text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ text: block.text });
    } else if (block.type === "image_url" && isRecord(block.image_url) && typeof block.image_url.url === "string") {
      const url = block.image_url.url;
      const data = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
      if (data !== null && data[2] !== undefined) blocks.push({ image: { media: data[1] || null, data: data[3], url: null } });
      else blocks.push({ image: { media: null, data: null, url } });
    }
  }
  return blocks;
}

function anthropicBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content === "" ? [] : [{ text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ text: block.text });
    } else if (block.type === "image" && isRecord(block.source)) {
      const source = block.source;
      if (source.type === "base64" && typeof source.data === "string") {
        blocks.push({ image: { media: typeof source.media_type === "string" ? source.media_type : null, data: source.data, url: null } });
      } else if (source.type === "url" && typeof source.url === "string") {
        blocks.push({ image: { media: null, data: null, url: source.url } });
      }
    }
  }
  return blocks;
}

function stopList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function canonFromOpenAI(body: Json): Canon {
  const messages: ThreadMessage[] = [];
  const systemParts: string[] = [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of rawMessages) {
    if (!isRecord(raw) || typeof raw.role !== "string") continue;
    if (raw.role === "system") {
      const text = contentText(raw.content);
      if (text !== "") systemParts.push(text);
    } else {
      messages.push({ role: raw.role, blocks: openAIBlocks(raw.content) });
    }
  }
  const tools: Canon["tools"] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== "string") continue;
      tools.push({
        name: raw.function.name,
        description: typeof raw.function.description === "string" ? raw.function.description : null,
        schema: raw.function.parameters ?? null,
      });
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    system: systemParts.join("\n"),
    messages,
    tools,
    maxTokens: numberOrNull(body.max_tokens) ?? numberOrNull(body.max_completion_tokens),
    stops: stopList(body.stop),
    wantsJson: format === "json_object" || format === "json_schema",
    temperature: numberOrNull(body.temperature),
  };
}

function canonFromAnthropic(body: Json): Canon {
  const messages: ThreadMessage[] = [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of rawMessages) {
    if (!isRecord(raw) || typeof raw.role !== "string") continue;
    messages.push({ role: raw.role, blocks: anthropicBlocks(raw.content) });
  }
  const tools: Canon["tools"] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || typeof raw.name !== "string") continue;
      tools.push({
        name: raw.name,
        description: typeof raw.description === "string" ? raw.description : null,
        schema: raw.input_schema ?? null,
      });
    }
  }
  return {
    system: contentText(body.system),
    messages,
    tools,
    maxTokens: numberOrNull(body.max_tokens),
    stops: stopList(body.stop_sequences),
    wantsJson: false, // the Anthropic wire carries no JSON-mode field of its own
    temperature: numberOrNull(body.temperature),
  };
}

// ---------------------------------------------------------------------------
// Canonical requests rendered onto each provider's wire.

function toOpenAIBody(model: string, canon: Canon, jsonMode: boolean): Json {
  const messages: unknown[] = [];
  if (canon.system !== "") messages.push({ role: "system", content: canon.system });
  for (const m of canon.messages) {
    if (m.role === "assistant") {
      messages.push({ role: "assistant", content: m.blocks.map((b) => b.text ?? "").join("\n") });
      continue;
    }
    const content: unknown[] = [];
    for (const b of m.blocks) {
      if (b.text !== undefined) content.push({ type: "text", text: b.text });
      else if (b.image !== undefined) {
        const url = b.image.data !== null ? `data:${b.image.media ?? "image/png"};base64,${b.image.data}` : (b.image.url ?? "");
        content.push({ type: "image_url", image_url: { url } });
      }
    }
    messages.push({ role: m.role, content });
  }
  const body: Json = { model, messages };
  if (canon.tools.length > 0) {
    body.tools = canon.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== null ? { description: t.description } : {}),
        parameters: t.schema ?? { type: "object" },
      },
    }));
    body.tool_choice = "auto";
  }
  if (canon.maxTokens !== null) body.max_tokens = canon.maxTokens;
  if (canon.stops.length > 0) body.stop = canon.stops;
  if (canon.temperature !== null) body.temperature = canon.temperature;
  if (jsonMode) body.response_format = { type: "json_object" };
  return body;
}

function toAnthropicBody(model: string, canon: Canon): Json {
  const messages: unknown[] = [];
  for (const m of canon.messages) {
    const content: unknown[] = [];
    for (const b of m.blocks) {
      if (b.text !== undefined) content.push({ type: "text", text: b.text });
      else if (b.image !== undefined) {
        if (b.image.data !== null) {
          content.push({ type: "image", source: { type: "base64", media_type: b.image.media ?? "image/png", data: b.image.data } });
        } else {
          content.push({ type: "image", source: { type: "url", url: b.image.url ?? "" } });
        }
      }
    }
    messages.push({ role: m.role, content });
  }
  const body: Json = { model, messages };
  if (canon.system !== "") body.system = canon.system;
  if (canon.tools.length > 0) {
    body.tools = canon.tools.map((t) => ({
      name: t.name,
      ...(t.description !== null ? { description: t.description } : {}),
      input_schema: t.schema ?? { type: "object" },
    }));
  }
  if (canon.maxTokens !== null) body.max_tokens = canon.maxTokens;
  if (canon.stops.length > 0) body.stop_sequences = canon.stops;
  if (canon.temperature !== null) body.temperature = canon.temperature;
  return body;
}

function toGeminiBody(canon: Canon, jsonMode: boolean): Json {
  const contents: unknown[] = [];
  for (const m of canon.messages) {
    const parts: unknown[] = [];
    for (const b of m.blocks) {
      if (b.text !== undefined) parts.push({ text: b.text });
      else if (b.image !== undefined) {
        if (b.image.data !== null) parts.push({ inlineData: { mimeType: b.image.media ?? "image/png", data: b.image.data } });
        else parts.push({ fileData: { fileUri: b.image.url ?? "" } });
      }
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  const body: Json = { contents };
  if (canon.system !== "") body.systemInstruction = { parts: [{ text: canon.system }] };
  if (canon.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: canon.tools.map((t) => ({
          name: t.name,
          ...(t.description !== null ? { description: t.description } : {}),
          parameters: t.schema ?? { type: "object" },
        })),
      },
    ];
  }
  const config: Json = {};
  if (canon.maxTokens !== null) config.maxOutputTokens = canon.maxTokens;
  if (canon.stops.length > 0) config.stopSequences = canon.stops;
  if (canon.temperature !== null) config.temperature = canon.temperature;
  if (jsonMode) config.responseMimeType = "application/json";
  if (Object.keys(config).length > 0) body.generationConfig = config;
  return body;
}

// ---------------------------------------------------------------------------
// Calling a provider and reading its answer.

interface ProviderAnswer {
  text: string;
  input: number;
  output: number;
}

type CallOutcome =
  | { ok: true; answer: ProviderAnswer }
  | { ok: false; status: number; message: string };

function providerErrorMessage(wire: string, body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return "";
}

async function callProvider(p: ProviderDir, model: string, canon: Canon, jsonMode: boolean): Promise<CallOutcome> {
  let url: string;
  let body: Json;
  if (p.wire === "openai") {
    url = `${providerBase(p)}/v1/chat/completions`;
    body = toOpenAIBody(model, canon, jsonMode);
  } else if (p.wire === "anthropic") {
    url = `${providerBase(p)}/v1/messages`;
    body = toAnthropicBody(model, canon);
  } else {
    url = `${providerBase(p)}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    body = toGeminiBody(canon, jsonMode);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { ...providerHeaders(p), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, status: 0, message: `the call did not complete: ${String(err)}` };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, message: providerErrorMessage(p.wire, parsed) };
  }
  if (!isRecord(parsed)) return { ok: false, status: res.status, message: "the answer was not one JSON object" };
  try {
    if (p.wire === "openai") {
      const choices = parsed.choices as unknown[];
      const first = isRecord(choices?.[0]) ? choices[0] : null;
      const message = first !== null && isRecord(first.message) ? first.message : null;
      const usage = isRecord(parsed.usage) ? parsed.usage : {};
      const text = message === null ? "" : contentText(message.content) || (typeof message.content === "string" ? message.content : "");
      return { ok: true, answer: { text, input: Number(usage.prompt_tokens) || 0, output: Number(usage.completion_tokens) || 0 } };
    }
    if (p.wire === "anthropic") {
      const usage = isRecord(parsed.usage) ? parsed.usage : {};
      return {
        ok: true,
        answer: { text: contentText(parsed.content), input: Number(usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0 },
      };
    }
    const candidates = parsed.candidates as unknown[];
    const first = isRecord(candidates?.[0]) ? candidates[0] : null;
    const content = first !== null && isRecord(first.content) ? first.content : null;
    const parts = content !== null && Array.isArray(content.parts) ? content.parts : [];
    let text = "";
    for (const part of parts) if (isRecord(part) && typeof part.text === "string") text += part.text;
    const usage = isRecord(parsed.usageMetadata) ? parsed.usageMetadata : {};
    return { ok: true, answer: { text, input: Number(usage.promptTokenCount) || 0, output: Number(usage.candidatesTokenCount) || 0 } };
  } catch (err) {
    return { ok: false, status: res.status, message: `the answer did not parse: ${String(err)}` };
  }
}

/** A refusal ends the provider for the trial when its budget or outage says so. */
function refusalIsFinal(message: string): boolean {
  return message.includes("budget is spent") || /(^|\s)is out\.?$/.test(message.trim());
}

// ---------------------------------------------------------------------------
// Routing: which model answers a request, and what happens on a refusal.

// The assured floor of each provider's per-trial budget, from the kit's
// published provider table; plans are drawn against the floor and anything
// beyond it is discovered by calling.
const ASSURED_CALLS: Record<string, number> = {
  groq: 9,
  cerebras: 5,
  gemini: 6,
  zai: 4,
  openrouter: 10,
  sambanova: 4,
  pollinations: 10,
  cloudflare: 7,
  ovh: 5,
  kilol: 12,
};

interface ProviderState {
  counted: number; // inference calls the provider has decided, refusals included
  dead: boolean; // budget spent or outage reached: it will refuse everything now
}

class Router {
  private brief: Brief;
  private byId = new Map<string, ProviderDir>();
  private state = new Map<string, ProviderState>();

  constructor(brief: Brief) {
    this.brief = brief;
    for (const p of brief.providers) {
      this.byId.set(p.id, p);
      this.state.set(p.id, { counted: 0, dead: false });
    }
  }

  private provider(id: string): ProviderDir {
    const p = this.byId.get(id);
    if (p === undefined) throw new Error(`unknown provider ${id}`);
    return p;
  }

  private assuredLeft(id: string): number {
    const st = this.state.get(id);
    if (st === undefined || st.dead) return 0;
    return Math.max(0, (ASSURED_CALLS[id] ?? 4) - st.counted);
  }

  /** May this row serve the request at all (free, capable, wire can carry it)? */
  private legal(row: ModelRow, entry: ManifestEntry, wantsJson: boolean): boolean {
    const req = entry.requires;
    if (req.tools === true && !row.tools) return false;
    if (req.vision === true && !row.vision) return false;
    if (req.json === true && !row.json) return false;
    if (req.min_context !== undefined && row.context < req.min_context) return false;
    if (wantsJson && this.provider(row.provider).wire === "anthropic") return false;
    return true;
  }

  /** The best legal row a provider holds for a request, or null. */
  private bestOn(providerId: string, entry: ManifestEntry, wantsJson: boolean): ModelRow | null {
    let best: ModelRow | null = null;
    for (const row of this.brief.rows) {
      if (row.provider !== providerId || !this.legal(row, entry, wantsJson)) continue;
      if (best === null || row.rating > best.rating) best = row;
    }
    return best;
  }

  /**
   * Plan the requests from `from` on: a regret-greedy assignment against the
   * assured budgets. A request is committed early when waiting would cost it
   * the most — the gap between its best provider and its best other provider,
   * weighted as the scorer weights it.
   */
  plan(from: number, wantsJsonOf: (entry: ManifestEntry) => boolean): Map<string, ModelRow> {
    const cap = new Map<string, number>();
    for (const p of this.brief.providers) cap.set(p.id, this.assuredLeft(p.id));
    const remaining = this.brief.manifest.slice(from);
    const assigned = new Map<string, ModelRow>();
    const open = new Set(remaining.map((e) => e.id));
    for (;;) {
      let pick: { entry: ManifestEntry; row: ModelRow; regret: number } | null = null;
      for (const entry of remaining) {
        if (!open.has(entry.id)) continue;
        const wantsJson = wantsJsonOf(entry);
        let best: ModelRow | null = null;
        let second = 0;
        for (const p of this.brief.providers) {
          if ((cap.get(p.id) ?? 0) <= 0) continue;
          const row = this.bestOn(p.id, entry, wantsJson);
          if (row === null) continue;
          if (best === null || row.rating > best.rating) {
            second = best?.rating ?? 0;
            best = row;
          } else if (row.rating > second) {
            second = row.rating;
          }
        }
        if (best === null) continue;
        const regret = entry.weight * (best.rating - second);
        if (pick === null || regret > pick.regret) pick = { entry, row: best, regret };
      }
      if (pick === null) break;
      assigned.set(pick.entry.id, pick.row);
      open.delete(pick.entry.id);
      cap.set(pick.row.provider, (cap.get(pick.row.provider) ?? 0) - 1);
    }
    return assigned;
  }

  /** Every legal row for a request, best first, as the failover order. */
  candidates(entry: ManifestEntry, wantsJson: boolean): ModelRow[] {
    const rows = this.brief.rows.filter((r) => this.legal(r, entry, wantsJson));
    rows.sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      const left = this.assuredLeft(b.provider) - this.assuredLeft(a.provider);
      if (left !== 0) return left;
      return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    });
    return rows;
  }

  /** Serve one request: the planned pick first, then the candidate order. */
  async serve(
    entry: ManifestEntry,
    canon: Canon,
    jsonModeFor: (row: ModelRow) => boolean,
    planned: ModelRow | undefined,
  ): Promise<{ row: ModelRow; answer: ProviderAnswer } | null> {
    const tried = new Set<string>();
    const order: ModelRow[] = [];
    if (planned !== undefined) order.push(planned);
    for (const row of this.candidates(entry, canon.wantsJson)) {
      if (planned !== undefined && row.provider === planned.provider && row.model === planned.model) continue;
      order.push(row);
    }
    for (const row of order) {
      if (tried.has(row.provider)) continue;
      const st = this.state.get(row.provider);
      if (st === undefined || st.dead) continue;
      tried.add(row.provider);
      const outcome = await callProvider(this.provider(row.provider), row.model, canon, jsonModeFor(row));
      st.counted++;
      if (outcome.ok) return { row, answer: outcome.answer };
      if (refusalIsFinal(outcome.message)) st.dead = true;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering the provider's answer on the client's wire.

const FIXED_CREATED = 1767225600; // a constant: no wall clock anywhere
let answerSeq = 0;

function splitPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += 13) pieces.push(text.slice(at, at + 13));
  return pieces.length === 0 ? [""] : pieces;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendSse(res: ServerResponse, frames: string): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  res.end(frames);
}

function renderOpenAI(res: ServerResponse, model: string, answer: ProviderAnswer, stream: boolean): void {
  answerSeq++;
  const id = `chatcmpl-agg-${answerSeq}`;
  const usage = { prompt_tokens: answer.input, completion_tokens: answer.output, total_tokens: answer.input + answer.output };
  if (!stream) {
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created: FIXED_CREATED,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: answer.text }, finish_reason: "stop", logprobs: null }],
      usage,
    });
    return;
  }
  const chunk = (delta: unknown, finish: string | null, withUsage = false): string => {
    const value: Json = { id, object: "chat.completion.chunk", created: FIXED_CREATED, model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (withUsage) {
      value.choices = [];
      value.usage = usage;
    }
    return `data: ${JSON.stringify(value)}\n\n`;
  };
  let frames = chunk({ role: "assistant", content: "" }, null);
  for (const piece of splitPieces(answer.text)) frames += chunk({ content: piece }, null);
  frames += chunk({}, "stop");
  frames += chunk({}, null, true);
  frames += "data: [DONE]\n\n";
  sendSse(res, frames);
}

function renderAnthropic(res: ServerResponse, model: string, answer: ProviderAnswer, stream: boolean): void {
  answerSeq++;
  const id = `msg_agg_${answerSeq}`;
  if (!stream) {
    sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: answer.text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: answer.input, output_tokens: answer.output },
    });
    return;
  }
  const frame = (event: string, value: unknown): string => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  let frames = frame("message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: answer.input, output_tokens: 0 } },
  });
  frames += frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const piece of splitPieces(answer.text)) {
    frames += frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
  }
  frames += frame("content_block_stop", { type: "content_block_stop", index: 0 });
  frames += frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: answer.output } });
  frames += frame("message_stop", { type: "message_stop" });
  sendSse(res, frames);
}

function renderError(res: ServerResponse, api: string, status: number, message: string): void {
  if (api === "anthropic") {
    sendJson(res, status, { type: "error", error: { type: "api_error", message } });
  } else {
    sendJson(res, status, { error: { message, type: "api_error", param: null, code: "aggregator_error" } });
  }
}

// ---------------------------------------------------------------------------
// The server and the trial lifecycle.

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 4 * 1024 * 1024) throw new Error("the request body is too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class Aggregator {
  private brief: Brief;
  private catalog: Catalog;
  private catalogJson: string;
  private router: Router;
  private byManifestId = new Map<string, ManifestEntry>();
  private servedCount = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(brief: Brief, catalog: Catalog) {
    this.brief = brief;
    this.catalog = catalog;
    this.catalogJson = JSON.stringify(catalog);
    this.router = new Router(brief);
    for (const entry of brief.manifest) this.byManifestId.set(entry.id, entry);
  }

  catalogText(): string {
    return this.catalogJson;
  }

  /** The manifest entry the client is sending now, per the env's /work. */
  private async currentEntry(): Promise<ManifestEntry | null> {
    let id: string | null = null;
    try {
      const res = await envCall("/work", {}, 3_000);
      const body: unknown = await res.json();
      if (isRecord(body) && body.done === false && typeof body.next === "string") id = body.next;
    } catch {
      id = null;
    }
    const entry = (id !== null ? this.byManifestId.get(id) : undefined) ?? this.brief.manifest[this.servedCount] ?? null;
    return entry;
  }

  private modelsRoute(res: ServerResponse, api: string): void {
    const ids = freeModelIds(this.catalog);
    if (api === "anthropic") {
      sendJson(res, 200, {
        data: ids.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z", free: true })),
        has_more: false,
        first_id: ids[0] ?? null,
        last_id: ids[ids.length - 1] ?? null,
      });
    } else {
      sendJson(res, 200, {
        object: "list",
        data: ids.map((id) => ({ id, object: "model", created: FIXED_CREATED, owned_by: "aggregator", free: true })),
      });
    }
  }

  private async chatRoute(req: IncomingMessage, res: ServerResponse, api: string): Promise<void> {
    let body: Json;
    try {
      const value: unknown = JSON.parse(await readBody(req));
      if (!isRecord(value)) throw new Error("the body is not one JSON object");
      body = value;
    } catch {
      renderError(res, api, 400, "the request body is not one JSON object");
      return;
    }
    const entry = await this.currentEntry();
    if (entry === null) {
      renderError(res, api, 503, "the workload is over");
      return;
    }
    this.servedCount++;
    const canon = api === "openai" ? canonFromOpenAI(body) : canonFromAnthropic(body);
    const stream = body.stream === true || entry.stream;
    // The plan is drawn for the requests still to come, this one first. A
    // request's JSON-mode need is its own body's flag, or — for the wire
    // that cannot carry the flag — the manifest's json requirement.
    const wantsJsonOf = (e: ManifestEntry): boolean =>
      e.id === entry.id ? canon.wantsJson : e.requires.json === true && e.api === "openai";
    const plan = this.router.plan(this.servedCount - 1, wantsJsonOf);
    const jsonModeFor = (row: ModelRow): boolean => {
      const wire = this.brief.providers.find((p) => p.id === row.provider)?.wire;
      if (wire === "anthropic") return false;
      return canon.wantsJson || entry.requires.json === true;
    };
    const served = await this.router.serve(entry, canon, jsonModeFor, plan.get(entry.id));
    if (served === null) {
      renderError(res, api, 502, "every provider refused the request");
      return;
    }
    if (api === "openai") renderOpenAI(res, served.row.model, served.answer, stream);
    else renderAnthropic(res, served.row.model, served.answer, stream);
  }

  /** Serialize the client-facing work: the client is serial, and so are we. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const run = async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? "/", "http://aggregator");
        if (req.method === "GET" && url.pathname === "/v1/models") {
          const api = req.headers["x-api-key"] !== undefined && req.headers.authorization === undefined ? "anthropic" : "openai";
          this.modelsRoute(res, api);
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
          await this.chatRoute(req, res, "openai");
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/messages") {
          await this.chatRoute(req, res, "anthropic");
          return;
        }
        renderError(res, url.pathname === "/v1/messages" ? "anthropic" : "openai", 404, `no route ${req.method} ${url.pathname}`);
      } catch (err) {
        if (!res.headersSent) renderError(res, "openai", 500, `internal: ${String(err)}`);
        else res.end();
      }
    };
    this.chain = this.chain.then(run, run);
  }
}

async function register(port: number, catalogJson: string): Promise<void> {
  const body = JSON.stringify({ protocol_version: 1, port, catalog: JSON.parse(catalogJson) });
  let pauseMs = 250;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await envCall("/register", { method: "POST", headers: { "content-type": "application/json" }, body }, 5_000);
      if (res.status >= 200 && res.status < 300) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`registration was refused with ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("registration was refused")) throw err;
    }
    await sleep(pauseMs);
    pauseMs = Math.min(pauseMs * 2, 2_000);
  }
  throw new Error("registration never succeeded");
}

async function watchForDone(server: ReturnType<typeof createServer>): Promise<void> {
  for (;;) {
    try {
      const res = await envCall("/work", {}, 3_000);
      const body: unknown = await res.json();
      if (isRecord(body) && body.done === true) break;
    } catch {
      // The env answers when it answers; keep waiting.
    }
    await sleep(200);
  }
  await sleep(100);
  server.close();
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    let catalog: Catalog = { providers: [] };
    if (process.env.MAKEFUN_PROMPT_FILE !== undefined && process.env.MAKEFUN_ENV_URL !== undefined) {
      const brief = readBrief();
      catalog = await buildCatalog(brief);
    }
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return;
  }
  const brief = readBrief();
  const catalog = await buildCatalog(brief);
  const aggregator = new Aggregator(brief, catalog);
  const server = createServer((req, res) => aggregator.handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server bound no TCP port");
  await register(address.port, aggregator.catalogText());
  void watchForDone(server);
}

main().catch((err) => {
  process.stderr.write(`free-model-aggregator: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
