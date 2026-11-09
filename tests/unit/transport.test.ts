import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import type { Transport } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { parseConfig, type AppConfig } from "../../src/config/schema.js";
import { authorizeLivekit, livekitRoomAliasFor, selectLivekitTransport } from "../../src/rtc/transport.js";

function config(): AppConfig {
  return parseConfig({
    MATRIX_HOMESERVER: "https://matrix.example.org",
    MATRIX_USER_ID: "@bot:example.org",
    MATRIX_DEVICE_ID: "BOTDEVICE",
    MATRIX_ACCESS_TOKEN: "matrix-secret",
    MATRIX_ADMIN_USER_IDS: "@admin:example.org",
    MATRIX_CRYPTO_STORE_KEY: "ef".repeat(32),
    SUBSONIC_URL: "https://music.example.org",
    SUBSONIC_USERNAME: "bot",
    SUBSONIC_PASSWORD: "subsonic-secret",
  });
}

function jwt(identity: string, roomId = livekitRoomAliasFor("!room:example.org")): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ sub: identity, video: { room: roomId } })}.signature`;
}

function matrixClient(): MatrixClient {
  return {
    getOpenIdToken: vi.fn().mockResolvedValue({ access_token: "openid-secret" }),
    getUserId: vi.fn().mockReturnValue("@bot:example.org"),
    getDeviceId: vi.fn().mockReturnValue("BOTDEVICE"),
    _unstable_getLivekitToken: vi.fn(),
  } as unknown as MatrixClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LiveKit transport", () => {
  it("derives the MatrixRTC room/slot alias used by lk-jwt-service", () => {
    expect(livekitRoomAliasFor("!room:example.org")).toBe("TK4o8wNCXi5t5936bOvIzE/X3XFc7cgp3jGRDqK0j5E");
  });

  it("prefers legacy service authentication and preserves MatrixRTC identity", async () => {
    const selection = await selectLivekitTransport([
      { type: "livekit", url: "wss://sfu.example.org", server_name: "example.org" },
      { type: "livekit", livekit_service_url: "https://livekit-jwt.example.org" },
    ] as Transport[], config());
    expect(selection.backendIdentity).toBe("@bot:example.org:BOTDEVICE");
    expect(selection.memberId).toBe("@bot:example.org:BOTDEVICE");
    expect(selection.authentication).toBe("legacy-service");

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      url: "wss://sfu.example.org",
      jwt: jwt("@bot:example.org:BOTDEVICE"),
    })));
    vi.stubGlobal("fetch", fetchMock);
    const authorization = await authorizeLivekit(matrixClient(), selection, "!room:example.org", 1000);
    expect(authorization.backendIdentity).toBe("@bot:example.org:BOTDEVICE");
    expect(authorization.url).toBe("wss://sfu.example.org");
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://livekit-jwt.example.org/sfu/get");
    const body = JSON.parse(String((request?.[1] as RequestInit).body)) as { room: string; openid_token: { access_token: string }; device_id: string };
    expect(body.room).toBe("!room:example.org");
    expect(body.openid_token.access_token).toBe("openid-secret");
    expect(body.device_id).toBe("BOTDEVICE");
  });

  it("rejects a token issued for another participant identity", async () => {
    const selection = await selectLivekitTransport([
      { type: "livekit", livekit_service_url: "https://livekit-jwt.example.org" },
    ] as Transport[], config());
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      url: "wss://sfu.example.org",
      jwt: jwt("some-other-identity"),
    }))));
    await expect(authorizeLivekit(matrixClient(), selection, "!room:example.org", 1000)).rejects.toThrow("identity mismatch");
  });

  it("uses a UUID member ID and hashed backend identity for URL-only discovery", async () => {
    const selection = await selectLivekitTransport([
      { type: "livekit", url: "wss://sfu.example.org", server_name: "example.org" },
    ] as Transport[], config());
    expect(selection.memberId).toMatch(/^[0-9a-f-]{36}$/);
    expect(selection.backendIdentity).not.toContain("@bot:example.org");
    const client = matrixClient();
    vi.mocked(client._unstable_getLivekitToken).mockResolvedValue({ jwt: jwt(selection.backendIdentity) });
    const authorization = await authorizeLivekit(client, selection, "!room:example.org", 1000);
    expect(authorization.backendIdentity).toBe(selection.backendIdentity);
    expect(client._unstable_getLivekitToken).toHaveBeenCalledWith({
      url: "wss://sfu.example.org",
      room_id: "!room:example.org",
      slot_id: "m.call#ROOM",
      member_id: selection.memberId,
    });
  });

  it("rejects federated and m.livekit-only discovery", async () => {
    await expect(selectLivekitTransport([
      { type: "livekit", url: "wss://sfu.remote.org", server_name: "remote.org" },
    ] as Transport[], config())).rejects.toThrow("No local-homeserver");
    await expect(selectLivekitTransport([
      { type: "m.livekit", url: "wss://sfu.example.org" },
    ] as unknown as Transport[], config())).rejects.toThrow("incompatible");
  });
});
