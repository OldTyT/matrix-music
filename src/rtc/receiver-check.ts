import { AudioStream, Room, RoomEvent, type KeyProvider, type RemoteTrack, type RemoteTrackPublication } from "@livekit/rtc-node";
import { EncryptionType, KeyDerivationFunction, TrackKind } from "@livekit/rtc-ffi-bindings";
import { KnownMembership } from "matrix-js-sdk";
import { MatrixRTCSessionEvent, type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import type { CallMembershipIdentityParts } from "matrix-js-sdk/lib/matrixrtc/EncryptionManager.js";
import type { AppConfig } from "../config/schema.js";
import type { MatrixRuntime } from "../matrix/runtime.js";
import type { AppLogger } from "../util/logger.js";
import { delay, withTimeout } from "../util/time.js";
import { authorizeLivekit, selectLivekitTransport, type LivekitTransportSelection } from "./transport.js";

interface ReceivedMediaKey {
  rawKey: Uint8Array;
  keyIndex: number;
}

export interface MatrixReceiverAudioStats {
  frames: number;
  nonzeroSamples: number;
  encryptionErrors: number;
  publisherIdentity: string;
}

export async function runMatrixReceiverCheck(
  runtime: MatrixRuntime,
  config: AppConfig,
  logger: AppLogger,
  roomId: string,
  publisherDeviceId: string,
): Promise<MatrixReceiverAudioStats> {
  const room = await runtime.requireEncryptedAuthorizedRoom(roomId);
  if (room.getMember(config.MATRIX_USER_ID)?.membership !== KnownMembership.Join) {
    throw new Error("Receiver device is not joined to the Matrix room");
  }
  const session = runtime.matrixClient.matrixRTC.getRoomSession(room);
  await session.initialMembershipCalculated;
  await session.ensureRecalculateSessionMembers();

  const publisherIdentity = `${config.MATRIX_USER_ID}:${publisherDeviceId}`;
  const publisherDeadline = Date.now() + 30000;
  while (!session.memberships.some((membership) => {
    return membership.userId === config.MATRIX_USER_ID && membership.deviceId === publisherDeviceId;
  })) {
    if (Date.now() >= publisherDeadline) throw new Error(`Publisher device ${publisherDeviceId} is not active in MatrixRTC`);
    await session.ensureRecalculateSessionMembers();
    await delay(250);
  }

  const selection = await selectLivekitTransport(await runtime.discoverTransports(), config);
  const receivedKeys = new Map<string, ReceivedMediaKey>();
  let keyProvider: KeyProvider | undefined;
  let encryptionErrors = 0;

  const onEncryptionKeyChanged = (
    rawKey: Uint8Array,
    keyIndex: number,
    membership: CallMembershipIdentityParts,
    backendIdentity: string,
  ): void => {
    if (membership.userId === config.MATRIX_USER_ID && membership.deviceId === config.MATRIX_DEVICE_ID) return;
    receivedKeys.set(backendIdentity, { rawKey, keyIndex });
    keyProvider?.setKey(backendIdentity, keyIndex, rawKey);
  };
  session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, onEncryptionKeyChanged);

  const livekitRoom = new Room();
  let audioPromise: Promise<MatrixReceiverAudioStats> | undefined;

  const consumeTrack = (track: RemoteTrack): Promise<MatrixReceiverAudioStats> => {
    return new Promise((resolve, reject) => {
      const stream = new AudioStream(track, 48000, 2);
      const reader = stream.getReader();
      let frames = 0;
      let nonzeroSamples = 0;
      void (async () => {
        try {
          while (true) {
            const { done, value: frame } = await reader.read();
            if (done) break;
            frames += 1;
            nonzeroSamples += frame.data.reduce((count: number, sample: number) => count + (sample === 0 ? 0 : 1), 0);
            if (nonzeroSamples > 0) {
              resolve({ frames, nonzeroSamples, encryptionErrors, publisherIdentity });
              return;
            }
            if (frames >= 300) {
              resolve({ frames, nonzeroSamples, encryptionErrors, publisherIdentity });
              return;
            }
          }
          resolve({ frames, nonzeroSamples, encryptionErrors, publisherIdentity });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          void reader.cancel();
        }
      })();
    });
  };

  const onTrackSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: { identity: string }): void => {
    if (participant.identity !== publisherIdentity || track.kind !== TrackKind.KIND_AUDIO) return;
    audioPromise ??= consumeTrack(track);
  };

  livekitRoom.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  livekitRoom.on(RoomEvent.EncryptionError, () => {
    encryptionErrors += 1;
  });

  try {
    await joinMatrixRtcSession(session, selection, config);
    await session.ensureRecalculateSessionMembers();
    await delay(1100);

    const authorization = await authorizeLivekit(runtime.matrixClient, selection, roomId, config.HTTP_TIMEOUT_MS, runtime.fetchFn);
    await withTimeout(
      livekitRoom.connect(authorization.url, authorization.jwt, {
        autoSubscribe: false,
        dynacast: false,
        encryption: {
          encryptionType: EncryptionType.GCM,
          keyProviderOptions: {
            ratchetWindowSize: 10,
            failureTolerance: 10,
            keyRingSize: 256,
            keyDerivationFunction: KeyDerivationFunction.HKDF,
          },
        },
      }),
      config.RTC_JOIN_TIMEOUT_MS,
      "Matrix receiver LiveKit connection",
    );
    const e2ee = livekitRoom.e2eeManager;
    if (!e2ee?.enabled) throw new Error("Matrix receiver did not enable LiveKit E2EE");
    keyProvider = e2ee.getKeyProvider();
    for (const [backendIdentity, received] of receivedKeys) {
      keyProvider.setKey(backendIdentity, received.keyIndex, received.rawKey);
    }

    const requestSubscriptions = (): void => {
      for (const participant of livekitRoom.remoteParticipants.values()) {
        if (participant.identity !== publisherIdentity) continue;
        for (const publication of participant.trackPublications.values()) {
          if (publication.kind !== TrackKind.KIND_AUDIO) continue;
          if (!publication.subscribed) publication.setSubscribed(true);
          if (publication.track) audioPromise ??= consumeTrack(publication.track as RemoteTrack);
        }
      }
    };
    requestSubscriptions();

    const deadline = Date.now() + 30000;
    while (!audioPromise && Date.now() < deadline) {
      requestSubscriptions();
      await delay(50);
    }
    if (!audioPromise) {
      const keys = [...receivedKeys.keys()];
      throw new Error(`Publisher audio track was not subscribed; keys received for ${JSON.stringify(keys)}`);
    }
    const stats = await withTimeout(audioPromise, Math.max(deadline - Date.now(), 1), "Matrix receiver audio reception");
    if (stats.nonzeroSamples === 0) {
      throw new Error(`Matrix receiver decrypted silence for ${stats.frames} frames with ${encryptionErrors} encryption errors`);
    }
    logger.info({ roomId, publisherIdentity, frames: stats.frames, nonzeroSamples: stats.nonzeroSamples }, "MatrixRTC receiver decrypted publisher audio");
    return stats;
  } finally {
    session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, onEncryptionKeyChanged);
    livekitRoom.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    livekitRoom.removeAllListeners();
    await Promise.allSettled([livekitRoom.isConnected ? livekitRoom.disconnect() : Promise.resolve()]);
    await session.leave(5000).catch(() => false);
  }
}

async function joinMatrixRtcSession(session: MatrixRTCSession, selection: LivekitTransportSelection, config: AppConfig): Promise<void> {
  const identity: CallMembershipIdentityParts = {
    userId: config.MATRIX_USER_ID,
    deviceId: config.MATRIX_DEVICE_ID,
    memberId: selection.memberId,
  };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Matrix receiver membership confirmation timed out"));
    }, 30000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      session.off(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
      session.off(MatrixRTCSessionEvent.MembershipManagerError, onError);
    };
    const onMemberships = (): void => {
      if (!session.memberships.some((membership) => {
        return membership.userId === identity.userId && membership.deviceId === identity.deviceId && membership.memberId === identity.memberId;
      })) return;
      cleanup();
      resolve();
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    session.on(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
    session.on(MatrixRTCSessionEvent.MembershipManagerError, onError);
    session.join(identity, [selection.transport], {
      manageMediaKeys: true,
      callIntent: "audio",
      unstableSendStickyEvents: true,
    });
    onMemberships();
  });
}
