import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "../../../src/utilities/api-logger";

describe("redactSensitiveData", () => {
  describe("JSON redaction", () => {
    it("redacts password field", () => {
      const input = JSON.stringify({ user: { password: "secret123" } });
      const result = redactSensitiveData(input);
      const parsed = JSON.parse(result);

      expect(parsed.user.password).toBe("***");
    });

    it("redacts api_key field", () => {
      const input = JSON.stringify({ api_key: "abc123xyz" });
      const result = redactSensitiveData(input);
      const parsed = JSON.parse(result);

      expect(parsed.api_key).toBe("***");
    });

    it("redacts token field", () => {
      const input = JSON.stringify({ token: "bearer-token-123" });
      const result = redactSensitiveData(input);
      const parsed = JSON.parse(result);

      expect(parsed.token).toBe("***");
    });

    it("redacts nested sensitive fields", () => {
      const input = JSON.stringify({
        user: {
          name: "admin",
          password: "secret",
          settings: {
            api_key: "key123"
          }
        }
      });
      const result = redactSensitiveData(input);
      const parsed = JSON.parse(result);

      expect(parsed.user.name).toBe("admin");
      expect(parsed.user.password).toBe("***");
      expect(parsed.user.settings.api_key).toBe("***");
    });

    it("redacts fields in arrays", () => {
      const input = JSON.stringify({
        users: [
          { name: "user1", password: "pass1" },
          { name: "user2", password: "pass2" }
        ]
      });
      const result = redactSensitiveData(input);
      const parsed = JSON.parse(result);

      expect(parsed.users[0].password).toBe("***");
      expect(parsed.users[1].password).toBe("***");
      expect(parsed.users[0].name).toBe("user1");
    });

    it("preserves non-sensitive fields", () => {
      const input = JSON.stringify({
        user: { login: "admin", email: "admin@example.com" }
      });
      const result = redactSensitiveData(input);
      const parsed = JSON.parse(result);

      expect(parsed.user.login).toBe("admin");
      expect(parsed.user.email).toBe("admin@example.com");
    });
  });

  describe("Plain text redaction", () => {
    it("redacts password in URL-encoded format", () => {
      const input = "username=admin&password=secret123&email=test@example.com";
      const result = redactSensitiveData(input);

      expect(result).toContain("password=***");
      expect(result).not.toContain("secret123");
      expect(result).toContain("username=admin");
    });

    it("redacts api_key in URL-encoded format", () => {
      const input = "api_key=abc123xyz&user_id=42";
      const result = redactSensitiveData(input);

      expect(result).toContain("api_key=***");
      expect(result).not.toContain("abc123xyz");
      expect(result).toContain("user_id=42");
    });

    it("redacts token in colon-separated format", () => {
      const input = "access_token: abc123\nContent-Type: application/json";
      const result = redactSensitiveData(input);

      expect(result).toContain("access_token: ***");
      expect(result).not.toContain("abc123");
    });

    it("redacts multiple sensitive fields", () => {
      const input = "password=pass123&api_key=key456&username=admin";
      const result = redactSensitiveData(input);

      expect(result).toContain("password=***");
      expect(result).toContain("api_key=***");
      expect(result).not.toContain("pass123");
      expect(result).not.toContain("key456");
      expect(result).toContain("username=admin");
    });

    it("is case insensitive", () => {
      const input = "PASSWORD=secret&Api_Key=key123";
      const result = redactSensitiveData(input);

      expect(result).toContain("PASSWORD=***");
      expect(result).toContain("Api_Key=***");
      expect(result).not.toContain("secret");
      expect(result).not.toContain("key123");
    });

    it("redacts secret field", () => {
      const input = "client_id=123&client_secret=xyz789";
      const result = redactSensitiveData(input);

      expect(result).toContain("client_secret=***");
      expect(result).not.toContain("xyz789");
      expect(result).toContain("client_id=123");
    });
  });

  describe("Edge cases", () => {
    it("handles empty string", () => {
      const result = redactSensitiveData("");
      expect(result).toBe("");
    });

    it("handles string with no sensitive data", () => {
      const input = "username=admin&email=test@example.com";
      const result = redactSensitiveData(input);
      expect(result).toBe(input);
    });

    it("handles malformed JSON", () => {
      const input = "{invalid json";
      const result = redactSensitiveData(input);
      expect(result).toBe(input);
    });

    it("handles null values in JSON", () => {
      const input = JSON.stringify({ password: null, api_key: undefined });
      const result = redactSensitiveData(input);
      const parsed = JSON.parse(result);

      expect(parsed.password).toBe("***");
      expect(parsed.api_key).toBeUndefined();
    });

    it("handles mixed JSON-like text", () => {
      const input = '{"password":"leaked"} password=secret123';
      const result = redactSensitiveData(input);

      expect(result).toContain("password=***");
      expect(result).not.toContain("secret123");
    });
  });
});
