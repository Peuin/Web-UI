/** Convert workflow error envelopes into a message for the person running the job. */
export function workflowErrorMessage(raw?: string): string {
  const fallback = "This folder could not be processed. Please try again or contact support if the problem continues.";
  if (!raw) return fallback;

  function describe(value: unknown, depth = 0): string {
    if (depth > 6 || value === null || value === undefined) return fallback;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return fallback;
      if (/^[{\[]/.test(text)) {
        try { return describe(JSON.parse(text), depth + 1); } catch { return fallback; }
      }
      if (/bad gateway|service unavailable|\b50[234]\b/i.test(text)) {
        return "The generation service is temporarily unavailable. Please try again shortly.";
      }
      if (/timed?\s*out|timeout/i.test(text)) return "The generation service took too long to respond. Please try again.";
      if (/rate.?limit|too many requests|\b429\b/i.test(text)) return "The generation service is receiving too many requests. Wait a moment before trying again.";
      if (/insufficient.*(credit|quota)|quota.*exceeded/i.test(text)) return "The generation service has reached its usage limit. Check the available quota before trying again.";
      if (/unauthorized|invalid.*(api.?key|credential)|\b401\b/i.test(text)) return "The generation service could not authenticate. Ask an administrator to check the connection.";
      if (/not found|\b404\b/i.test(text)) return "A required file or folder could not be found. Check that the source is still available.";
      // A machine code alone is not a useful explanation.
      if (/^[A-Za-z0-9_-]+$/.test(text)) return fallback;
      return text;
    }
    if (typeof value !== "object" || Array.isArray(value)) return fallback;
    const error = value as Record<string, unknown>;
    const cause = error.original_error ?? error.cause ?? error.error ?? error.message;
    const message = cause ? describe(cause, depth + 1) : fallback;
    if (error.node === "Generate Anchor Image") return `Could not generate the reference image. ${message}`;
    return message;
  }

  return describe(raw);
}
