import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_JSON_PATH = join(__dirname, "../../..", "package.json");

type MenuEntry = { command: string; when?: string; group?: string };

function getProjectsItemMenus(): MenuEntry[] {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  const entries: MenuEntry[] = pkg.contributes?.menus?.["view/item/context"] ?? [];
  return entries.filter((e) => e.when?.includes("redmyne-explorer-projects"));
}

// Extract the `viewItem =~ /regex/` literal from a when clause.
function viewItemRegex(when: string): RegExp {
  const m = when.match(/viewItem\s*=~\s*\/(.+?)\/([a-z]*)/);
  if (!m) throw new Error(`No viewItem regex in: ${when}`);
  return new RegExp(m[1], m[2]);
}

describe("issues pane inline menu when-clauses", () => {
  const menus = getProjectsItemMenus();

  it("hides Add to Kanban on closed issues", () => {
    const entries = menus.filter((e) => e.command === "redmyne.addIssueToKanban" && e.when?.includes("viewItem"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const re = viewItemRegex(entry.when!);
      expect(re.test("issue-active-root")).toBe(true);
      expect(re.test("issue-active-child")).toBe(true);
      expect(re.test("issue-completed-root")).toBe(false);
      expect(re.test("issue-completed-child")).toBe(false);
    }
  });
});
