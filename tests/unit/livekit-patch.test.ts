import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2EEManager, FrameCryptor } from "@livekit/rtc-node";

interface FfiRequest {
  message: {
    case: string;
    value: {
      message: {
        case: string;
        value: Record<string, unknown>;
      };
    };
  };
}

interface FfiClientModule {
  FfiClient: {
    instance: {
      request(request: unknown): unknown;
    };
  };
}

const require = createRequire(import.meta.url);
const ffiClientPath = path.join(path.dirname(require.resolve("@livekit/rtc-node")), "ffi_client.cjs");
const { FfiClient } = require(ffiClientPath) as FfiClientModule;

function lastRequest(spy: ReturnType<typeof vi.spyOn>): FfiRequest {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error("Expected an FFI request");
  return call[0] as FfiRequest;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LiveKit E2EE patch", () => {
  it("passes raw key bytes, participant identity, and key index to FFI", () => {
    const spy = vi.spyOn(FfiClient.instance, "request").mockReturnValue(undefined);
    const manager = new E2EEManager(42n, { keyProviderOptions: {} });
    const provider = manager.getKeyProvider();
    const rawKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

    expect(manager.getKeyProvider()).toBe(provider);
    provider.setKey("@bot:example.org:BOTDEVICE", 7, rawKey);

    const request = lastRequest(spy);
    expect(request.message.case).toBe("e2ee");
    expect(request.message.value.message.case).toBe("setKey");
    expect(request.message.value.message.value).toMatchObject({
      participantIdentity: "@bot:example.org:BOTDEVICE",
      keyIndex: 7,
      key: rawKey,
    });
  });

  it("preserves track SID in enabled and key-index requests", () => {
    const spy = vi.spyOn(FfiClient.instance, "request").mockReturnValue(undefined);
    const cryptor = new FrameCryptor(42n, "@bot:example.org:BOTDEVICE", "TR_audio", 2, true);

    cryptor.setEnabled(false);
    expect(lastRequest(spy).message.value.message.value).toMatchObject({
      participantIdentity: "@bot:example.org:BOTDEVICE",
      trackSid: "TR_audio",
      enabled: false,
    });

    cryptor.setKeyIndex(9);
    expect(lastRequest(spy).message.value.message.value).toMatchObject({
      participantIdentity: "@bot:example.org:BOTDEVICE",
      trackSid: "TR_audio",
      keyIndex: 9,
    });
  });

  it("retains track SID when materializing frame cryptors", () => {
    const response = {
      message: {
        value: {
          frameCryptors: [
            { participantIdentity: "@bot:example.org:BOTDEVICE", trackSid: "TR_audio", keyIndex: 4, enabled: true },
          ],
        },
      },
    };
    vi.spyOn(FfiClient.instance, "request").mockReturnValue(response);
    const manager = new E2EEManager(42n, { keyProviderOptions: {} });

    const cryptors = manager.frameCryptors();
    expect(cryptors).toHaveLength(1);
    expect(cryptors[0]?.trackSid).toBe("TR_audio");
    expect(cryptors[0]?.participantIdentity).toBe("@bot:example.org:BOTDEVICE");
    expect(cryptors[0]?.keyIndex).toBe(4);
  });
});
