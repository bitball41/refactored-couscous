import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.108.2";

const MODEL = "gpt-5.6-luna";
const GEMINI_MODEL = "gemini-3.6-flash";
const GROQ_MODEL = "openai/gpt-oss-120b";
const QWEN_MODEL = "@cf/qwen/qwen3.8-27b";
const GLM_MODEL = "zai-org/GLM-5.2";
const GLM_MODELS = ["zai-org/GLM-5.2", "ZhipuAI/GLM-5.2", "zai-org/glm-5.2"];
const GLM_URLS = [
  "https://api-inference.modelscope.ai/v1/chat/completions",
  "https://api-inference.modelscope.cn/v1/chat/completions",
];
const GEMINI_MODEL_FALLBACKS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
];
const AI_USERNAME = "Luna";
const MAX_CONTEXT_MESSAGES = 40;
const MAX_CONTEXT_CHARS = 120_000;
// Anti-spam throttle, not a usage cap: a human rarely sends more than a few
// messages a minute, and the daily numbers only exist to stop scripts.
const MAX_REQUESTS_PER_MINUTE = 20;
const MAX_REQUESTS_PER_DAY = 1000;
const GUEST_MAX_PER_MINUTE = 8;
const GUEST_MAX_PER_DAY = 120;
const LUNA_ACTION = "luna_reply";
const GUEST_ACTION = "guest_reply";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpeg|jpg|webp|gif)$/i;
const MAX_FILE_CHARS = 80_000;
const MAX_ARTIFACT_CHARS = 80_000;
const MAX_ARTIFACTS = 8;

type Mode = "chat" | "thinking" | "code";
type Effort = "low" | "high" | "xhigh";
type Provider = "openai" | "gemini" | "groq" | "workersai" | "glm";

const MODE_EFFORT: Record<Mode, Effort> = {
  chat: "low",
  thinking: "high",
  code: "xhigh",
};

// Kept below the edge platform wall clock (~150s on the free plan) with room
// for the database work that happens before and after the provider call.
const MODE_TIMEOUT: Record<Mode, number> = {
  chat: 75_000,
  thinking: 100_000,
  code: 130_000,
};

const INSTRUCTIONS_BASE = `
You are Luna, a standalone AI for focused work. You are not the Liminal Chat bot, you are not a community member, and you do not pick up that persona.

Voice:
- Direct, exact, a little dry. No corporate filler. No em dashes.
- Match the selected mode. Do not mention the mode unless asked.
- Never use the user's name, username, display name, or @handle. Do not greet them by name. Do not write "Reply to @...". Speak in the second person without naming them.

Modes:
- chat: conversational and compact. Answer the thing that was asked.
- thinking: slower and more careful. Work the problem fully before answering. Do not include a Reasoning heading, chain-of-thought, or "Reply to" section in the visible answer. Hidden reasoning is captured separately.
- code: extra-high rigor. Complete working code. For anything the user should keep, wrap each complete file exactly as:
  <liminal_file path="filename.ext">
  COMPLETE FILE CONTENTS
  </liminal_file>
  Then add a brief plain-language note. Prefer one self-contained HTML file for a small web app so it runs immediately. Keep small apps under 14,000 characters: concise CSS and JavaScript, no filler, and always include the closing </liminal_file> tag.
`.trim();

const INSTRUCTIONS_SEARCH = `
Tools:
- Search the web for current, niche, or checkable facts. Do not search for banter or things already in the conversation.

Citations:
- When you used the web, the client shows those pages as source chips. Do not list URLs, a Sources section, citations, or footnotes in the answer.
- Only look something up when you need a fact you do not already have.
- Never use markdown links.
`.trim();

const INSTRUCTIONS_NO_SEARCH = `
Web access:
- You have no web search tool in this configuration. Never claim that you searched, looked something up, or checked a live source, and do not invent URLs, citations, or a Sources section. Answer from what you know and say when you are not current.
`.trim();

const INSTRUCTIONS_VISION = `
Images:
- If images are attached, you can see them. Answer about what is actually in them.
- If no images are attached, do not claim that you can see a photo.
`.trim();

const INSTRUCTIONS_NO_VISION = `
Images:
- You cannot see images in this configuration. If the transcript mentions an omitted image, say plainly that you cannot view it and answer from the text you have.
`.trim();

function instructionsFor(provider: Provider) {
  const hasSearch = provider === "openai" || provider === "gemini";
  const hasVision = provider === "openai" || provider === "gemini" || provider === "workersai";
  return [
    INSTRUCTIONS_BASE,
    hasSearch ? INSTRUCTIONS_SEARCH : INSTRUCTIONS_NO_SEARCH,
    hasVision ? INSTRUCTIONS_VISION : INSTRUCTIONS_NO_VISION,
  ].join("\n\n");
}

const TOOLS = [{ type: "web_search" }];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function publishableKey() {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    if (typeof keys.default === "string" && keys.default) return keys.default;
  } catch { /* fall through */ }
  return Deno.env.get("SUPABASE_ANON_KEY")?.trim() || "";
}

function serviceKey() {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (typeof keys.default === "string" && keys.default) return keys.default;
  } catch { /* fall through */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
}

function validUuid(value: unknown) {
  const text = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : "";
}

function cleanText(value: unknown, limit?: number) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return typeof limit === "number" ? text.slice(0, limit) : text;
}

function parseMode(value: unknown): Mode {
  const text = String(value || "").trim().toLowerCase();
  if (text === "thinking" || text === "code") return text;
  return "chat";
}

function parseProvider(value: unknown): Provider {
  const text = String(value || "").trim().toLowerCase();
  if (text === "gemini" || text === "groq" || text === "workersai" || text === "glm") return text;
  if (text === "qwen") return "workersai";
  if (text === "openrouter" || text === "modelscope") return "glm";
  return "openai";
}

function routeFor(provider: Provider) {
  if (provider === "gemini") return { model: GEMINI_MODEL, vision: true, label: "Gemini" };
  if (provider === "groq") return { model: GROQ_MODEL, vision: false, label: "GPT OSS 120B" };
  if (provider === "workersai") return { model: QWEN_MODEL, vision: true, label: "Qwen 3.8 27B" };
  if (provider === "glm") return { model: GLM_MODEL, vision: false, label: "GLM 5.2" };
  return { model: MODEL, vision: true, label: "Luna" };
}

function secret(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function groqEffort(effort: Effort): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "xhigh") return "high";
  return "medium";
}

function toolLabel(name: string) {
  if (name === "web_search") return "Searching the web";
  return name.replaceAll("_", " ");
}

async function safetyIdentifier(userId: string) {
  const bytes = new TextEncoder().encode(`luna-direct:${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `luna_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
}

// Guests have no account id (and ai_requests.user_id references auth.users),
// so guest throttling keys off a deterministic IP hash stored in rate_events.
async function guestKey(ip: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`luna-guest:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function extractOutputText(payload: any) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const parts: string[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function collectReasoning(...parts: unknown[]) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n\n").trim();
}

function extractOpenAIReasoning(payload: any) {
  const parts: string[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "reasoning") continue;
    for (const summary of Array.isArray(item.summary) ? item.summary : []) {
      const text = typeof summary?.text === "string" ? summary.text.trim() : "";
      if (text) parts.push(text);
    }
    if (typeof item.content === "string" && item.content.trim()) parts.push(item.content.trim());
  }
  return parts.join("\n\n").trim();
}

function extractCitations(payload: any) {
  const seen = new Set<string>();
  const sources: { url: string; title: string }[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      for (const note of Array.isArray(content?.annotations) ? content.annotations : []) {
        if (note?.type !== "url_citation") continue;
        const url = cleanText(note.url, 300);
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        sources.push({ url, title: cleanText(note.title || note.url, 160) });
        if (sources.length >= 8) return sources;
      }
    }
  }
  return sources;
}

function webSearchQuery(item: any, data: any) {
  const blobs = [item, data, item?.action, data?.action, data?.item, data?.item?.action, item?.action?.search];
  for (const blob of blobs) {
    if (!blob || typeof blob !== "object") continue;
    if (typeof blob.query === "string" && blob.query.trim()) return cleanText(blob.query, 180);
    if (Array.isArray(blob.queries) && blob.queries.length) {
      const joined = blob.queries.map((q: unknown) => String(q || "").trim()).filter(Boolean).join(", ");
      if (joined) return cleanText(joined, 180);
    }
  }
  return "";
}

function harvestSearchQueries(response: any, toolsUsed: { id: string; name: string; label: string; status: string; detail: string }[], emit: (event: Record<string, unknown>) => void) {
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "web_search_call") continue;
    const query = webSearchQuery(item, item);
    if (!query) continue;
    const id = String(item.id || "web_search");
    const existing = toolsUsed.find((t) => t.id === id) || toolsUsed.find((t) => t.name === "web_search" && !t.detail);
    if (existing) {
      existing.detail = existing.detail || query;
      existing.status = "done";
      emit({ type: "tool", id: existing.id, name: "web_search", label: existing.label, status: "done", detail: existing.detail });
    } else {
      const row = { id, name: "web_search", label: "Searching the web", status: "done", detail: query };
      toolsUsed.push(row);
      emit({ type: "tool", ...row });
    }
  }
}

function geminiParts(input: unknown) {
  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
  const pushText = (value: unknown) => {
    const text = String(value || "");
    if (text) parts.push({ text });
  };
  const pushImage = (value: unknown) => {
    const url = String(value || "").trim();
    const match = url.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i);
    if (!match) return;
    const subtype = match[1].toLowerCase();
    const mimeType = subtype === "jpg" ? "image/jpeg" : `image/${subtype}`;
    const data = match[2];
    if (data) parts.push({ inlineData: { mimeType, data } });
  };
  if (typeof input === "string") {
    pushText(input);
    return parts.length ? parts : [{ text: "" }];
  }
  for (const item of Array.isArray(input) ? input : []) {
    if (typeof item === "string") {
      pushText(item);
      continue;
    }
    const content = item?.content;
    if (typeof content === "string") {
      pushText(content);
      continue;
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === "input_text") pushText(part.text);
      else if (part?.type === "input_image") pushImage(part.image_url);
      else if (typeof part?.text === "string") pushText(part.text);
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

function extractGeminiText(payload: any) {
  const texts: string[] = [];
  for (const part of Array.isArray(payload?.candidates?.[0]?.content?.parts) ? payload.candidates[0].content.parts : []) {
    if (part?.thought === true) continue;
    if (typeof part?.text === "string") texts.push(part.text);
  }
  return texts.join("\n").trim();
}

function extractGeminiReasoning(payload: any) {
  const texts: string[] = [];
  for (const part of Array.isArray(payload?.candidates?.[0]?.content?.parts) ? payload.candidates[0].content.parts : []) {
    if (part?.thought === true && typeof part?.text === "string" && part.text.trim()) texts.push(part.text.trim());
  }
  return texts.join("\n").trim();
}

function extractGeminiCitations(payload: any) {
  const seen = new Set<string>();
  const sources: { url: string; title: string }[] = [];
  for (const chunk of Array.isArray(payload?.candidates?.[0]?.groundingMetadata?.groundingChunks) ? payload.candidates[0].groundingMetadata.groundingChunks : []) {
    const url = cleanText(chunk?.web?.uri, 300);
    if (!/^https:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: cleanText(chunk?.web?.title || chunk?.web?.uri, 160) });
    if (sources.length >= 8) return sources;
  }
  return sources;
}

function extractGeminiQueries(payload: any) {
  const queries = payload?.candidates?.[0]?.groundingMetadata?.webSearchQueries;
  if (!Array.isArray(queries)) return [];
  return queries.map((query: unknown) => cleanText(query, 180)).filter(Boolean);
}

let resolvedGemini: { model: string; base: string } | null = null;

function geminiModelName(value: unknown) {
  return String(value || "").replace(/^models\//, "").trim();
}

function suggestedGeminiModel(message: unknown) {
  return geminiModelName(/use models\/([A-Za-z0-9._-]+)/i.exec(String(message || ""))?.[1] || "");
}

function stripCitedUrls(text: string, sources: { url: string }[]) {
  let out = String(text || "").replace(/\r/g, "");
  out = out.replace(/\n+(?:#{1,3}\s*)?(?:\*\*)?(?:sources?|citations?|references?)(?:\*\*)?\s*:?[ \t]*\n(?:[ \t]*(?:[-*]|\d+\.)?\s*https?:\/\/\S+[ \t]*\n?)+$/i, "");
  for (const source of sources) {
    const url = String(source?.url || "").trim();
    if (!url) continue;
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only strip list-item lines that are just the URL. Bare inline mentions
    // stay: deleting them mid-sentence mangles otherwise good answers.
    out = out.replace(new RegExp(`(?:\\n|^)[ \\t]*(?:[-*]|\\d+\\.)?[ \\t]*${escaped}[ \\t]*`, "g"), "\n");
  }
  out = out.replace(/\n+(?:#{1,3}\s*)?(?:\*\*)?(?:sources?|citations?|references?)(?:\*\*)?\s*:?[ \t]*$/i, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function functionCalls(payload: any) {
  return (Array.isArray(payload?.output) ? payload.output : []).filter((item: any) => item?.type === "function_call");
}

function isUntitled(title: unknown) {
  const raw = String(title || "").trim();
  return !raw || /^(new( luna)? chat|luna chat|new conversation)$/i.test(raw);
}

function fallbackTitle(question: string) {
  const words = cleanText(question, 180)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@\w+/g, " ")
    .replace(/[^\p{L}\p{N}'-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (!words.length) return "";
  const title = words.join(" ").trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

function cleanTitle(value: unknown) {
  const title = cleanText(value, 64)
    .replace(/^["'`“”]+|["'`“”]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return "";
  return title;
}

function conversationTitle(question: string) {
  const named = fallbackTitle(question);
  if (!named || isUntitled(named)) return "";
  return (cleanTitle(named) || named).slice(0, 64);
}

function latestUserText(history: any[]) {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (!row || row.sender === AI_USERNAME) continue;
    const text = cleanText(row.content, 500);
    if (text) return text;
  }
  return "";
}

function contextRows(rows: any[]) {
  const candidates = rows.filter((row) => row && !row.deleted && (row.content || row.media_url));
  const selected: any[] = [];
  let characters = 0;
  for (let i = candidates.length - 1; i >= 0 && selected.length < MAX_CONTEXT_MESSAGES; i--) {
    const row = candidates[i];
    const size = cleanText(row.content).length;
    if (selected.length && characters + size > MAX_CONTEXT_CHARS) break;
    selected.unshift(row);
    characters += size;
  }
  return selected;
}

function transcript(rows: any[], imageLabels: Map<string, number>) {
  return rows.map((row) => {
    const speaker = row.sender === AI_USERNAME ? "Luna" : "User";
    const label = imageLabels.get(String(row.id));
    const marker = label ? `[image ${label}] ` : (row.type && row.type !== "text" ? `[${row.type}] ` : "");
    return `${speaker}: ${marker}${cleanText(row.content)}`.trimEnd();
  }).join("\n");
}

function pickImages(rows: any[]) {
  const picked: { id: string; url: string }[] = [];
  for (let i = rows.length - 1; i >= 0 && picked.length < MAX_CONTEXT_IMAGES; i--) {
    const row = rows[i];
    if (row?.type !== "image") continue;
    const url = String(row.media_url || "").trim();
    if (url) picked.unshift({ id: String(row.id), url });
  }
  return picked;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function inlineImage(url: string, supabaseUrl: string) {
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url)) {
    return url.length <= MAX_IMAGE_BYTES ? url : "";
  }
  const publicPrefix = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/`;
  if (!url.startsWith(publicPrefix)) return "";
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return "";
  const declared = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_MIME.test(declared)) return "";
  const mime = declared === "image/jpg" ? "image/jpeg" : declared;
  if (Number(response.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) return "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return "";
  return `data:${mime};base64,${base64(bytes)}`;
}

async function collectImages(candidates: { id: string; url: string }[], supabaseUrl: string) {
  const settled = await Promise.all(candidates.map(async (item) => {
    try {
      const dataUrl = await inlineImage(item.url, supabaseUrl);
      return dataUrl ? { id: item.id, dataUrl } : null;
    } catch { return null; }
  }));
  return settled.filter(Boolean) as { id: string; dataUrl: string }[];
}

async function loadTextFile(url: string, supabaseUrl: string) {
  const publicPrefix = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/`;
  if (!url.startsWith(publicPrefix) && !url.startsWith("data:text/")) return "";
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return "";
  const text = await response.text();
  if (!text) return "";
  return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n…` : text;
}

async function reserveRequest(admin: any, id: string, userId: string, sourceMessageId: string) {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const [{ count: minuteCount }, { count: dayCount }] = await Promise.all([
    admin.from("ai_requests").select("id", { head: true, count: "exact" }).eq("user_id", userId).eq("action", LUNA_ACTION).gte("created_at", cutoff),
    admin.from("ai_requests").select("id", { head: true, count: "exact" }).eq("user_id", userId).eq("action", LUNA_ACTION).gte("created_at", today.toISOString()),
  ]);
  if ((minuteCount || 0) >= MAX_REQUESTS_PER_MINUTE) throw new Error("rate_minute");
  if ((dayCount || 0) >= MAX_REQUESTS_PER_DAY) throw new Error("rate_day");
  const claim = await admin.from("ai_requests").insert({
    id, user_id: userId, source_message_id: sourceMessageId, action: LUNA_ACTION, status: "processing",
  });
  if (!claim.error) return { duplicate: false };
  const { data: existing } = await admin.from("ai_requests")
    .select("status,response_message_id,user_id,created_at").eq("id", id).maybeSingle();
  if (!existing || existing.user_id !== userId) throw new Error("request_conflict");
  if (existing.status === "completed") return { duplicate: true, responseMessageId: existing.response_message_id || null };
  if (existing.status === "processing" && Date.now() - new Date(existing.created_at).getTime() < 60_000) {
    throw new Error("request_processing");
  }
  const retry = await admin.from("ai_requests").update({
    status: "processing", error_code: null, created_at: new Date().toISOString(), completed_at: null,
  }).eq("id", id).eq("user_id", userId);
  if (retry.error) throw new Error("request_conflict");
  return { duplicate: false };
}

// Guests get the same anti-spam shape as signed-in users with looser numbers:
// fast enough that a person never notices, strict enough that a script cannot
// run the meter. Fails open if the accounting table is unreachable: a broken
// counter should never block a real conversation.
async function throttleGuest(admin: any, key: string) {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const [{ count: minuteCount }, { count: dayCount }] = await Promise.all([
    admin.from("rate_events").select("id", { head: true, count: "exact" }).eq("key", key).eq("action", GUEST_ACTION).gte("created_at", cutoff),
    admin.from("rate_events").select("id", { head: true, count: "exact" }).eq("key", key).eq("action", GUEST_ACTION).gte("created_at", today.toISOString()),
  ]);
  if ((minuteCount || 0) >= GUEST_MAX_PER_MINUTE) throw new Error("rate_minute");
  if ((dayCount || 0) >= GUEST_MAX_PER_DAY) throw new Error("rate_day");
  await admin.from("rate_events").insert({ key, action: GUEST_ACTION });
}

function sseResponse(send: (emit: (event: Record<string, unknown>) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emit = (event: Record<string, unknown>) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { closed = true; }
      };
      // Upstream provider calls are non-streaming and can run for over a
      // minute. Comment heartbeats keep proxies and browsers from treating
      // the silence as a dead connection.
      const keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": ka\n\n")); } catch { closed = true; }
      }, 15_000);
      try {
        await send(emit);
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 80) : "unknown_error";
        emit({ type: "error", error: publicError(code), code });
      } finally {
        clearInterval(keepalive);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

function publicError(code: string) {
  if (code === "rate_minute") return "Luna is receiving messages too quickly. Try again in a minute.";
  if (code === "rate_day") return "Your daily Luna limit has been reached.";
  if (["invalid_source", "invalid_luna_dm", "request_conflict"].includes(code)) return "This request is not authorized.";
  if (code === "request_processing") return "Luna is already answering that message.";
  if (code === "openai_not_configured") return "Luna is not configured yet.";
  if (code === "gemini_not_configured") return "Gemini is not configured yet.";
  if (code === "groq_not_configured") return "GPT OSS 120B is not configured yet.";
  if (code === "workersai_not_configured") return "Qwen 3.8 27B is not configured yet.";
  if (code === "glm_not_configured") return "GLM 5.2 is not configured yet.";
  if (code === "vision_unsupported_groq") return "GPT OSS 120B is text-only. Remove photos or switch to Luna, Gemini, or Qwen 3.8 27B.";
  if (code === "vision_unsupported_glm") return "GLM 5.2 is text-only. Remove photos or switch to Luna, Gemini, or Qwen 3.8 27B.";
  if (code === "glm_unavailable" || code === "glm_paid_fallback") {
    return "GLM 5.2 is unavailable on ModelScope right now. Try again later or pick another model.";
  }
  if (/^gemini_429_/.test(code)) return "Gemini is a scarce model and its free-tier limit was hit. Wait a minute, or pick another model.";
  if (/^groq_429_/.test(code)) return "GPT OSS 120B hit a rate limit. Wait a minute, or pick another model.";
  if (/^workersai_429_/.test(code)) return "Qwen 3.8 27B hit a rate limit. Wait a minute, or pick another model.";
  if (/^glm_429_/.test(code)) return "GLM 5.2 hit a ModelScope rate limit. Wait a minute, or pick another model.";
  if (code === "glm_aliyun_unbound") {
    return "ModelScope accepted the API key, but API Inference needs an Alibaba Cloud account bound at https://modelscope.ai/my/settings/account. Bind it there, then try GLM 5.2 again.";
  }
  if (code === "glm_401" || /^glm_401_/.test(code) || /^glm_403_/.test(code)) {
    return "ModelScope rejected the API key. Use a ModelScope access token from https://www.modelscope.ai/my/myaccesstoken (the .ai site, not .cn) and store it as MODELSCOPE_API_KEY.";
  }
  if (code === "reply_insert_failed") return "Luna wrote an answer but it could not be saved. Send the message again.";
  if (/^gemini_\d{3}_/.test(code)) return "Gemini rejected the request.";
  if (/^openai_\d{3}_/.test(code)) return "Luna's model provider rejected the request.";
  if (/^groq_\d{3}_/.test(code)) return "GPT OSS 120B rejected the request.";
  if (/^workersai_\d{3}_/.test(code)) return "Qwen 3.8 27B rejected the request.";
  if (/^glm_\d{3}_/.test(code)) return "GLM 5.2 on ModelScope rejected the request.";
  return "Luna could not answer right now. Please try again.";
}

async function callOpenAI(opts: {
  input: unknown;
  userId: string;
  effort: Effort;
  timeoutMs: number;
  instructions: string;
  emit: (event: Record<string, unknown>) => void;
  toolsUsed: { id: string; name: string; label: string; status: string; detail: string }[];
}) {
  const apiKey = Deno.env.get("OPEN_AI")?.trim() || Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new Error("openai_not_configured");

  const body: Record<string, unknown> = {
    model: MODEL,
    stream: false,
    reasoning: { effort: opts.effort, summary: "auto" },
    instructions: opts.instructions,
    input: opts.input,
    tools: TOOLS,
    tool_choice: "auto",
    text: { verbosity: opts.effort === "low" ? "low" : "medium" },
    // Low effort still needs headroom: web search plus reasoning can eat a
    // small budget before any visible text is produced.
    max_output_tokens: opts.effort === "low" ? 4000 : opts.effort === "xhigh" ? 18_000 : 6000,
    safety_identifier: await safetyIdentifier(opts.userId),
    store: false,
  };

  const run = async (effort: Effort, tools: unknown[] | undefined, withSummary = true) => {
    const payload = {
      ...body,
      reasoning: withSummary ? { effort, summary: "auto" } : { effort },
      ...(tools ? { tools, tool_choice: "auto" } : { tools: undefined, tool_choice: undefined }),
    };
    if (!tools) {
      delete payload.tools;
      delete payload.tool_choice;
    }
    return fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  };

  let response = await run(opts.effort, TOOLS, true);
  if (!response.ok && opts.effort === "xhigh" && response.status === 400) {
    response = await run("high", TOOLS, true);
  }
  if (!response.ok && response.status === 400) {
    response = await run(opts.effort === "xhigh" ? "high" : opts.effort, TOOLS, false);
  }
  if (!response.ok && response.status === 400) {
    response = await run(opts.effort === "xhigh" ? "high" : opts.effort, undefined, false);
  }
  if (!response.ok) {
    let providerCode = "unknown";
    try {
      const failure = await response.json();
      providerCode = cleanText(failure?.error?.code || failure?.error?.type || "unknown", 60).replace(/[^a-z0-9_-]/gi, "_");
    } catch { /* status is enough */ }
    throw new Error(`openai_${response.status}_${providerCode}`);
  }

  const finalResponse = await response.json();
  if (!finalResponse || finalResponse.error || finalResponse.status === "failed") throw new Error("openai_failed");
  for (const item of Array.isArray(finalResponse.output) ? finalResponse.output : []) {
    if (item?.type === "web_search_call") {
      const id = String(item.id || "web_search");
      const query = webSearchQuery(item, item);
      const existing = opts.toolsUsed.find((t) => t.id === id);
      const row = existing || { id, name: "web_search", label: toolLabel("web_search"), status: "done", detail: query };
      row.status = "done";
      if (query) row.detail = query;
      if (!existing) opts.toolsUsed.push(row);
      opts.emit({ type: "tool", id: row.id, name: row.name, label: row.label, status: "done", detail: row.detail });
    }
    if (item?.type === "function_call") {
      const id = item.call_id || item.id || item.name;
      const name = String(item.name || "tool");
      opts.emit({ type: "tool", id, name, label: toolLabel(name), status: "running", detail: cleanText(item.name, 80) });
    }
  }
  harvestSearchQueries(finalResponse, opts.toolsUsed, opts.emit);
  return finalResponse;
}

async function callGemini(opts: {
  input: unknown;
  effort: Effort;
  timeoutMs: number;
  instructions: string;
  emit: (event: Record<string, unknown>) => void;
  toolsUsed: { id: string; name: string; label: string; status: string; detail: string }[];
}) {
  const apiKey = Deno.env.get("GEMINI_API")?.trim();
  if (!apiKey) throw new Error("gemini_not_configured");

  const parts = geminiParts(opts.input);
  const maxOutputTokens = opts.effort === "low" ? 2500 : opts.effort === "xhigh" ? 18000 : 6000;
  const thinkingBudget = opts.effort === "low" ? 1024 : opts.effort === "xhigh" ? 24576 : 8192;
  const base = resolvedGemini?.base || "https://generativelanguage.googleapis.com/v1beta";

  const run = async (model: string, includeTools: boolean, includeThinking: boolean) => {
    const generationConfig: Record<string, unknown> = { maxOutputTokens };
    if (includeThinking) {
      generationConfig.thinkingConfig = /^gemini-3/i.test(model)
        ? { thinkingLevel: opts.effort === "low" ? "low" : "high", includeThoughts: true }
        : { thinkingBudget, includeThoughts: true };
    }
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: opts.instructions }] },
      contents: [{ role: "user", parts }],
      generationConfig,
    };
    if (includeTools) body.tools = [{ google_search: {} }];
    const url = `${base}/models/${model}:generateContent`;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  };

  let model = resolvedGemini?.model || GEMINI_MODEL;
  let response = await run(model, true, true);
  if (!response.ok && response.status === 400) response = await run(model, false, true);
  if (!response.ok && response.status === 400) response = await run(model, false, false);
  if (!response.ok && response.status === 404) {
    let suggested = "";
    try {
      const failure = await response.clone().json();
      suggested = suggestedGeminiModel(failure?.error?.message);
    } catch { /* fall through */ }
    const tried = new Set([model]);
    const candidates = [suggested, ...GEMINI_MODEL_FALLBACKS].filter((name) => name && !tried.has(name));
    for (const candidate of candidates) {
      tried.add(candidate);
      model = candidate;
      response = await run(model, true, true);
      if (!response.ok && response.status === 400) response = await run(model, false, true);
      if (!response.ok && response.status === 400) response = await run(model, false, false);
      if (response.ok || response.status !== 404) break;
    }
  }
  if (response.ok) resolvedGemini = { model, base };
  if (!response.ok) {
    let providerCode = "unknown";
    let message = "";
    try {
      const failure = await response.json();
      providerCode = cleanText(failure?.error?.status || failure?.error?.code || failure?.error?.type || "unknown", 60).replace(/[^a-z0-9_-]/gi, "_");
      message = cleanText(failure?.error?.message, 180);
    } catch { /* status is enough */ }
    console.warn("[luna-direct] Gemini request failed", {
      status: response.status,
      providerCode,
      message,
      model,
      base,
    });
    throw new Error(`gemini_${response.status}_${providerCode}`);
  }

  const payload = await response.json();
  const text = extractGeminiText(payload);
  if (!text) throw new Error("gemini_empty_response");
  const sources = extractGeminiCitations(payload);
  const reasoning = extractGeminiReasoning(payload);
  for (const query of extractGeminiQueries(payload)) {
    const row = {
      id: `web_search_${opts.toolsUsed.length + 1}`,
      name: "web_search",
      label: "Searching the web",
      status: "done",
      detail: query,
    };
    opts.toolsUsed.push(row);
    opts.emit({ type: "tool", ...row });
  }
  console.info("[luna-direct] Gemini reply", { model, base });
  return { text, sources, model, reasoning };
}

function chatMessagesFromInput(input: unknown, vision: boolean, instructions: string) {
  const messages: { role: string; content: unknown }[] = [{ role: "system", content: instructions }];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  const parts: { type: string; text?: string; image_url?: { url: string } }[] = [];
  for (const item of Array.isArray(input) ? input : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "input_text" && part.text) parts.push({ type: "text", text: part.text });
      else if (part?.type === "input_image" && part.image_url) {
        if (!vision) throw new Error("vision_unsupported");
        parts.push({ type: "image_url", image_url: { url: part.image_url } });
      }
    }
  }
  messages.push({
    role: "user",
    content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : (parts.length ? parts : ""),
  });
  return messages;
}

function extractChatText(payload: any) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    }).join("\n").trim();
  }
  if (typeof payload?.result?.response === "string") return payload.result.response.trim();
  if (typeof payload?.result?.message === "string") return payload.result.message.trim();
  if (typeof payload?.response === "string") return payload.response.trim();
  return "";
}

function extractChatReasoning(payload: any) {
  const message = payload?.choices?.[0]?.message || payload?.result?.message || {};
  const details = Array.isArray(message.reasoning_details)
    ? message.reasoning_details.map((item: any) => item?.text || item?.summary || item?.content || "").join("\n")
    : "";
  return collectReasoning(
    message.reasoning,
    message.reasoning_content,
    details,
    payload?.reasoning,
    payload?.result?.reasoning,
  );
}

function peelReasoning(text: string) {
  let reply = String(text || "").replace(/\r/g, "");
  const chunks: string[] = [];
  reply = reply.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_whole, body) => {
    const bit = String(body || "").trim();
    if (bit) chunks.push(bit);
    return "";
  });
  const dumped = /^(?:#{1,3}\s*)?(?:\*\*)?reasoning(?:\*\*)?\s*:?[ \t]*\n([\s\S]+?)(?:\n+(?:#{1,3}\s*)?(?:\*\*)?(?:reply(?:\s+to\b[^\n]*)?|answer|final(?:\s+answer)?)(?:\*\*)?\s*:?[ \t]*\n([\s\S]+))?$/i.exec(reply.trim());
  if (dumped) {
    const reason = String(dumped[1] || "").trim();
    const rest = String(dumped[2] || "").trim();
    if (reason) chunks.push(reason);
    if (rest) reply = rest;
  }
  reply = reply.replace(/^(?:\*\*)?reply to @?\w+(?:\*\*)?\s*\n+/i, "").trim();
  return { reply: reply.replace(/\n{3,}/g, "\n\n").trim(), reasoning: chunks.join("\n\n").trim() };
}

function providerHttpError(prefix: string, response: Response, failure: any) {
  const raw = failure?.error?.code || failure?.error?.type || failure?.error?.status
    || failure?.code || failure?.errors?.[0]?.code || "unknown";
  const code = cleanText(raw, 60).replace(/[^a-z0-9_-]/gi, "_") || "unknown";
  return new Error(`${prefix}_${response.status}_${code}`.slice(0, 80));
}

async function postJson(url: string, apiKey: string, body: Record<string, unknown>, timeoutMs: number, extraHeaders?: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function glmKeyVariants(raw: string): string[] {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^ms-/i, "");
  return [...new Set([trimmed, stripped, stripped ? `ms-${stripped}` : ""].filter(Boolean))];
}

function glmHost(url: string): string {
  return url.includes(".ai/") ? "modelscope.ai" : "modelscope.cn";
}

function glmFailureMessage(failure: any): string {
  return String(failure?.error?.message || failure?.error || failure?.message || "");
}

function glmAuthCode(failure: any): string {
  const message = glmFailureMessage(failure);
  if (/bind your Alibaba Cloud account/i.test(message)) return "glm_aliyun_unbound";
  if (/Authentication failed|valid ModelScope token/i.test(message)) return "glm_401";
  return "";
}

async function callChatProvider(opts: {
  provider: "groq" | "workersai" | "glm";
  input: unknown;
  effort: Effort;
  timeoutMs: number;
  instructions: string;
}) {
  const vision = opts.provider === "workersai";
  const messages = chatMessagesFromInput(opts.input, vision, opts.instructions);
  const maxTokens = opts.effort === "low" ? 2500 : opts.effort === "xhigh" ? 18_000 : 6000;

  if (opts.provider === "groq") {
    const apiKey = secret("groq_API", "GROQ_API", "GROQ_API_KEY");
    if (!apiKey) throw new Error("groq_not_configured");
    const url = "https://api.groq.com/openai/v1/chat/completions";
    const body: Record<string, unknown> = {
      model: GROQ_MODEL,
      messages,
      max_completion_tokens: maxTokens,
      reasoning_effort: groqEffort(opts.effort),
      reasoning_format: "parsed",
      temperature: 1,
    };
    let response = await postJson(url, apiKey, body, opts.timeoutMs);
    if (!response.ok && response.status === 400) {
      delete body.reasoning_format;
      response = await postJson(url, apiKey, body, opts.timeoutMs);
    }
    if (!response.ok && response.status === 400) {
      delete body.reasoning_effort;
      response = await postJson(url, apiKey, body, opts.timeoutMs);
    }
    if (!response.ok) {
      let failure: any = {};
      try { failure = await response.json(); } catch { /* status is enough */ }
      throw providerHttpError("groq", response, failure);
    }
    const payload = await response.json();
    const text = extractChatText(payload);
    if (!text) throw new Error("groq_empty_response");
    return { text, reasoning: extractChatReasoning(payload), model: GROQ_MODEL };
  }

  if (opts.provider === "workersai") {
    const apiKey = secret("workers_AI_rest_token", "WORKERS_AI_REST_TOKEN");
    const accountId = secret("CLOUDFLARE_ACCOUNT_ID");
    if (!apiKey || !accountId) throw new Error("workersai_not_configured");
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: QWEN_MODEL,
      messages,
      max_tokens: maxTokens,
      reasoning_effort: groqEffort(opts.effort),
      include_reasoning: true,
    };
    let response = await postJson(url, apiKey, body, opts.timeoutMs);
    if (!response.ok && response.status === 400) {
      delete body.include_reasoning;
      response = await postJson(url, apiKey, body, opts.timeoutMs);
    }
    if (!response.ok && response.status === 400) {
      delete body.reasoning_effort;
      response = await postJson(url, apiKey, body, opts.timeoutMs);
    }
    if (!response.ok && (response.status === 404 || response.status === 400)) {
      response = await postJson(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${QWEN_MODEL}`,
        apiKey,
        { messages },
        opts.timeoutMs,
      );
    }
    if (!response.ok) {
      let failure: any = {};
      try { failure = await response.json(); } catch { /* status is enough */ }
      throw providerHttpError("workersai", response, failure);
    }
    const payload = await response.json();
    const text = extractChatText(payload);
    if (!text) throw new Error("workersai_empty_response");
    return { text, reasoning: extractChatReasoning(payload), model: QWEN_MODEL };
  }

  const apiKey = secret("MODELSCOPE_API_KEY", "MODELSCOPE_API_TOKEN", "MODELSCOPE_API", "modelscope");
  if (!apiKey) throw new Error("glm_not_configured");
  // ModelScope's OpenAI-compatible layer understands enable_thinking and
  // reasoning_effort. Anything more exotic risks a 400 rather than reasoning.
  const glmEffort = opts.effort === "low" ? "low" : "high";
  const keys = glmKeyVariants(apiKey);
  const makeBody = (model: string, reasoning: boolean) => {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
    };
    if (reasoning) {
      body.enable_thinking = true;
      body.reasoning_effort = glmEffort;
    }
    return body;
  };

  let lastResponse: Response | null = null;
  let lastFailure: any = {};
  let payload: any = null;
  let usedModel = GLM_MODEL;
  for (const url of GLM_URLS) {
    for (const key of keys) {
      for (const model of GLM_MODELS) {
        let response = await postJson(url, key, makeBody(model, true), opts.timeoutMs);
        if (!response.ok && response.status === 400) {
          response = await postJson(url, key, makeBody(model, false), opts.timeoutMs);
        }
        lastResponse = response;
        if (response.ok) {
          payload = await response.json();
          usedModel = model;
          break;
        }
        try { lastFailure = await response.json(); } catch { lastFailure = {}; }
        console.log(JSON.stringify({
          stage: "glm_try",
          status: response.status,
          host: glmHost(url),
          model,
          key_len: key.length,
          ms_prefix: key.toLowerCase().startsWith("ms-"),
          error: cleanText(JSON.stringify(lastFailure), 240),
        }));
        if (response.status === 401 || response.status === 403) {
          const authCode = glmAuthCode(lastFailure);
          if (authCode === "glm_aliyun_unbound") throw new Error(authCode);
          break;
        }
        if (response.status === 404 || response.status === 400) continue;
        if (response.status === 429) throw providerHttpError("glm", response, lastFailure);
        break;
      }
      if (payload) break;
    }
    if (payload) break;
  }
  if (!payload || !lastResponse) {
    const message = glmFailureMessage(lastFailure);
    const authCode = glmAuthCode(lastFailure);
    if (authCode) throw new Error(authCode);
    if (lastResponse && (lastResponse.status === 401 || lastResponse.status === 403)) {
      throw new Error("glm_401");
    }
    if (lastResponse && (lastResponse.status === 402 || lastResponse.status === 404 || lastResponse.status === 503
      || /not (found|available)|unavailable|no (endpoints?|providers?)/i.test(message))) {
      throw new Error("glm_unavailable");
    }
    throw providerHttpError("glm", lastResponse || new Response(null, { status: 502 }), lastFailure);
  }
  const text = extractChatText(payload);
  if (!text) throw new Error("glm_empty_response");
  return { text, reasoning: extractChatReasoning(payload), model: usedModel };
}

function extractArtifacts(text: string) {
  const files = new Map<string, string>();
  const pattern = /<liminal_file\s+path=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/liminal_file>/gi;
  const reply = String(text || "").replace(pattern, (_whole, doublePath, singlePath, rawContent) => {
    if (files.size >= MAX_ARTIFACTS) return "";
    const path = cleanText(doublePath || singlePath || "file.txt", 80)
      .replaceAll("..", "")
      .replace(/^[\/\\]+/, "")
      .replaceAll("\\", "_")
      .replaceAll("/", "_") || "file.txt";
    let content = String(rawContent || "").trim();
    const fenced = content.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    if (fenced) content = fenced[1];
    if (content) files.set(path, content.slice(0, MAX_ARTIFACT_CHARS));
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { reply, files };
}

function sanitizeImportedReplyTo(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const meta = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof meta.mode === "string") out.mode = cleanText(meta.mode, 20);
  if (typeof meta.provider === "string") out.provider = cleanText(meta.provider, 20);
  if (typeof meta.model === "string") out.model = cleanText(meta.model, 80);
  if (typeof meta.reasoning_effort === "string") out.reasoning_effort = cleanText(meta.reasoning_effort, 20);
  if (typeof meta.reasoning === "string" && meta.reasoning.trim()) out.reasoning = cleanText(meta.reasoning, 12_000);
  if (Array.isArray(meta.sources)) {
    const sources = meta.sources.slice(0, 8).map((item: any) => ({
      url: cleanText(item?.url, 300),
      title: cleanText(item?.title || item?.url, 160),
    })).filter((item) => /^https?:\/\//i.test(item.url));
    if (sources.length) out.sources = sources;
  }
  if (Array.isArray(meta.tools)) {
    const tools = meta.tools.slice(0, 12).map((tool: any) => ({
      name: cleanText(tool?.name, 40),
      label: cleanText(tool?.label, 80),
      status: tool?.status === "running" ? "running" : "done",
      detail: cleanText(tool?.detail, 180),
    })).filter((tool) => tool.name);
    if (tools.length) out.tools = tools;
  }
  if (Array.isArray(meta.files)) {
    const files = meta.files.slice(0, MAX_ARTIFACTS).map((file: any) => ({
      path: cleanText(file?.path, 80) || "file.txt",
      bytes: Number(file?.bytes) || String(file?.content || "").length,
      content: String(file?.content || "").slice(0, 20_000),
    })).filter((file) => file.content);
    if (files.length) out.files = files;
  }
  return Object.keys(out).length ? out : null;
}

async function generateFromHistory(opts: {
  emit: (event: Record<string, unknown>) => void;
  mode: Mode;
  actorName: string;
  history: any[];
  supabaseUrl: string;
  userId: string;
  provider: Provider;
}) {
  const effort = MODE_EFFORT[opts.mode];
  const route = routeFor(opts.provider);
  const instructions = instructionsFor(opts.provider);
  let model = route.model;
  opts.emit({
    type: "thinking",
    mode: opts.mode,
    effort,
    provider: opts.provider,
    model,
    label: opts.mode === "code" ? "working" : opts.mode === "thinking" ? "thinking" : "answering",
  });
  let context = contextRows(opts.history);
  let omittedImages = false;
  if (!route.vision) {
    // Only the message being answered can hard-block a text-only model.
    // Older images are dropped from context instead of wedging the whole
    // conversation forever.
    const latest = context[context.length - 1];
    if (latest?.type === "image") {
      throw new Error(opts.provider === "glm" ? "vision_unsupported_glm" : "vision_unsupported_groq");
    }
    const kept = context.filter((row) => row.type !== "image");
    omittedImages = kept.length !== context.length;
    context = kept;
  }
  const imageRows = pickImages(context);
  const attachments = await collectImages(imageRows, opts.supabaseUrl);
  const imageLabels = new Map(attachments.map((item, index) => [item.id, index + 1]));
  const fileNotes: string[] = [];
  for (const row of context) {
    if (row.type !== "file" || !row.media_url) continue;
    const text = await loadTextFile(String(row.media_url), opts.supabaseUrl);
    if (!text) continue;
    const name = String(row.media_url).split("__").pop() || "file";
    fileNotes.push(`Attached file ${decodeURIComponent(name)}:\n${text}`);
  }
  const imageNote = attachments.length
    ? `\n\n${attachments.length} image${attachments.length === 1 ? " is" : "s are"} attached after this text.`
    : "";
  const omittedNote = omittedImages
    ? "\n\nEarlier images in this conversation were omitted because this model is text-only."
    : "";
  const prompt = `Mode: ${opts.mode} (reasoning effort ${effort}). Reply to the user. Do not use their name, username, or @handle.\n\nConversation:\n${transcript(context, imageLabels)}${fileNotes.length ? `\n\n${fileNotes.join("\n\n")}` : ""}${imageNote}${omittedNote}`;
  const input = attachments.length
    ? [{
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...attachments.map((item) => ({ type: "input_image", image_url: item.dataUrl, detail: "auto" })),
      ],
    }]
    : prompt;
  const toolsUsed: { id: string; name: string; label: string; status: string; detail: string }[] = [];
  let rawText = "";
  let reasoning = "";
  let sources: { url: string; title: string }[] = [];
  if (opts.provider === "gemini") {
    const gemini = await callGemini({
      input, effort, timeoutMs: MODE_TIMEOUT[opts.mode], instructions, emit: opts.emit, toolsUsed,
    });
    rawText = gemini.text;
    reasoning = gemini.reasoning || "";
    sources = gemini.sources;
    if (gemini.model) model = gemini.model;
  } else if (opts.provider === "openai") {
    const response = await callOpenAI({
      input, userId: opts.userId, effort, timeoutMs: MODE_TIMEOUT[opts.mode], instructions, emit: opts.emit, toolsUsed,
    });
    harvestSearchQueries(response, toolsUsed, opts.emit);
    sources = extractCitations(response);
    rawText = extractOutputText(response);
    reasoning = extractOpenAIReasoning(response);
  } else {
    const chat = await callChatProvider({
      provider: opts.provider,
      input,
      effort,
      timeoutMs: MODE_TIMEOUT[opts.mode],
      instructions,
    } as { provider: "groq" | "workersai" | "glm"; input: unknown; effort: Effort; timeoutMs: number; instructions: string });
    rawText = chat.text;
    reasoning = chat.reasoning || "";
    if (chat.model) model = chat.model;
  }
  const peeled = peelReasoning(rawText);
  rawText = peeled.reply || rawText;
  reasoning = collectReasoning(reasoning, peeled.reasoning);
  const parsed = extractArtifacts(stripCitedUrls(cleanText(rawText), sources));
  const written = [...parsed.files.keys()];
  const reply = parsed.reply
    || (written.length === 1
      ? `Built ${written[0]}. Download it below.`
      : written.length > 1
        ? `Built ${written.length} files. Download them below.`
        : "");
  if (!reply) throw new Error(`${opts.provider}_empty_response`);
  opts.emit({ type: "sources", sources });
  return {
    reply,
    reasoning: cleanText(reasoning, 12_000),
    sources,
    effort,
    toolsUsed,
    artifacts: [...parsed.files.entries()].map(([path, content]) => ({ path, content, bytes: content.length })),
    provider: opts.provider,
    model,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Request is too large" }, 413);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const publicKey = publishableKey();
  const serverKey = serviceKey();
  if (!supabaseUrl || !publicKey || !serverKey) return json({ error: "Server configuration is incomplete" }, 500);

  const admin = createClient(supabaseUrl, serverKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "A JSON request body is required" }, 400); }
  const action = String(body.action || "");

  if (action === "guest_reply") {
    const mode = parseMode(body.mode);
    const provider = parseProvider(body.provider);
    const history = Array.isArray(body.messages) ? body.messages.slice(-MAX_CONTEXT_MESSAGES) : [];
    if (!history.length) return json({ error: "A message is required" }, 400);
    const needsTitle = body.needs_title === true;
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "guest";
    const guestHash = await guestKey(ip);
    try {
      await throttleGuest(admin, guestHash);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "rate_minute" || code === "rate_day") {
        return json({ error: publicError(code), code }, 429);
      }
      console.warn("[luna-direct] guest throttle unavailable", code || "unknown");
    }
    return sseResponse(async (emit) => {
      try {
        const prepared = history.map((row: any, index: number) => ({
          id: String(row?.id || `g${index}`),
          sender: String(row?.sender || "") === AI_USERNAME ? AI_USERNAME : "guest",
          content: cleanText(row?.content, MAX_FILE_CHARS),
          type: ["image", "file"].includes(String(row?.type || "")) ? String(row.type) : "text",
          media_url: String(row?.media_url || "").slice(0, MAX_IMAGE_BYTES * 2),
          deleted: false,
        }));
        const result = await generateFromHistory({
          emit,
          mode,
          actorName: "guest",
          history: prepared,
          supabaseUrl,
          userId: `guest:${guestHash.slice(0, 24)}`,
          provider,
        });
        const named = needsTitle ? conversationTitle(latestUserText(prepared)) : "";
        const title = named && !isUntitled(named) ? named : "";
        emit({
          type: "done",
          reply: result.reply,
          mode,
          provider: result.provider,
          model: result.model,
          reasoning_effort: result.effort,
          reasoning: result.reasoning || "",
          sources: result.sources,
          tools: result.toolsUsed.map((t) => ({ name: t.name, label: t.label, status: t.status, detail: t.detail })),
          files: result.artifacts,
          ...(title && !isUntitled(title) ? { title } : {}),
        });
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 80) : "unknown_error";
        console.error("luna-direct guest_reply failed", code);
        emit({ type: "error", error: publicError(code), code });
      }
    });
  }

  const authorization = req.headers.get("authorization")?.trim() || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return json({ error: "Signed-in session required" }, 401);

  const actorClient = createClient(supabaseUrl, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ error: "Signed-in session required" }, 401);
  const { data: actor } = await admin.from("profiles").select("username,is_banned").eq("user_id", authData.user.id).maybeSingle();
  if (!actor || actor.is_banned) return json({ error: "Active account required" }, 403);

  if (action === "import_guest") {
    const threads = Array.isArray(body.threads) ? body.threads.slice(0, 20) : [];
    let imported = 0;
    const failures: string[] = [];
    for (const thread of threads) {
      const title = cleanText((thread as any)?.title, 64) || "New conversation";
      const messages = (Array.isArray((thread as any)?.messages) ? (thread as any).messages : [])
        .slice(0, 120)
        .map((msg: any) => ({
          sender: String(msg?.sender || "") === AI_USERNAME ? AI_USERNAME : "user",
          content: cleanText(msg?.content, 20_000),
          type: ["image", "file"].includes(String(msg?.type || "")) ? String(msg.type) : "text",
          media_url: String(msg?.media_url || "").startsWith("data:") ? null : (msg?.media_url ? String(msg.media_url).slice(0, 1000) : null),
          reply_to: sanitizeImportedReplyTo(msg?.reply_to),
        }))
        .filter((msg: any) => msg.content || msg.media_url);
      if (!messages.length) continue;
      const result = await admin.rpc("chat_import_guest_thread", {
        p_username: actor.username,
        p_title: title,
        p_messages: messages,
      });
      if (result.error || !validUuid(result.data)) {
        failures.push(title);
        console.error("[luna-direct] import_guest thread failed", title, result.error?.message || "unknown");
        continue;
      }
      imported++;
    }
    if (failures.length) {
      return json({
        error: `Could not save ${failures.length} conversation${failures.length === 1 ? "" : "s"}. Your guest history is still on this device; try again.`,
        imported,
      }, 500);
    }
    return json({ ok: true, imported });
  }

  if (action === "delete_conversation") {
    const dmId = validUuid(body.dm_id);
    if (!dmId) return json({ error: "Invalid conversation" }, 400);
    const { data: dm } = await admin.from("dms").select("id,participants").eq("id", dmId).maybeSingle();
    const participants = Array.isArray(dm?.participants) ? dm.participants : [];
    if (!dm || participants.length !== 2 || !participants.includes(actor.username) || !participants.includes(AI_USERNAME)) {
      return json({ error: "Conversation not found" }, 404);
    }
    const messages = await admin.from("dm_messages").delete().eq("dm_id", dmId);
    if (messages.error) return json({ error: "Could not delete conversation" }, 500);
    const removed = await admin.from("dms").delete().eq("id", dmId);
    if (removed.error) return json({ error: "Could not delete conversation" }, 500);
    return json({ ok: true });
  }

  if (action !== "reply") return json({ error: "Invalid AI request" }, 400);
  const sourceMessageId = validUuid(body.source_message_id);
  if (!sourceMessageId) return json({ error: "Invalid AI request" }, 400);
  const mode = parseMode(body.mode);
  const provider = parseProvider(body.provider);

  return sseResponse(async (emit) => {
    let reserved = false;
    try {
      const claim = await reserveRequest(admin, sourceMessageId, authData.user.id, sourceMessageId);
      if (claim.duplicate) {
        emit({ type: "done", duplicate: true, response_message_id: claim.responseMessageId || null });
        return;
      }
      reserved = true;

      const dmResult = await actorClient.from("dm_messages").select("*").eq("id", sourceMessageId).maybeSingle();
      const source = dmResult.data;
      if (!source || source.sender !== actor.username || source.deleted || !["text", "image", "file"].includes(source.type)) {
        throw new Error("invalid_source");
      }
      const { data: dm } = await actorClient.from("dms").select("id,participants,title").eq("id", source.dm_id).maybeSingle();
      const participants = Array.isArray(dm?.participants) ? dm.participants : [];
      if (participants.length !== 2 || !participants.includes(actor.username) || !participants.includes(AI_USERNAME)) {
        throw new Error("invalid_luna_dm");
      }
      const historyResult = await actorClient.from("dm_messages")
        .select("id,sender,content,type,media_url,deleted,created_at")
        .eq("dm_id", source.dm_id)
        .lte("created_at", source.created_at)
        .order("created_at", { ascending: false })
        .limit(MAX_CONTEXT_MESSAGES);
      if (historyResult.error) throw new Error("history_unavailable");
      const history = (historyResult.data || []).reverse();
      const needsTitle = isUntitled(dm?.title) || body.needs_title === true;
      const result = await generateFromHistory({
        emit,
        mode,
        actorName: actor.username,
        history,
        supabaseUrl,
        userId: authData.user.id,
        provider,
      });

      // The conversation may have been deleted while the (paid) generation was
      // running. That is a normal user action, not an error: record it and end
      // the stream quietly instead of failing with reply_insert_failed.
      const { data: dmStillThere } = await admin.from("dms").select("id").eq("id", source.dm_id).maybeSingle();
      if (!dmStillThere) {
        await admin.from("ai_requests").update({
          status: "failed", error_code: "dm_deleted", completed_at: new Date().toISOString(),
        }).eq("id", sourceMessageId);
        emit({ type: "done", aborted: true });
        return;
      }

      const title = needsTitle ? conversationTitle(latestUserText(history) || cleanText(source.content, 500)) : "";
      if (title) {
        await admin.from("dms").update({ title }).eq("id", source.dm_id);
      }

      const replyTo = {
        id: source.id,
        sender: source.sender,
        snippet: cleanText(source.content || (source.type !== "text" ? `[${source.type}]` : ""), 90),
        mode,
        provider: result.provider,
        model: result.model,
        reasoning_effort: result.effort,
        reasoning: result.reasoning || "",
        sources: result.sources,
        tools: result.toolsUsed.map((t) => ({ name: t.name, label: t.label, status: t.status, detail: t.detail })),
        files: result.artifacts.map((f) => ({ path: f.path, bytes: f.bytes, content: f.content })),
      };

      const inserted = await admin.rpc("chat_insert_luna_reply", {
        p_mode: "dm",
        p_destination_id: String(source.dm_id),
        p_content: result.reply,
        p_reply_to: replyTo,
      });
      if (inserted.error || !validUuid(inserted.data)) throw new Error("reply_insert_failed");

      await admin.from("ai_requests").update({
        status: "completed",
        response_message_id: inserted.data,
        completed_at: new Date().toISOString(),
      }).eq("id", sourceMessageId);

      emit({
        type: "done",
        response_message_id: inserted.data,
        reply: result.reply,
        mode,
        provider: result.provider,
        model: result.model,
        reasoning_effort: result.effort,
        reasoning: result.reasoning || "",
        sources: result.sources,
        tools: replyTo.tools,
        files: result.artifacts.map((f) => ({ path: f.path, bytes: f.bytes })),
        ...(title ? { title } : {}),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 80) : "unknown_error";
      console.error("luna-direct reply failed", code);
      if (reserved) {
        await admin.from("ai_requests").update({
          status: "failed", error_code: code, completed_at: new Date().toISOString(),
        }).eq("id", sourceMessageId);
      }
      emit({ type: "error", error: publicError(code), code });
    }
  });
});
