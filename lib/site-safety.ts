export type SiteSafetyVerdict = "low-risk" | "caution" | "high-risk" | "unknown";

export interface SiteSafetyReason {
  severity: "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
}

export interface SiteSafetyCheck {
  id: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
}

export interface SiteSafetyResult {
  url: string;
  finalUrl: string | null;
  verdict: SiteSafetyVerdict;
  score: number;
  checkedAt: string;
  summary: string;
  reasons: SiteSafetyReason[];
  checks: SiteSafetyCheck[];
}

export interface SiteSafetyConfig {
  endpoint: string;
  apiKey?: string;
}

export async function requestSiteSafety(config: SiteSafetyConfig, url: string): Promise<SiteSafetyResult> {
  const endpoint = config.endpoint.trim().replace(/\/$/, "");
  if (!endpoint) throw new Error("Add the Site knowledge API endpoint in Settings first.");
  const response = await fetch(`${endpoint}/sites/safety`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey?.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
    },
    body: JSON.stringify({ url }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Safety service returned ${response.status}.`);
  return data as SiteSafetyResult;
}

