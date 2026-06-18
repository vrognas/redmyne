/**
 * Strip trailing slashes from a Redmine base URL so callers can append a
 * leading-slash path (e.g. "/issues/123") without producing "//issues/123".
 * Centralizing this keeps every URL builder (Copy URL, open-in-browser, the
 * Gantt webview links, and the HTTP transport) consistent regardless of
 * whether the user configured `serverUrl` with a trailing slash.
 */
export function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
