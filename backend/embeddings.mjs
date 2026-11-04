import crypto from "node:crypto";

export function tokenize(text) {
  return String(text || "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}
function hashToIndex(value, dimensions) {
  const digest = crypto.createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0) % dimensions;
}

function normalize(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
}

/**
 * Small dependency-free embedding used for local development and offline use.
 * It uses signed feature hashing over words and character trigrams, so the
 * persisted index is genuinely searchable by cosine similarity without a key.
 */
export function createLocalEmbedding(text, dimensions = 384) {
  const vector = new Array(dimensions).fill(0);
  const words = tokenize(text);
  for (const word of words) {
    const index = hashToIndex(`word:${word}`, dimensions);
    vector[index] += 1;
    if (word.length > 3) {
      for (let offset = 0; offset <= word.length - 3; offset += 1) {
        const trigram = word.slice(offset, offset + 3);
        const trigramIndex = hashToIndex(`tri:${trigram}`, dimensions);
        vector[trigramIndex] += 0.25;
      }
    }
  }
  return normalize(vector);
}

async function embedWithOpenAICompatible(config, texts) {
  if (!config.embeddingApiKey) throw new Error("SITE_CHAT_EMBEDDING_API_KEY is required for remote embeddings.");
  if (!config.embeddingModel) throw new Error("SITE_CHAT_EMBEDDING_MODEL is required for remote embeddings.");
  const endpoint = config.embeddingEndpoint.replace(/\/$/, "");
  const response = await fetch(`${endpoint}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({ model: config.embeddingModel, input: texts }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Embedding service returned ${response.status}.`);
  if (!Array.isArray(data.data)) throw new Error("Embedding service returned no vectors.");
  return data.data
    .sort((left, right) => (left.index || 0) - (right.index || 0))
    .map((item) => item.embedding)
    .filter((embedding) => Array.isArray(embedding));
}

export async function embedTexts(config, texts) {
  if (config.embeddingProvider === "openai-compatible") return embedWithOpenAICompatible(config, texts);
  return texts.map((text) => createLocalEmbedding(text, config.embeddingDimensions));
}
