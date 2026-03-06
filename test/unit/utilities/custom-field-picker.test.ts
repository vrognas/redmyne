import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  TimeEntryCustomFieldValue,
  CustomFieldDefinition,
} from "../../../src/redmine/models/custom-field-definition";

// Mock vscode before any imports that use it
vi.mock("vscode", () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
}));

describe("custom-field-picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("pickRequiredCustomFields", () => {
    it("returns empty values when no required fields", async () => {
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");
      const fields: CustomFieldDefinition[] = [
        { id: 1, name: "Optional", field_format: "string", is_required: false, customized_type: "time_entry" },
      ];

      const result = await pickRequiredCustomFields(fields);

      expect(result.cancelled).toBe(false);
      expect(result.values).toEqual([]);
    });

    it("prompts for list field with QuickPick", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        {
          id: 1,
          name: "Billing Code",
          field_format: "list",
          is_required: true,
          customized_type: "time_entry",
          possible_values: [
            { value: "internal", label: "Internal" },
            { value: "client", label: "Client" },
          ],
        },
      ];

      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Client",
        value: "client",
      } as unknown as ReturnType<typeof vscode.window.showQuickPick>);

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(result.cancelled).toBe(false);
      expect(result.values).toEqual([{ id: 1, value: "client" }]);
    });

    it("returns cancelled when user cancels list picker", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        {
          id: 1,
          name: "Billing Code",
          field_format: "list",
          is_required: true,
          customized_type: "time_entry",
          possible_values: [{ value: "internal" }],
        },
      ];

      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

      const result = await pickRequiredCustomFields(fields);

      expect(result.cancelled).toBe(true);
    });

    it("prompts for bool field with Yes/No picker", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 2, name: "Billable", field_format: "bool", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Yes",
        value: "1",
      } as unknown as ReturnType<typeof vscode.window.showQuickPick>);

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ label: "Yes", value: "1" }),
          expect.objectContaining({ label: "No", value: "0" }),
        ]),
        expect.anything()
      );
      expect(result.values).toEqual([{ id: 2, value: "1" }]);
    });

    it("prompts for string field with InputBox", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 3, name: "Task Code", field_format: "string", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("ABC-123");

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showInputBox).toHaveBeenCalled();
      expect(result.values).toEqual([{ id: 3, value: "ABC-123" }]);
    });

    it("prompts for int field with validation", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 4, name: "Units", field_format: "int", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("42");

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showInputBox).toHaveBeenCalled();
      expect(result.values).toEqual([{ id: 4, value: "42" }]);
    });

    it("prompts for float field with validation", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 5, name: "Rate", field_format: "float", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("1.5");

      const result = await pickRequiredCustomFields(fields);

      expect(result.values).toEqual([{ id: 5, value: "1.5" }]);
    });

    it("prompts for date field", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 6, name: "Invoice Date", field_format: "date", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("2026-02-04");

      const result = await pickRequiredCustomFields(fields);

      expect(result.values).toEqual([{ id: 6, value: "2026-02-04" }]);
    });

    it("handles multiple required fields in sequence", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 1, name: "Code", field_format: "string", is_required: true, customized_type: "time_entry" },
        { id: 2, name: "Billable", field_format: "bool", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("ABC");
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "No",
        value: "0",
      } as unknown as ReturnType<typeof vscode.window.showQuickPick>);

      const result = await pickRequiredCustomFields(fields);

      expect(result.values).toEqual([
        { id: 1, value: "ABC" },
        { id: 2, value: "0" },
      ]);
    });

    it("handles multi-select list field", async () => {
      const vscode = await import("vscode");
      const { pickRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        {
          id: 7,
          name: "Categories",
          field_format: "list",
          is_required: true,
          customized_type: "time_entry",
          multiple: true,
          possible_values: [
            { value: "dev" },
            { value: "test" },
            { value: "docs" },
          ],
        },
      ];

      vi.mocked(vscode.window.showQuickPick).mockResolvedValue([
        { label: "dev", value: "dev" },
        { label: "test", value: "test" },
      ] as unknown as ReturnType<typeof vscode.window.showQuickPick>);

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ canPickMany: true })
      );
      expect(result.values).toEqual([{ id: 7, value: ["dev", "test"] }]);
    });
  });

  describe("pickCustomFields", () => {
    it("shows all fields including optional", async () => {
      const vscode = await import("vscode");
      const { pickCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 1, name: "Required", field_format: "string", is_required: true, customized_type: "time_entry" },
        { id: 2, name: "Optional", field_format: "string", is_required: false, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce("Req Value")
        .mockResolvedValueOnce("Opt Value");

      const result = await pickCustomFields(fields);

      expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
      expect(result.values).toEqual([
        { id: 1, value: "Req Value" },
        { id: 2, value: "Opt Value" },
      ]);
    });

    it("uses existing values as defaults", async () => {
      const vscode = await import("vscode");
      const { pickCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 1, name: "Code", field_format: "string", is_required: true, customized_type: "time_entry" },
      ];
      const existing: TimeEntryCustomFieldValue[] = [{ id: 1, value: "OLD-123" }];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("NEW-456");

      await pickCustomFields(fields, existing);

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: "OLD-123" })
      );
    });

    it("joins existing multi-select array defaults", async () => {
      const vscode = await import("vscode");
      const { pickCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const fields: CustomFieldDefinition[] = [
        { id: 9, name: "Tags", field_format: "string", is_required: false, customized_type: "time_entry" },
      ];
      const existing: TimeEntryCustomFieldValue[] = [{ id: 9, value: ["one", "two"] }];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("one, two, three");

      await pickCustomFields(fields, existing);

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: "one, two" })
      );
    });

    it("marks bool defaults as picked for true and false", async () => {
      const vscode = await import("vscode");
      const { pickCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const field: CustomFieldDefinition = {
        id: 11,
        name: "Billable",
        field_format: "bool",
        is_required: false,
        customized_type: "time_entry",
      };

      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "Yes", value: "1" } as never);
      await pickCustomFields([field], [{ id: 11, value: "true" }]);
      const yesOptions = vi.mocked(vscode.window.showQuickPick).mock.calls[0]?.[0] as Array<{
        label: string;
        value: string;
        picked?: boolean;
      }>;
      expect(yesOptions[0].picked).toBe(true);

      vi.mocked(vscode.window.showQuickPick).mockClear();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "No", value: "0" } as never);
      await pickCustomFields([field], [{ id: 11, value: "false" }]);
      const noOptions = vi.mocked(vscode.window.showQuickPick).mock.calls[0]?.[0] as Array<{
        label: string;
        value: string;
        picked?: boolean;
      }>;
      expect(noOptions[1].picked).toBe(true);
    });

    it("validates numeric, date and string constraints", async () => {
      const vscode = await import("vscode");
      const { pickCustomFields } = await import("../../../src/utilities/custom-field-picker");

      vi.mocked(vscode.window.showInputBox).mockImplementation(async (options) => {
        if (!options) return undefined;
        const title = String(options.title ?? "");
        if (title.includes("Count")) {
          expect(options.validateInput?.("abc")).toBe("Must be an integer");
          expect(options.validateInput?.("42")).toBeNull();
          return "42";
        }
        if (title.includes("Ratio")) {
          expect(options.validateInput?.("bad")).toBe("Must be a number");
          expect(options.validateInput?.("3.14")).toBeNull();
          return "3.14";
        }
        if (title.includes("Due")) {
          expect(options.validateInput?.("2026/01/01")).toBe("Format: YYYY-MM-DD");
          expect(options.validateInput?.("2026-01-01")).toBeNull();
          return "2026-01-01";
        }
        if (title.includes("Code")) {
          expect(options.validateInput?.("")).toBe("Code is required");
          expect(options.validateInput?.("A")).toBe("Minimum 2 characters");
          expect(options.validateInput?.("ABCD")).toBe("Maximum 3 characters");
          expect(options.validateInput?.("AB!")).toBe("Must match pattern: ^[A-Z]+$");
          expect(options.validateInput?.("ABC")).toBeNull();
          return "ABC";
        }
        return undefined;
      });

      const result = await pickCustomFields([
        { id: 1, name: "Count", field_format: "int", is_required: true, customized_type: "time_entry" },
        { id: 2, name: "Ratio", field_format: "float", is_required: true, customized_type: "time_entry" },
        { id: 3, name: "Due", field_format: "date", is_required: true, customized_type: "time_entry" },
        {
          id: 4,
          name: "Code",
          field_format: "string",
          is_required: true,
          customized_type: "time_entry",
          min_length: 2,
          max_length: 3,
          regexp: "^[A-Z]+$",
        },
      ]);

      expect(result.cancelled).toBe(false);
      expect(result.values).toEqual([
        { id: 1, value: "42" },
        { id: 2, value: "3.14" },
        { id: 3, value: "2026-01-01" },
        { id: 4, value: "ABC" },
      ]);
    });
  });

  describe("promptForRequiredCustomFields", () => {
    it("returns prompted false when no required fields", async () => {
      const { promptForRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const result = await promptForRequiredCustomFields(async () => [
        { id: 20, name: "Optional", field_format: "text", is_required: false, customized_type: "time_entry" },
      ]);

      expect(result).toEqual({
        values: undefined,
        cancelled: false,
        prompted: false,
      });
    });

    it("returns cancelled true when picker cancels", async () => {
      const vscode = await import("vscode");
      const { promptForRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

      const result = await promptForRequiredCustomFields(async () => [
        { id: 21, name: "Req", field_format: "link", is_required: true, customized_type: "time_entry" },
      ]);

      expect(result).toEqual({
        values: undefined,
        cancelled: true,
        prompted: true,
      });
    });

    it("returns non-prompted fallback when api fetch throws", async () => {
      const { promptForRequiredCustomFields } = await import("../../../src/utilities/custom-field-picker");

      const result = await promptForRequiredCustomFields(async () => {
        throw new Error("forbidden");
      });

      expect(result).toEqual({
        values: undefined,
        cancelled: false,
        prompted: false,
      });
    });
  });
});
