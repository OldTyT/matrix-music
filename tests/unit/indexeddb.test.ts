import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/schema.js";
import { DeviceState } from "../../src/matrix/device-state.js";
import { initializeIndexedDb } from "../../src/matrix/indexeddb.js";

describe("Node IndexedDB bootstrap", () => {
  it("uses a stable non-null origin and opens versioned databases", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "musicbot-indexeddb-"));
    try {
      const config = parseConfig({
        MATRIX_HOMESERVER: "https://matrix.example.org",
        MATRIX_USER_ID: "@bot:example.org",
        MATRIX_DEVICE_ID: "BOTDEVICE",
        MATRIX_ACCESS_TOKEN: "matrix-secret",
        MATRIX_ADMIN_USER_IDS: "@admin:example.org",
        MATRIX_CRYPTO_STORE_KEY: "ab".repeat(32),
        SUBSONIC_URL: "https://music.example.org",
        SUBSONIC_USERNAME: "bot",
        SUBSONIC_PASSWORD: "subsonic-secret",
        DATA_DIR: directory,
      });
      const state = new DeviceState(config);
      await initializeIndexedDb(config, state);
      expect(globalThis.location.origin).toBe(config.MATRIX_CRYPTO_ORIGIN);
      expect("window" in globalThis).toBe(false);

      const version = await new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("musicbot-shim-test", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const currentVersion = database.version;
          database.close();
          resolve(currentVersion);
        };
      });
      expect(version).toBe(1);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("musicbot-shim-test");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
