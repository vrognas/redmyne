import * as vscode from "vscode";
import type {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "../redmine/redmine-server";
import { DraftModeServer } from "../draft-mode/draft-mode-server";
import { hashString } from "../draft-mode/draft-operation";
import type { DraftQueue } from "../draft-mode/draft-queue";
import type { DraftModeManager } from "../draft-mode/draft-mode-manager";
import { prewarmIssuePicker } from "./issue-picker";
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

// Duck-typed: only LoggingRedmineServer exposes dispose() (clears its 30s
// cleanup setInterval); the base RedmineServer has none, so this is a no-op
// for plain servers.
function disposeServer(server: RedmineServer | undefined): void {
  const maybeDisposable = server as { dispose?: () => void } | undefined;
  if (typeof maybeDisposable?.dispose === "function") {
    maybeDisposable.dispose();
  }
}

export function createConfiguredContextUpdater(
  deps: ConfiguredContextUpdaterDeps
): () => Promise<void> {
  // Rapid reconfigurations (URL then key) each spawn an async draft-queue
  // load; without sequencing, a stale identity's load can win and drafts
  // recorded against the old server would flush to the new one.
  let generation = 0;
  // Track the previously created inner server so we can dispose it on the
  // next run. LoggingRedmineServer holds a 30s setInterval; without disposal
  // each reconfiguration (URL/key change, toggleApiLogging) leaks a timer and
  // pins the server's caches in memory.
  let previousInnerServer: RedmineServer | undefined;
  return async () => {
    const gen = ++generation;
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
          caFile: config.get<string>("caFile"),
        });

        // Dispose the prior inner server (e.g. LoggingRedmineServer's cleanup
        // timer) now that its replacement exists.
        disposeServer(previousInnerServer);
        previousInnerServer = innerServer;

        // Wrap with draft mode server.
        const draftModeServer = new DraftModeServer(
          innerServer,
          deps.draftQueue,
          deps.draftModeManager
        );
        deps.setDraftModeServer(draftModeServer);
        const server = draftModeServer;

        // Load draft queue with server identity check (async, non-blocking).
        void hashString(serverUrl! + apiKey!).then(async (serverIdentity) => {
          try {
            if (gen !== generation) return; // superseded by a newer config
            const conflict =
              await deps.draftQueue.checkServerConflict(serverIdentity);
            if (gen !== generation) return;
            if (conflict) {
              const action = await vscode.window.showWarningMessage(
                `Server changed. ${conflict.count} draft${
                  conflict.count === 1 ? "" : "s"
                } from previous server will be discarded.`,
                { modal: true },
                "Discard Drafts",
                "Cancel"
              );
              if (gen !== generation) return;
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

        deps.projectsTree.setServer(server);
        deps.timeEntriesTree.setServer(server);
        deps.projectsTree.refresh();
        deps.timeEntriesTree.refresh();

        // Pre-warm issue picker so it opens instantly
        prewarmIssuePicker(server);

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
      disposeServer(previousInnerServer);
      previousInnerServer = undefined;
      deps.projectsTree.setServer(undefined);
      deps.timeEntriesTree.setServer(undefined);
    }
  };
}
