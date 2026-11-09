import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, type AppConfig } from "../../src/config/schema.js";
import { RoomAllowlist } from "../../src/matrix/allowlist.js";
import { DeviceState } from "../../src/matrix/device-state.js";

const temporaryDirectories: string[] = [];

async function configuration(): Promise<AppConfig> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "musicbot-state-"));
  temporaryDirectories.push(directory);
  return parseConfig({
    MATRIX_HOMESERVER: "https://matrix.example.org",
    MATRIX_USER_ID: "@bot:example.org",
    MATRIX_DEVICE_ID: "BOTDEVICE",
    MATRIX_ACCESS_TOKEN: "matrix-secret",
    MATRIX_ADMIN_USER_IDS: "@admin:example.org",
    MATRIX_CRYPTO_STORE_KEY: "cd".repeat(32),
    SUBSONIC_URL: "https://music.example.org",
    SUBSONIC_USERNAME: "bot",
    SUBSONIC_PASSWORD: "subsonic-secret",
    DATA_DIR: directory,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("durable state", () => {
  it("persists room authorization without persisting queues", async () => {
    const config = await configuration();
    const allowlist = new RoomAllowlist(config);
    await allowlist.load();
    await allowlist.authorize("!room:example.org");

    const restored = new RoomAllowlist(config);
    await restored.load();
    expect(restored.isAuthorized("!room:example.org")).toBe(true);
    const persisted = JSON.parse(await fs.readFile(path.join(config.DATA_DIR, "authorized-rooms.json"), "utf8")) as Record<string, unknown>;
    expect(persisted).toEqual({ version: 1, roomIds: ["!room:example.org"] });
  });

  it("allows only one process per crypto directory", async () => {
    const config = await configuration();
    const first = new DeviceState(config);
    const second = new DeviceState(config);
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow();
    await first.close();
    await second.acquire();
    await second.close();
  });

  it("rejects changed persisted device metadata", async () => {
    const config = await configuration();
    const first = new DeviceState(config);
    await first.acquire();
    await first.close();

    const changed = new DeviceState({ ...config, MATRIX_DEVICE_ID: "OTHERDEVICE" });
    await expect(changed.acquire()).rejects.toThrow("does not match");
    await changed.close();
  });
});
