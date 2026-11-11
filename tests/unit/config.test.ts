import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/schema.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    MATRIX_HOMESERVER: "https://matrix.example.org/",
    MATRIX_USER_ID: "@bot:example.org",
    MATRIX_DEVICE_ID: "BOTDEVICE",
    MATRIX_ACCESS_TOKEN: "matrix-secret",
    MATRIX_ADMIN_USER_IDS: "@admin:example.org,@second:example.org,@admin:example.org",
    MATRIX_CRYPTO_STORE_KEY: "ab".repeat(32),
    SUBSONIC_URL: "https://music.example.org/",
    SUBSONIC_USERNAME: "bot",
    SUBSONIC_PASSWORD: "subsonic-secret",
  };
}

describe("configuration", () => {
  it("applies secure defaults and normalizes values", () => {
    const config = parseConfig(validEnvironment());
    expect(config.MATRIX_HOMESERVER).toBe("https://matrix.example.org");
    expect(config.SUBSONIC_URL).toBe("https://music.example.org");
    expect(config.MATRIX_ADMIN_USER_IDS).toEqual(["@admin:example.org", "@second:example.org"]);
    expect(parseConfig({ ...validEnvironment(), MATRIX_ROOM_IDS: "!room:example.org" }).MATRIX_ROOM_IDS).toHaveLength(1);
    expect(config.MATRIX_REQUIRE_E2EE).toBe(true);
    expect(config.MATRIX_AUTO_ACCEPT_INVITES).toBe(true);
    expect(config.MAX_ACTIVE_CALLS).toBe(4);
    expect(config.LIVEKIT_AUDIO_BITRATE_KBPS).toBe(48);
    expect(config.DEFAULT_VOLUME_PERCENT).toBe(50);
    expect(config.ALONE_TIMEOUT_MS).toBe(60000);
    expect(config.PLAYBACK_IDLE_TIMEOUT_MS).toBe(600000);
    expect(path.isAbsolute(config.DATA_DIR)).toBe(true);
  });

  it("rejects plaintext mode and malformed crypto keys", () => {
    expect(() => parseConfig({ ...validEnvironment(), MATRIX_REQUIRE_E2EE: "false" })).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), MATRIX_CRYPTO_STORE_KEY: "short" })).toThrow();
    expect(parseConfig({ ...validEnvironment(), MATRIX_AUTO_ACCEPT_INVITES: "false" }).MATRIX_AUTO_ACCEPT_INVITES).toBe(false);
    expect(parseConfig({ ...validEnvironment(), MATRIX_AUTO_ACCEPT_INVITES: "yes" }).MATRIX_AUTO_ACCEPT_INVITES).toBe(true);
  });

  it("rejects invalid identifiers, URLs, and limits", () => {
    expect(() => parseConfig({ ...validEnvironment(), MATRIX_USER_ID: "bot" })).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), MATRIX_HOMESERVER: "ftp://matrix.example.org" })).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), SUBSONIC_URL: "https://user:secret@music.example.org" })).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), DEFAULT_VOLUME_PERCENT: "201" })).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), MAX_ACTIVE_CALLS: "0" })).toThrow();
    expect(parseConfig({ ...validEnvironment(), LIVEKIT_AUDIO_BITRATE_KBPS: "2000" }).LIVEKIT_AUDIO_BITRATE_KBPS).toBe(2000);
    expect(() => parseConfig({ ...validEnvironment(), LIVEKIT_AUDIO_BITRATE_KBPS: "2001" })).toThrow();
  });
});
