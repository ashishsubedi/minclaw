import dns from "node:dns/promises";

/**
 * Regex matching raw Google Cloud Code / Antigravity CLI retry headers, socket dumps, and stream abort warnings.
 * Examples:
 *   ⚠ API error (attempt 1): request failed: Post "...": read tcp ...: connection reset by peer
 *   ⚠ API error (attempt 2): request failed: Post "...": dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host
 *   ⚠ The stream was interrupted. Please continue the task you were working on.
 *   ⚠ There was a network issue connecting to the server, please try again.
 */
export const API_ERROR_REGEX =
  /⚠\s*(?:API error \(attempt \d+\):[\s\S]*?(?:connection reset by peer|no such host|no route to host|broken pipe|timed? ?out|EOF)|The stream was interrupted\.[^]*?working on\.|There was a network issue connecting to the server[^.]*\.?|API error \(attempt \d+\):[^\n]*)/gi;

/**
 * Checks if active network connectivity is available within a tight timeout (default 2500ms).
 * Tests via a fast HTTP HEAD probe to standard 204 connectivity endpoints, falling back to DNS resolution.
 * If running in test mode with MINCLAW_TEST_NETWORK_OFFLINE="1", returns false immediately.
 */
export async function isNetworkAvailable(timeoutMs = 2500): Promise<boolean> {
  if (process.env.MINCLAW_TEST_NETWORK_OFFLINE === "1") {
    return false;
  }

  try {
    const res = await fetch("https://connectivitycheck.gstatic.com/generate_204", {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204 || res.ok) {
      return true;
    }
  } catch {
    // Primary probe failed; fall through to secondary DNS check
  }

  try {
    const res = await dns.lookup("google.com");
    if (res?.address) {
      return true;
    }
  } catch {
    // DNS lookup failed
  }

  return false;
}

/**
 * Strips raw upstream API retry headers, broken socket warnings, and stream interruptions from agent text.
 * Leaves genuine user-facing markdown and text intact.
 */
export function cleanAgentResponse(text: string): string {
  if (!text) return "";
  return text
    .replace(API_ERROR_REGEX, "")
    .replace(/^\s*⚠\s*/gm, "")
    .trim();
}

/**
 * Determines whether the given text contains only raw API errors / network socket failure logs
 * with no substantive assistant output.
 */
export function isRawApiError(text: string): boolean {
  if (!text || !text.trim()) return true;
  const cleaned = cleanAgentResponse(text);
  return cleaned.length === 0;
}
