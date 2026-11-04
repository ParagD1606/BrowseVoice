import net from "node:net";
import { validateStartUrl } from "./crawler.mjs";

const SUSPICIOUS_HOST_TOKENS = /(?:login|verify|secure|account|wallet|payment|update|confirm|support|billing|signin)/i;

function addReason(reasons, severity, title, detail) {
  reasons.push({ severity, title, detail });
}

function header(response, name) {
  return response.headers.get(name) || "";
}

async function checkGoogleSafeBrowsing(url, config) {
  if (!config.googleSafeBrowsingKey) return null;
  const response = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(config.googleSafeBrowsingKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client: { clientId: "browsevoice", clientVersion: "1.0.0" },
      threatInfo: {
        threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: [{ url }],
      },
    }),
  });
  if (!response.ok) throw new Error(`Safe Browsing returned ${response.status}.`);
  const data = await response.json();
  return Array.isArray(data.matches) && data.matches.length > 0 ? data.matches : [];
}

async function fetchWithSafeRedirects(startUrl, config) {
  let currentUrl = startUrl.href;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": config.userAgent },
      });
    } finally {
      clearTimeout(timeout);
    }

    const location = response.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    if (!isRedirect || !location) return { response, url: currentUrl };
    if (redirectCount === 5) throw new Error("The site redirected too many times.");

    const nextUrl = new URL(location, currentUrl);
    validateStartUrl(nextUrl.href, { allowPrivateNetworks: config.allowPrivateNetworks });
    currentUrl = nextUrl.href;
  }
  throw new Error("The site redirected too many times.");
}

export async function checkSiteSafety(url, config) {
  let startUrl;
  try {
    startUrl = validateStartUrl(url, { allowPrivateNetworks: config.allowPrivateNetworks });
  } catch (error) {
    return {
      url: String(url || ""),
      finalUrl: null,
      verdict: "high-risk",
      score: 90,
      checkedAt: new Date().toISOString(),
      summary: "This URL could not be safely validated.",
      reasons: [{ severity: "high", title: "Invalid or unsupported URL", detail: error instanceof Error ? error.message : "Only public HTTP(S) URLs can be checked." }],
      checks: [],
    };
  }

  const reasons = [];
  const checks = [];
  let score = 0;
  const hostname = startUrl.hostname;
  const isIpAddress = net.isIP(hostname) !== 0;

  if (startUrl.protocol !== "https:") {
    score += 30;
    addReason(reasons, "high", "The site does not use HTTPS", "Information sent to this site may be readable or modified in transit.");
    checks.push({ id: "https", status: "fail", detail: "The starting URL uses HTTP." });
  } else {
    checks.push({ id: "https", status: "pass", detail: "The starting URL uses HTTPS." });
  }
  if (hostname.startsWith("xn--") || hostname.includes(".xn--")) {
    score += 25;
    addReason(reasons, "medium", "The hostname uses punycode", "Punycode can make look-alike internationalized domain names harder to recognize.");
    checks.push({ id: "hostname", status: "warn", detail: "Punycode hostname detected." });
  }
  if (isIpAddress) {
    score += 25;
    addReason(reasons, "medium", "The site uses an IP address instead of a domain", "Legitimate services usually use a recognizable domain name.");
    checks.push({ id: "hostname", status: "warn", detail: "IP address hostname detected." });
  }
  if (SUSPICIOUS_HOST_TOKENS.test(hostname)) {
    score += 10;
    addReason(reasons, "low", "The hostname contains a sensitive-action keyword", "This is not proof of fraud, but phishing sites often use words such as login, verify, secure, or payment.");
    checks.push({ id: "hostname-language", status: "warn", detail: "Sensitive-action keyword detected in hostname." });
  }
  if (hostname.split(".").length > 4) {
    score += 8;
    addReason(reasons, "low", "The hostname has many subdomains", "Deep subdomains can be legitimate, but they deserve extra verification.");
    checks.push({ id: "hostname-depth", status: "warn", detail: "More than three subdomain levels detected." });
  }

  let response;
  let fetchedUrl = startUrl.href;
  try {
    const fetched = await fetchWithSafeRedirects(startUrl, config);
    response = fetched.response;
    fetchedUrl = fetched.url;
  } catch (error) {
    addReason(reasons, "medium", "The site could not be reached", error instanceof Error ? error.message : "The request failed or timed out.");
    score += 20;
    return buildResult(startUrl.href, null, score, reasons, checks, "unknown", "The site could not be reached, so its safety could not be fully assessed.");
  }

  const finalUrl = new URL(response.url || fetchedUrl || startUrl.href);
  if (!response.ok) {
    score += 20;
    addReason(reasons, "medium", "The site returned an error response", `The server returned HTTP ${response.status}.`);
    checks.push({ id: "response", status: "warn", detail: `HTTP ${response.status}.` });
  } else {
    checks.push({ id: "response", status: "pass", detail: `HTTP ${response.status}.` });
  }
  if (finalUrl.origin !== startUrl.origin) {
    score += 25;
    addReason(reasons, "high", "The site redirected to a different domain", `${startUrl.origin} redirected to ${finalUrl.origin}. Verify that this change is expected before entering information.`);
    checks.push({ id: "redirect", status: "fail", detail: `Final origin: ${finalUrl.origin}.` });
  } else {
    checks.push({ id: "redirect", status: "pass", detail: "No cross-domain redirect detected." });
  }
  if (finalUrl.protocol !== "https:") {
    score += 20;
    addReason(reasons, "high", "The final page does not use HTTPS", "The page ended on an unencrypted connection.");
  }

  const securityHeaders = [
    ["strict-transport-security", "Strict-Transport-Security"],
    ["content-security-policy", "Content-Security-Policy"],
    ["x-content-type-options", "X-Content-Type-Options"],
    ["referrer-policy", "Referrer-Policy"],
  ];
  let presentHeaders = 0;
  for (const [id, name] of securityHeaders) {
    if (header(response, name)) {
      presentHeaders += 1;
      checks.push({ id, status: "pass", detail: `${name} is present.` });
    } else {
      checks.push({ id, status: "info", detail: `${name} is not present.` });
    }
  }
  if (presentHeaders === 0) addReason(reasons, "low", "No common browser security headers were detected", "Missing headers do not prove that a site is fake, but the site exposes fewer browser-level protections.");

  const html = await response.text().catch(() => "");
  const hasPasswordForm = /<input\b[^>]*type\s*=\s*["']?password/i.test(html);
  if (hasPasswordForm && finalUrl.origin !== startUrl.origin) {
    score += 30;
    addReason(reasons, "high", "A password form appears after a cross-domain redirect", "Do not enter credentials until you verify the final domain independently.");
  }
  const safeBrowsingMatches = await checkGoogleSafeBrowsing(startUrl.href, config).catch((error) => {
    addReason(reasons, "info", "Reputation check unavailable", error instanceof Error ? error.message : "The optional reputation provider could not be reached.");
    return null;
  });
  if (safeBrowsingMatches?.length) {
    score += 70;
    addReason(reasons, "high", "The optional reputation provider flagged this URL", "The site matches a known malware, phishing, or unwanted-software threat category.");
    checks.push({ id: "reputation", status: "fail", detail: "Threat match returned by Safe Browsing." });
  } else if (safeBrowsingMatches) {
    checks.push({ id: "reputation", status: "pass", detail: "No Safe Browsing threat match was returned." });
  } else {
    checks.push({ id: "reputation", status: "info", detail: "No reputation provider is configured." });
  }

  const verdict = score >= 60 ? "high-risk" : score >= 25 ? "caution" : "low-risk";
  const summary = verdict === "high-risk"
    ? "This site has significant risk signals. Avoid entering passwords, payment details, or personal information."
    : verdict === "caution"
      ? "This site has some caution signals. Verify the domain and be careful with personal information."
      : "No major risk signals were detected by the available checks. This is not proof that the site is legitimate.";
  return buildResult(startUrl.href, finalUrl.href, Math.min(score, 100), reasons, checks, verdict, summary);
}

function buildResult(url, finalUrl, score, reasons, checks, verdict, summary) {
  return { url, finalUrl, verdict, score: Math.min(Math.max(score, 0), 100), checkedAt: new Date().toISOString(), summary, reasons, checks };
}

