import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { RedmineProject } from "../../../src/redmine/redmine-project";
import {
  findProjectByIdAsLabeledId,
  mapNamedItemsToWizardPickItems,
  mapProjectsToWizardPickItems,
  requireNonEmptyStringOrShowError,
  requireValueOrShowError,
  validateOptionalIsoDate,
} from "../../../src/commands/quick-create-helpers";

describe("quick-create-helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps named items to labeled wizard picks", () => {
    const items = mapNamedItemsToWizardPickItems([
      { id: 1, name: "Bug" },
      { id: 2, name: "Feature" },
    ]);

    expect(items).toEqual([
      { label: "Bug", data: { label: "Bug", id: 1 } },
      { label: "Feature", data: { label: "Feature", id: 2 } },
    ]);
  });

  it("maps projects to wizard picks using project quick pick labels", () => {
    const projects = [
      new RedmineProject({
        id: 1,
        name: "Project Alpha",
        description: "Alpha description",
        identifier: "alpha",
      }),
    ];

    const items = mapProjectsToWizardPickItems(projects);

    expect(items).toEqual([
      {
        label: "Project Alpha",
        description: "Alpha description",
        data: { label: "Project Alpha", id: 1 },
      },
    ]);
  });

  it("finds project by id as labeled id", () => {
    const projects = [
      new RedmineProject({
        id: 1,
        name: "Project Alpha",
        description: "",
        identifier: "alpha",
      }),
      new RedmineProject({
        id: 2,
        name: "Project Beta",
        description: "",
        identifier: "beta",
      }),
    ];

    expect(findProjectByIdAsLabeledId(projects, 2)).toEqual({
      label: "Project Beta",
      id: 2,
    });
    expect(findProjectByIdAsLabeledId(projects, 999)).toBeUndefined();
  });

  it("validates optional ISO date input", () => {
    expect(validateOptionalIsoDate("")).toBeNull();
    expect(validateOptionalIsoDate("2026-01-31")).toBeNull();
    expect(validateOptionalIsoDate("2026-1-1")).toBe("Use YYYY-MM-DD format");
    expect(validateOptionalIsoDate("not-a-date")).toBe("Use YYYY-MM-DD format");
  });

  it("returns required values when present", () => {
    expect(requireValueOrShowError(123, "missing")).toBe(123);
    expect(requireNonEmptyStringOrShowError("hello", "missing")).toBe("hello");
  });

  it("shows error for missing required values", () => {
    expect(requireValueOrShowError(undefined, "missing value")).toBeUndefined();
    expect(requireNonEmptyStringOrShowError("   ", "missing text")).toBeUndefined();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("missing value");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("missing text");
  });
});
