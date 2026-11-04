/**
 * Redaction for provider URLs. QuickNode puts its token in the path (https://<name>.near-testnet.quiknode.pro/<token>/)
 * and neardata takes `?apiKey=`; either would leak a secret in a log line or an API response. Only scheme and host
 * are ever shown.
 */

/** scheme://host[:port]/… with path, query, fragment and user info dropped. Not a URL → "<invalid url>". */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const rest = u.pathname !== "/" || u.search || u.hash ? "/…" : "";
    return `${u.protocol}//${u.host}${rest}`;
  } catch {
    return "<invalid url>";
  }
}

/** Replace every occurrence of each secret in `text` with `***` (for error messages that may echo a URL). */
export function scrub(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 6) continue;
    out = out.split(s).join("***");
    try {
      const u = new URL(s);
      const tail = `${u.pathname}${u.search}`;
      if (tail.length > 6) out = out.split(tail).join("/***");
    } catch {
      // not a URL: the plain replacement above is enough
    }
  }
  return out;
}
