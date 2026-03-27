import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { RedmineConfig } from "../definitions/redmine-config";

export interface ActionProperties {
  server: IRedmineServer;
  config: RedmineConfig;
}
