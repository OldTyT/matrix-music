import { describe, expect, it } from "vitest";
import { sanitizeForLog, sanitizedError } from "../../src/util/sanitize.js";

describe("log sanitization", () => {
  it("recursively redacts secrets, key material, and URL queries", () => {
    const value = {
      nested: {
        accessToken: "matrix-secret",
        rawKey: Uint8Array.from([1, 2, 3]),
        url: "https://music.example.org/rest/stream.view?id=track&t=token&s=salt",
      },
      message: "matrix-secret and subsonic-secret",
    };

    const sanitized = sanitizeForLog(value, ["matrix-secret", "subsonic-secret"]);
    expect(sanitized.nested.accessToken).toBe("[Redacted]");
    expect(sanitized.nested.rawKey).toBe("[Redacted]");
    expect(sanitized.nested.url).not.toContain("t=token");
    expect(sanitized.nested.url).not.toContain("s=salt");
    expect(sanitized.message).toBe("[Redacted] and [Redacted]");
    expect(JSON.stringify(sanitized)).not.toContain("matrix-secret");
    expect(JSON.stringify(sanitized)).not.toContain("subsonic-secret");
  });

  it("sanitizes errors and circular structures", () => {
    const value: { self?: unknown; error?: Error } = {};
    value.self = value;
    value.error = new Error("request failed with access_token=secret");
    const sanitized = sanitizeForLog(value);
    expect(sanitized.self).toBe("[Circular]");
    expect(sanitized.error?.message).not.toContain("secret");
    expect(sanitizedError(new Error("password=secret"))).toBe("password=[Redacted]");
  });
});
