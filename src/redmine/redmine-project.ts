import { QuickPickItem } from "vscode";
import { NamedEntity, CustomField } from "./models/common";

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
  custom_fields?: CustomField[];
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

  get description() {
    return this.options.description || "";
  }

  get customFields(): CustomField[] {
    return this.options.custom_fields ?? [];
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
