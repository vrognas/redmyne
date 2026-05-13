import * as crypto from "crypto";

/**
 * Generate a cryptographic nonce for the webview Content-Security-Policy
 * `script-src 'nonce-…'` directive. Must come from a CSPRNG (not Math.random).
 */
export function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}
