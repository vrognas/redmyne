import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  pickRequiredCustomFields,
  pickCustomFields,
  TimeEntryCustomFieldValue,
  CustomFieldDefinition,
} from "../../../src/utilities/custom-field-picker";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
}));

describe("custom-field-picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("pickRequiredCustomFields", () => {
    it("returns empty values when no required fields", async () => {
      const fields: CustomFieldDefinition[] = [
        { id: 1, name: "Optional", field_format: "string", is_required: false, customized_type: "time_entry" },
      ];

      const result = await pickRequiredCustomFields(fields);

      expect(result.cancelled).toBe(false);
      expect(result.values).toEqual([]);
    });

    it("prompts for list field with QuickPick", async () => {
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
      } as unknown as vscode.QuickPickItem);

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(result.cancelled).toBe(false);
      expect(result.values).toEqual([{ id: 1, value: "client" }]);
    });

    it("returns cancelled when user cancels list picker", async () => {
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
      const fields: CustomFieldDefinition[] = [
        { id: 2, name: "Billable", field_format: "bool", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Yes",
        value: "1",
      } as unknown as vscode.QuickPickItem);

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
      const fields: CustomFieldDefinition[] = [
        { id: 3, name: "Task Code", field_format: "string", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("ABC-123");

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showInputBox).toHaveBeenCalled();
      expect(result.values).toEqual([{ id: 3, value: "ABC-123" }]);
    });

    it("prompts for int field with validation", async () => {
      const fields: CustomFieldDefinition[] = [
        { id: 4, name: "Units", field_format: "int", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("42");

      const result = await pickRequiredCustomFields(fields);

      expect(vscode.window.showInputBox).toHaveBeenCalled();
      expect(result.values).toEqual([{ id: 4, value: "42" }]);
    });

    it("prompts for float field with validation", async () => {
      const fields: CustomFieldDefinition[] = [
        { id: 5, name: "Rate", field_format: "float", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("1.5");

      const result = await pickRequiredCustomFields(fields);

      expect(result.values).toEqual([{ id: 5, value: "1.5" }]);
    });

    it("prompts for date field", async () => {
      const fields: CustomFieldDefinition[] = [
        { id: 6, name: "Invoice Date", field_format: "date", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("2026-02-04");

      const result = await pickRequiredCustomFields(fields);

      expect(result.values).toEqual([{ id: 6, value: "2026-02-04" }]);
    });

    it("handles multiple required fields in sequence", async () => {
      const fields: CustomFieldDefinition[] = [
        { id: 1, name: "Code", field_format: "string", is_required: true, customized_type: "time_entry" },
        { id: 2, name: "Billable", field_format: "bool", is_required: true, customized_type: "time_entry" },
      ];

      vi.mocked(vscode.window.showInputBox).mockResolvedValue("ABC");
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "No",
        value: "0",
      } as unknown as vscode.QuickPickItem);

      const result = await pickRequiredCustomFields(fields);

      expect(result.values).toEqual([
        { id: 1, value: "ABC" },
        { id: 2, value: "0" },
      ]);
    });

    it("handles multi-select list field", async () => {
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
      ] as unknown as vscode.QuickPickItem[]);

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
  });
});
