import { WorkspaceConfiguration } from "vscode";

export interface RedmineConfig extends WorkspaceConfiguration {
  /**
   * HTTPS URL of Redmine server. HTTP is not allowed.
   * @example https://example.com
   * @example https://example.com:8443/redmine
   */
  serverUrl: string;
  /**
   * Default project identifier for "New Issue" command (hidden setting)
   */
  defaultProject?: string;
  /**
   * Additional headers
   */
  additionalHeaders?: { [key: string]: string };
}
