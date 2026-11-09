import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/schema.js";
import type { SubsonicClient } from "../../src/subsonic/client.js";
import { applyVolume, PlaybackRoomSession } from "../../src/playback/room-session.js";
import type { RtcRoomCall } from "../../src/rtc/room-call.js";
import { createLogger } from "../../src/util/logger.js";

function config() {
  return parseConfig({
    MATRIX_HOMESERVER: "https://matrix.example.org",
    MATRIX_USER_ID: "@bot:example.org",
    MATRIX_DEVICE_ID: "BOTDEVICE",
    MATRIX_ACCESS_TOKEN: "matrix-secret",
    MATRIX_ADMIN_USER_IDS: "@admin:example.org",
    MATRIX_CRYPTO_STORE_KEY: "ab".repeat(32),
    SUBSONIC_URL: "https://music.example.org",
    SUBSONIC_USERNAME: "bot",
    SUBSONIC_PASSWORD: "subsonic-secret",
    MAX_QUEUE_SIZE: "2",
    LOG_LEVEL: "fatal",
  });
}

describe("playback queue", () => {
  it("applies volume gain dynamically and clamps PCM samples", () => {
    expect(applyVolume(Int16Array.from([1000, -1000, 20000]), 50)).toEqual(Int16Array.from([500, -500, 10000]));
    expect(applyVolume(Int16Array.from([20000, -20000, 1000]), 200)).toEqual(Int16Array.from([32767, -32768, 2000]));
    expect(applyVolume(Int16Array.from([1000, -1000]), 0)).toEqual(Int16Array.from([0, 0]));
  });

  it("enforces per-room queue limits and reports volume state", () => {
    const call = {
      roomId: "!room:example.org",
      isConnected: false,
      clearQueue: () => undefined,
    } as unknown as RtcRoomCall;
    const subsonic = { randomTracks: async () => [] } as unknown as SubsonicClient;
    const session = new PlaybackRoomSession(call, subsonic, config(), createLogger(config()));
    session.enqueue([
      { id: "1", title: "One", artist: "A", album: "B", durationSeconds: 1 },
      { id: "2", title: "Two", artist: "A", album: "B", durationSeconds: 1 },
    ]);
    expect(session.status()).toMatchObject({ queueLength: 2, volumePercent: 50, playing: false });
    expect(() => session.enqueue([{ id: "3", title: "Three", artist: "A", album: "B", durationSeconds: 1 }])).toThrow("Queue is full");
    session.setVolume(75);
    expect(session.getVolume()).toBe(75);
    expect(() => session.setVolume(201)).toThrow("Volume must be an integer from 0 to 200");
  });
});
