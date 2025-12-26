import { QuickPickItem } from "vscode";
import { NamedEntity } from "./models/common";

export interface RedmineProjectOptions {
  /**
   * Important: It is **not** project identifier defined upon project
   * creation, it is an **ID** of a project in the database.
   * @example 1
   */
  id: number;
  name: string;
  description: string;
  identifier: string;
  parent?: NamedEntity;
}

export interface ProjectQuickPickItem extends QuickPickItem {
  identifier: string;
  project: RedmineProject;
}

export class RedmineProject {
  constructor(private options: RedmineProjectOptions) {}

  get id() {
    return this.options.id;
  }

  get name() {
    return this.options.name;
  }

  get parent() {
    return this.options.parent;
  }

  get identifier() {
    return this.options.identifier;
  }

  toQuickPickItem(): ProjectQuickPickItem {
    return {
      label: this.options.name,
      description: (this.options.description || "")
        .split("\n")
        .join(" ")
        .split("\r")
        .join(""),
      detail: this.options.identifier,
      identifier: this.options.identifier,
      project: this,
    };
  }
}
