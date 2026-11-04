import fs from "node:fs/promises";
import path from "node:path";

function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) score += left[index] * right[index];
  return score;
}
export class JsonVectorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.recordsBySite = new Map();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      for (const [siteId, records] of Object.entries(parsed.recordsBySite || {})) {
        if (Array.isArray(records)) this.recordsBySite.set(siteId, records);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const serializable = { version: 1, recordsBySite: Object.fromEntries(this.recordsBySite) };
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(serializable), "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }

  async replaceSite(siteId, records) {
    this.recordsBySite.set(siteId, records);
    await this.save();
  }

  search(siteId, queryVector, limit) {
    return (this.recordsBySite.get(siteId) || [])
      .map((record) => ({ record, score: cosineSimilarity(queryVector, record.embedding) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .filter((item) => item.score > 0);
  }

  count(siteId) {
    return (this.recordsBySite.get(siteId) || []).length;
  }
}
