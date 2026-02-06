import * as vscode from "vscode";
import type {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "../redmine/redmine-server";
import { DraftModeServer } from "../draft-mode/draft-mode-server";
import { hashString } from "../draft-mode/draft-operation";
import type { DraftQueue } from "../draft-mode/draft-queue";
import type { DraftModeManager } from "../draft-mode/draft-mode-manager";
import type { ProjectsTree } from "../trees/projects-tree";
import type { MyTimeEntriesTreeDataProvider } from "../trees/my-time-entries-tree";

export interface ConfiguredContextUpdaterDeps {
  secretManager: {
    getApiKey: () => Promise<string | undefined>;
  };
  createServer: (options: RedmineServerConnectionOptions) => RedmineServer;
  draftQueue: DraftQueue;
  draftModeManager: DraftModeManager;
  projectsTree: ProjectsTree;
  timeEntriesTree: MyTimeEntriesTreeDataProvider;
  setDraftModeServer: (server: DraftModeServer) => void;
  setUserFte: (fte: number) => void;
  updateWorkloadStatusBar: () => void;
}

export function createConfiguredContextUpdater(
  deps: ConfiguredContextUpdaterDeps
): () => Promise<void> {
  return async () => {
    const config = vscode.workspace.getConfiguration("redmyne");
    const serverUrl = config.get<string>("serverUrl");
    const hasUrl = !!serverUrl;
    const apiKey = await deps.secretManager.getApiKey();
    const isConfigured = hasUrl && !!apiKey;

    // Set context in parallel with server init (no await needed).
    vscode.commands.executeCommand(
      "setContext",
      "redmyne:configured",
      isConfigured
    );

    // If configured, initialize server for trees.
    if (isConfigured) {
      try {
        const innerServer = deps.createServer({
          address: serverUrl!,
          key: apiKey!,
          additionalHeaders: config.get("additionalHeaders"),
        });

        // Wrap with draft mode server.
        const draftModeServer = new DraftModeServer(
          innerServer,
          deps.draftQueue,
          deps.draftModeManager
        );
        deps.setDraftModeServer(draftModeServer);
        const server = draftModeServer;

        // Load draft queue with server identity check (async, non-blocking).
        hashString(serverUrl! + apiKey!).then(async (serverIdentity) => {
          try {
            const conflict =
              await deps.draftQueue.checkServerConflict(serverIdentity);
            if (conflict) {
              const action = await vscode.window.showWarningMessage(
                `Server changed. ${conflict.count} draft${
                  conflict.count === 1 ? "" : "s"
                } from previous server will be discarded.`,
                { modal: true },
                "Discard Drafts",
                "Cancel"
              );
              if (action !== "Discard Drafts") {
                // User cancelled: do not load queue for this server.
                return;
              }
            }
            await deps.draftQueue.load(serverIdentity, { force: true });
          } catch {
            // Silent fail: draft queue loading is non-critical.
          }
        });

        deps.projectsTree.setServer(server as unknown as RedmineServer);
        deps.timeEntriesTree.setServer(server as unknown as RedmineServer);
        deps.projectsTree.refresh();
        deps.timeEntriesTree.refresh();

        // Fetch FTE from user's custom fields (non-critical, silent fail).
        server
          .getCurrentUser()
          .then((user) => {
            const fteField = user?.custom_fields?.find((field) =>
              field.name.toLowerCase().includes("fte")
            );
            if (fteField?.value) {
              const fte = parseFloat(fteField.value);
              if (!isNaN(fte) && fte > 0) {
                deps.setUserFte(fte);
                // Trigger workload recalc with new FTE.
                deps.updateWorkloadStatusBar();
              }
            }
          })
          .catch(() => {
            // FTE fetch is non-critical: continue without it.
          });
        // Status bar updates via projectsTree event listener.
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to initialize server: ${error}`);
      }
    } else {
      // Clear servers when not configured (don't refresh - let welcome view show).
      deps.projectsTree.setServer(undefined);
      deps.timeEntriesTree.setServer(undefined);
    }
  };
}
