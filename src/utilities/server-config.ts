import * as vscode from "vscode";
import type { RedmineServerConnectionOptions } from "../redmine/redmine-server-interface";

/**
 * Build connection options from the redmyne.* settings. Single owner of the
 * address/key/additionalHeaders/caFile read shared by the two server-construction
 * sites (configured-command-registrar, configured-context-updater). The
 * extension.ts createServer factory layers logging + maxConcurrentRequests on top.
 */
export function buildServerOptionsFromConfig(
  url: string,
  apiKey: string
): RedmineServerConnectionOptions {
  const config = vscode.workspace.getConfiguration("redmyne");
  return {
    address: url,
    key: apiKey,
    additionalHeaders: config.get("additionalHeaders"),
    caFile: config.get<string>("caFile"),
  };
}
