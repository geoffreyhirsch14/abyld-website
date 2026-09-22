// ---- Claude/Anthropic-backed version of the AI room demo ----
// Uses Anthropic's Messages API directly instead of a free-tier router. Real Claude models
// are far more reliable than free shared-pool models, and at this traffic (rate-limited to a
// handful of requests per visitor per hour) the per-request cost is a fraction of a cent.
import { getStore } from "@netlify/blobs";

// ---- Config (all overridable via Netlify environment variables) ----
// claude-haiku-4-5 is fast and cheap — plenty for a short structured-output task like this.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TEXT_LEN = 600;
const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024; // ~4MB of base64 (~3MB actual image)
const PER_IP_HOURLY_LIMIT = parseInt(process.env.AI_ROOM_IP_HOURLY_LIMIT || "5", 10);
const GLOBAL_DAILY_LIMIT = parseInt(process.env.AI_ROOM_GLOBAL_DAILY_LIMIT || "100", 10);

const WALL_COLORS = ["white", "sand", "sage", "slate blue", "charcoal"];
const ACCENT_COLORS = ["terracotta", "navy", "forest", "plum", "black", "ivory"];

function jsonResponse(status, body) {
        return new Response(JSON.stringify(body), {
                  status,
                  headers: { "content-type": "application/json" },
        });
}

function nearestEnum(value, allowed, fallback) {
        if (!value) return fallback;
        const v = String(value).toLowerCase().trim();
        if (allowed.includes(v)) return v;
        const hit = allowed.find((a) => v.indexOf(a) !== -1 || a.indexOf(v) !== -1);
        return hit || fallback;
}

function clampNum(value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
}

// The model can hallucinate outside our schema (wrong color names, unit mixups, etc.) —
// clamp/validate everything server-side before it ever reaches the client.
function sanitizeResult(raw) {
        if (!raw || typeof raw !== "object") return null;
        return {
                  width_ft: clampNum(raw.width_ft, 4, 40, 12),
                  depth_ft: clampNum(raw.depth_ft, 4, 40, 12),
                  height_ft: clampNum(raw.height_ft, 6, 20, 9),
                  wall_color: nearestEnum(raw.wall_color, WALL_COLORS, "white"),
                  counter_color: nearestEnum(raw.counter_color, ACCENT_COLORS, null),
                  island_color: nearestEnum(raw.island_color, ACCENT_COLORS, null),
                  has_island: typeof raw.has_island === "boolean" ? raw.has_island : true,
                  notes: typeof raw.notes === "string" ? raw.notes.slice(0, 140) : "",
        };
}

// Pulls the first {...} JSON object out of a model response, tolerating markdown code fences
// or stray commentary around it.
function extractJson(str) {
        if (!str) return null;
        const start = str.indexOf("{");
        const end = str.lastIndexOf("}");
        if (start === -1 || end === -1 || end < start) return null;
        try {
                  return JSON.parse(str.slice(start, end + 1));
        } catch {
                  return null;
        }
}

const SYSTEM_PROMPT =
        "You're configuring a simple 3D room preview for a home-renovation website. Based on the description and/or photo, decide reasonable room dimensions (in feet) and colors. " +
        `Allowed wall_color values: ${WALL_COLORS.join(", ")}. Allowed counter_color/island_color values: ${ACCENT_COLORS.join(", ")}. ` +
        "If something isn't mentioned, make a sensible default rather than omitting it.";

const SCHEMA_DESCRIPTION =
        '{"width_ft": number (4-40), "depth_ft": number (4-40), "height_ft": number (6-20), ' +
        '"wall_color": string, "counter_color": string, "island_color": string, "has_island": boolean, ' +
        '"notes": string (a short, <15 word human-readable summary of what was applied)}';

const SET_ROOM_TOOL = {
        name: "set_room",
        description: "Set the 3D preview room's dimensions and colors.",
        input_schema: {
                  type: "object",
                  properties: {
                              width_ft: { type: "number" },
                              depth_ft: { type: "number" },
                              height_ft: { type: "number" },
                              wall_color: { type: "string", enum: WALL_COLORS },
                              counter_color: { type: "string", enum: ACCENT_COLORS },
                              island_color: { type: "string", enum: ACCENT_COLORS },
                              has_island: { type: "boolean" },
                              notes: { type: "string" },
                  },
                  required: ["width_ft", "depth_ft", "height_ft", "wall_color", "has_island", "notes"],
        },
};

export default async (req, context) => {
        if (req.method !== "POST") {
                  return jsonResponse(405, { error: "Method not allowed" });
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
                  // Lets the frontend fall back to the local keyword-matching demo instead of hard failing.
          return jsonResponse(503, { error: "AI is not configured on this deploy yet." });
        }

        let body;
        try {
                  body = await req.json();
        } catch {
                  return jsonResponse(400, { error: "Invalid request body." });
        }

        const text = (body.text || "").toString().slice(0, MAX_TEXT_LEN);
        const photoBase64 = body.photoBase64 ? String(body.photoBase64) : null;
        const photoMediaType = body.photoMediaType ? String(body.photoMediaType) : "image/jpeg";

        if (!text && !photoBase64) {
                  return jsonResponse(400, { error: "Describe the room or upload a photo first." });
        }
        if (photoBase64 && photoBase64.length > MAX_IMAGE_BASE64_BYTES) {
                  return jsonResponse(413, { error: "That photo is too large. Try a smaller image." });
        }
        if (photoBase64 && !/^image\/(jpeg|png|webp)$/.test(photoMediaType)) {
                  return jsonResponse(400, { error: "Photo must be a JPEG, PNG, or WebP image." });
        }

        // ---- Rate limiting (approximate; good enough for a public demo, not a billing-grade limiter) ----
        const store = getStore("ai-room-limits");
        const ip =
                  context.ip ||
                  req.headers.get("x-nf-client-connection-ip") ||
                  req.headers.get("x-forwarded-for") ||
                  "unknown";
        const now = new Date();
        const hourKey = `ip:${ip}:${now.toISOString().slice(0, 13)}`; // yyyy-mm-ddThh
        const dayKey = `global:${now.toISOString().slice(0, 10)}`; // yyyy-mm-dd

        const [ipCountRaw, globalCountRaw] = await Promise.all([store.get(hourKey), store.get(dayKey)]);
        const ipCount = parseInt(ipCountRaw || "0", 10);
        const globalCount = parseInt(globalCountRaw || "0", 10);

        if (ipCount >= PER_IP_HOURLY_LIMIT) {
                  return jsonResponse(429, {
                              error: `You've hit the demo limit (${PER_IP_HOURLY_LIMIT}/hour). Try again in a bit.`,
                  });
        }
        if (globalCount >= GLOBAL_DAILY_LIMIT) {
                  return jsonResponse(429, {
                              error: "The AI demo has reached its usage limit for today. Try again tomorrow.",
                  });
        }

        // ---- Build the Anthropic Messages API request ----
        let anthropicBody;
        if (photoBase64) {
                  const content = [
                        { type: "image", source: { type: "base64", media_type: photoMediaType, data: photoBase64 } },
                        {
                                      type: "text",
                                      text: text
                                        ? `Description: ${text}\n\nRespond with ONLY a single JSON object matching this shape, no other text: ${SCHEMA_DESCRIPTION}`
                                                      : `Respond with ONLY a single JSON object matching this shape, no other text: ${SCHEMA_DESCRIPTION}`,
                        },
                            ];
                  anthropicBody = {
                              model: MODEL,
                              max_tokens: 400,
                              system: SYSTEM_PROMPT,
                              messages: [{ role: "user", content }],
                  };
        } else {
                  anthropicBody = {
                              model: MODEL,
                              max_tokens: 400,
                              system: SYSTEM_PROMPT,
                              tools: [SET_ROOM_TOOL],
                              tool_choice: { type: "tool", name: "set_room" },
                              messages: [{ role: "user", content: text }],
                  };
        }

        let anthropicRes;
        try {
                  anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
                              method: "POST",
                              headers: {
                                            "content-type": "application/json",
                                            "x-api-key": apiKey,
                                            "anthropic-version": ANTHROPIC_VERSION,
                              },
                              body: JSON.stringify(anthropicBody),
                  });
        } catch (err) {
                  console.error("ai-room-claude: fetch to Anthropic failed", err);
                  return jsonResponse(502, { error: "Couldn't reach the AI service. Try again." });
        }

        if (!anthropicRes.ok) {
                  const errText = await anthropicRes.text();
                  console.error("ai-room-claude: Anthropic API error", anthropicRes.status, errText);
                  return jsonResponse(502, { error: "The AI service returned an error." });
        }

        const data = await anthropicRes.json();
        const blocks = Array.isArray(data.content) ? data.content : [];

        let raw = null;
        const toolUseBlock = blocks.find((b) => b.type === "tool_use");
        if (toolUseBlock && toolUseBlock.input) {
                  raw = toolUseBlock.input;
        } else {
                  const textBlock = blocks.find((b) => b.type === "text");
                  if (textBlock && textBlock.text) {
                              raw = extractJson(textBlock.text);
                  }
        }

        const result = sanitizeResult(raw);
        if (!result) {
                  return jsonResponse(502, { error: "Couldn't make sense of that input. Try rephrasing." });
        }

        // Best-effort counters — not atomic, fine for a soft usage cap on a demo feature.
        await Promise.all([
                  store.set(hourKey, String(ipCount + 1)),
                  store.set(dayKey, String(globalCount + 1)),
                ]);

        return jsonResponse(200, { result });
};

export const config = { path: "/api/ai-room" };
