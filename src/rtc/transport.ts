import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { MatrixClient } from "matrix-js-sdk";
import {
  isUnstableLivekitTransport,
  type Transport,
  type UnstableLivekitTransport,
} from "matrix-js-sdk/lib/matrixrtc/index.js";
import { computeRtcIdentityRaw } from "matrix-js-sdk/lib/matrixrtc/membershipData/rtc.js";
import type { AppConfig } from "../config/schema.js";
import { withTimeout } from "../util/time.js";

const tokenResponseSchema = z.object({ url: z.string().url(), jwt: z.string().min(1) }).loose();
const jwtPayloadSchema = z.object({
  sub: z.string(),
  video: z.object({ room: z.string().optional() }).loose().optional(),
}).loose();

export interface LivekitTransportSelection {
  transport: UnstableLivekitTransport;
  memberId: string;
  backendIdentity: string;
  authentication: "legacy-service" | "url-only";
}

export interface LivekitAuthorization {
  url: string;
  jwt: string;
  backendIdentity: string;
}

function localServerName(config: AppConfig): string {
  const separator = config.MATRIX_USER_ID.indexOf(":");
  return config.MATRIX_USER_ID.slice(separator + 1);
}

export async function selectLivekitTransport(transports: Transport[], config: AppConfig): Promise<LivekitTransportSelection> {
  const localTransports = transports.filter(isUnstableLivekitTransport).filter((transport) => {
    return !("server_name" in transport) || transport.server_name === undefined || transport.server_name === localServerName(config);
  });
  if (localTransports.length === 0) {
    const onlyModernType = transports.some((transport) => typeof transport === "object" && transport !== null && "type" in transport && transport.type === "m.livekit");
    throw new Error(onlyModernType ? "Only m.livekit discovery was returned; this backend is incompatible with per-participant MatrixRTC media keys" : "No local-homeserver LiveKit transport is available");
  }
  const transport = localTransports.find((candidate) => "livekit_service_url" in candidate) ?? localTransports[0];
  if (!transport) throw new Error("No compatible LiveKit transport is available");

  if ("livekit_service_url" in transport) {
    return {
      transport,
      memberId: `${config.MATRIX_USER_ID}:${config.MATRIX_DEVICE_ID}`,
      backendIdentity: `${config.MATRIX_USER_ID}:${config.MATRIX_DEVICE_ID}`,
      authentication: "legacy-service",
    };
  }
  if (config.MATRIX_RTC_MEMBERSHIP_MODE !== "sticky") {
    throw new Error("URL-only LiveKit discovery requires sticky MatrixRTC membership; legacy membership is incompatible");
  }
  const memberId = randomUUID();
  return {
    transport,
    memberId,
    backendIdentity: await computeRtcIdentityRaw(config.MATRIX_USER_ID, memberId),
    authentication: "url-only",
  };
}

function decodeJwt(jwt: string): z.output<typeof jwtPayloadSchema> {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) throw new Error("LiveKit returned a malformed JWT");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("LiveKit returned a malformed JWT payload");
  }
  return jwtPayloadSchema.parse(payload);
}

export function livekitRoomAliasFor(roomId: string): string {
  return createHash("sha256").update(JSON.stringify([roomId, "m.call#ROOM"])).digest("base64").replace(/=+$/, "");
}

function assertAuthorization(authorization: LivekitAuthorization, roomId: string): LivekitAuthorization {
  const url = new URL(authorization.url);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("LiveKit returned a non-WebSocket SFU URL");
  const payload = decodeJwt(authorization.jwt);
  if (payload.sub !== authorization.backendIdentity) {
    throw new Error(`LiveKit participant identity mismatch: expected MatrixRTC backendIdentity ${authorization.backendIdentity}, received ${payload.sub}`);
  }
  const expectedRoomAlias = livekitRoomAliasFor(roomId);
  if (payload.video?.room !== undefined && payload.video.room !== expectedRoomAlias) {
    throw new Error(`LiveKit token was issued for a different MatrixRTC room/slot: expected ${expectedRoomAlias}, received ${payload.video.room}`);
  }
  return authorization;
}

async function legacyAuthorization(client: MatrixClient, selection: LivekitTransportSelection, roomId: string, timeoutMs: number, fetchFn: typeof globalThis.fetch, receiverDeviceId?: string): Promise<LivekitAuthorization> {
  if (!("livekit_service_url" in selection.transport)) throw new Error("Selected transport has no LiveKit JWT service");
  const openid = await client.getOpenIdToken();
  const endpoint = `${selection.transport.livekit_service_url.replace(/\/+$/, "")}/sfu/get`;
  const deviceId = receiverDeviceId ?? client.getDeviceId();
  const backendIdentity = `${client.getUserId()}:${deviceId}`;
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ room: roomId, openid_token: openid, device_id: deviceId }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`LiveKit authorization request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`LiveKit authorization service returned HTTP ${response.status}`);
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("LiveKit authorization service returned an invalid response");
  return { ...parsed.data, backendIdentity };
}

export async function authorizeLivekit(client: MatrixClient, selection: LivekitTransportSelection, roomId: string, timeoutMs: number, fetchFn: typeof globalThis.fetch = globalThis.fetch, receiverDeviceId?: string): Promise<LivekitAuthorization> {
  let authorization: LivekitAuthorization;
  if (selection.authentication === "legacy-service") {
    authorization = await legacyAuthorization(client, selection, roomId, timeoutMs, fetchFn, receiverDeviceId);
  } else {
    if (receiverDeviceId) throw new Error("Loopback receiver tokens are supported only with legacy LiveKit JWT service discovery");
    if (!("url" in selection.transport)) throw new Error("Selected transport has no LiveKit SFU URL");
    const response = await withTimeout(
      client._unstable_getLivekitToken({
        url: selection.transport.url,
        room_id: roomId,
        slot_id: "m.call#ROOM",
        member_id: selection.memberId,
      }),
      timeoutMs,
      "LiveKit token request",
    );
    authorization = { url: selection.transport.url, jwt: response.jwt, backendIdentity: selection.backendIdentity };
  }
  return assertAuthorization(authorization, roomId);
}
