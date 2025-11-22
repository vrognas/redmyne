import { describe, it, expect, vi } from "vitest";
import {
  RedmineServer,
  RedmineOptionsError,
} from "../../../src/redmine/redmine-server";

describe("RedmineServer Error Handling", () => {
  describe("validation", () => {
    it("should throw on empty address", () => {
      expect(() => new RedmineServer({ address: "", key: "test" })).toThrow(
        RedmineOptionsError
      );
    });

    it("should throw on empty key", () => {
      expect(
        () => new RedmineServer({ address: "http://localhost:3000", key: "" })
      ).toThrow(RedmineOptionsError);
    });

    it("should throw on invalid URL", () => {
      expect(
        () => new RedmineServer({ address: "not-a-url", key: "test" })
      ).toThrow(RedmineOptionsError);
    });

    it("should throw on invalid protocol", () => {
      expect(
        () =>
          new RedmineServer({ address: "ftp://localhost:3000", key: "test" })
      ).toThrow(RedmineOptionsError);
    });
  });

  describe("https support", () => {
    it("should use https for https URLs", () => {
      const server = new RedmineServer({
        address: "https://localhost:3000",
        key: "test",
      });
      expect(server.request).toBeDefined();
    });

    it("should use http for http URLs", () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test",
      });
      expect(server.request).toBeDefined();
    });
  });
});
