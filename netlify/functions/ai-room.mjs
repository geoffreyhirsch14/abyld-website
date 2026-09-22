import { getStore } from "@netlify/blobs";

// ---- Config (all overridable via Netlify environment variables) ----
// Groq's API is OpenAI-compatible: https://console.groq.com
const MODEL_TEXT = process.env.GROQ_MODEL_TEXT || "llama-3.3-70b-versatile";
const MODEL_VISION = process.env.GROQ_MODEL_VISION || "llama-3.2-11b-vision-preview";
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
// or stray commentary around it (vision models are less reliable about "JSON only" instructions).
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

export default async (req, context) => {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.GROQ_API_KEY;
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

  // ---- Build the Groq request (OpenAI-compatible chat completions API) ----
  let groqBody;
  if (photoBase64) {
    // Vision models on Groq don't reliably support function/tool calling alongside images,
  // so we ask for JSON directly and parse it defensively.
  const content = [
    {
      type: "text",
      text: `${SYSTEM_PROMPT} Respond with ONLY a single JSON object matching this shape, no other text: ${SCHEMA_DESCRIPTION}`,
    },
    { type: "image_url", image_url: { url: `data:${photoMediaType};base64,${photoBase64}` } },
    ];
    if (text) content.push({ type: "text", text: `Description: ${text}` });

  groqBody = {
    model: MODEL_VISION,
    max_tokens: 400,
    messages: [{ role: "user", content }],
  };
  } else {
    // Text-only: use tool calling on a text model for more reliable structured output.
  groqBody = {
    model: MODEL_TEXT,
    max_tokens: 400,
    tools: [
      {
        type: "function",
        function: {
          name: "set_room",
          description: "Set the 3D preview room's dimensions and colors.",
          parameters: {
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
        },
      },
      ],
    tool_choice: { type: "function", function: { name: "set_room" } },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
      ],
  };
  }

  let groqRes;
  try {
    groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(groqBody),
    });
  } catch (err) {
    console.error("ai-room: fetch to Groq failed", err);
    return jsonResponse(502, { error: "Couldn't reach the AI service. Try again." });
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    console.error("ai-room: Groq API error", groqRes.status, errText);
    return jsonResponse(502, { error: "The AI service returned an error." });
  }

  const data = await groqRes.json();
  const message = data.choices && data.choices[0] && data.choices[0].message;

  let raw = null;
  const toolCall = message && message.tool_calls && message.tool_calls[0];
  if (toolCall && toolCall.function && toolCall.function.arguments) {
    try {
      raw = JSON.parse(toolCall.function.arguments);
    } catch (err) {
      console.error("ai-room: failed to parse tool_call arguments", toolCall.function.arguments);
    }
  } else if (message && message.content) {
    raw = extractJson(message.content);
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
