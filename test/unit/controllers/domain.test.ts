import { describe, it, expect } from "vitest";
import {
  Membership,
  IssueStatus,
  QuickUpdate,
  QuickUpdateResult,
} from "../../../src/controllers/domain";

describe("Domain Models", () => {
  describe("Membership", () => {
    it("should create user membership", () => {
      const membership = new Membership(1, "John Doe", true);
      expect(membership.id).toBe(1);
      expect(membership.name).toBe("John Doe");
      expect(membership.isUser).toBe(true);
    });

    it("should create group membership", () => {
      const membership = new Membership(2, "Developers", false);
      expect(membership.id).toBe(2);
      expect(membership.name).toBe("Developers");
      expect(membership.isUser).toBe(false);
    });

    it("should default to user membership", () => {
      const membership = new Membership(1, "John Doe");
      expect(membership.isUser).toBe(true);
    });
  });

  describe("IssueStatus", () => {
    it("should create issue status", () => {
      const status = new IssueStatus(1, "New");
      expect(status.statusId).toBe(1);
      expect(status.name).toBe("New");
    });
  });

  describe("QuickUpdate", () => {
    it("should create quick update", () => {
      const assignee = new Membership(1, "John Doe");
      const status = new IssueStatus(2, "In Progress");
      const update = new QuickUpdate(123, "Test message", assignee, status);

      expect(update.issueId).toBe(123);
      expect(update.message).toBe("Test message");
      expect(update.assignee).toBe(assignee);
      expect(update.status).toBe(status);
    });
  });

  describe("QuickUpdateResult", () => {
    it("should start with no differences", () => {
      const result = new QuickUpdateResult();
      expect(result.isSuccessful()).toBe(true);
      expect(result.differences).toHaveLength(0);
    });

    it("should track differences", () => {
      const result = new QuickUpdateResult();
      result.addDifference("Couldn't assign user");
      result.addDifference("Couldn't update status");

      expect(result.isSuccessful()).toBe(false);
      expect(result.differences).toHaveLength(2);
      expect(result.differences[0]).toBe("Couldn't assign user");
    });
  });
});
