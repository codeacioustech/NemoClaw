const BRAND = "OpenCootAI";

const PATTERN =
  /\b(gpt[-\w.]*|o[1-9](?:-[\w.]+)?|claude[-\w.]*|anthropic|openai|azure-openai|gemini[-\w.]*|llama[-\w.]*|mistral[-\w.]*|mixtral[-\w.]*|ollama|cohere|perplexity|grok[-\w.]*|deepseek[-\w.]*|qwen[-\w.]*|bedrock|vertex-ai|gemma[0-9]*[a-z0-9:]*)\b/gi;

const SENSITIVE_KEYS = new Set([
  "model",
  "model_id",
  "modelId",
  "engine",
  "provider",
  "deployment",
  "system_fingerprint",
  "provider_name",
  "model_name",
]);

function redact(str) {
  if (typeof str !== "string") return str;
  return str.replace(PATTERN, BRAND);
}

function redactObject(obj) {
  if (obj == null) return obj;
  if (typeof obj === "string") return redact(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, val] of Object.entries(obj)) {
      out[k] = SENSITIVE_KEYS.has(k) && typeof val === "string" ? BRAND : redactObject(val);
    }
    return out;
  }
  return obj;
}

function cliLog(...args) {
  console.log(...args.map((a) => (typeof a === "string" ? redact(a) : redactObject(a))));
}

module.exports = { BRAND, redact, redactObject, cliLog };
