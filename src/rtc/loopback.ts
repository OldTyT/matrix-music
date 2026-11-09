import { AudioStream, Room, RoomEvent, type RemoteTrack, type RemoteTrackPublication } from "@livekit/rtc-node";
import { EncryptionType, KeyDerivationFunction, TrackKind } from "@livekit/rtc-ffi-bindings";
import { delay, withTimeout } from "../util/time.js";
import type { RtcRoomCall } from "./room-call.js";

export interface LoopbackAudioStats {
  frames: number;
  nonzeroSamples: number;
  encryptionErrors: number;
}

export interface LoopbackReceiver {
  waitForAudio: () => Promise<LoopbackAudioStats>;
  close: () => Promise<void>;
}

export async function prepareLoopbackReceiver(call: RtcRoomCall): Promise<LoopbackReceiver> {
  const authorization = await call.loopbackAuthorization();
  const key = call.loopbackKeyMaterial();
  const room = new Room();
  const targetSid = call.publishedTrackSid;
  if (!targetSid) throw new Error("Loopback receiver requires a published track SID");

  let audioPromise: Promise<LoopbackAudioStats> | undefined;
  let encryptionErrors = 0;

  const consumeTrack = (track: RemoteTrack): Promise<LoopbackAudioStats> => {
    return new Promise((resolve, reject) => {
      const stream = new AudioStream(track, 48000, 2);
      let frames = 0;
      let nonzeroSamples = 0;
      void (async () => {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value: frame } = await reader.read();
            if (done) break;
            frames += 1;
            nonzeroSamples += frame.data.reduce((count: number, sample: number) => count + (sample === 0 ? 0 : 1), 0);
            if (nonzeroSamples > 0) {
              resolve({ frames, nonzeroSamples, encryptionErrors });
              return;
            }
            if (frames >= 300) {
              resolve({ frames, nonzeroSamples, encryptionErrors });
              return;
            }
          }
          resolve({ frames, nonzeroSamples, encryptionErrors });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          void reader.cancel();
        }
      })();
    });
  };

  const onTrackSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication): void => {
    if (publication.sid !== targetSid || track.kind !== TrackKind.KIND_AUDIO) return;
    audioPromise ??= consumeTrack(track);
  };

  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  room.on(RoomEvent.EncryptionError, () => {
    encryptionErrors += 1;
  });

  const requestSubscriptions = (): void => {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.sid !== targetSid || publication.kind !== TrackKind.KIND_AUDIO) continue;
        if (!publication.subscribed) publication.setSubscribed(true);
        if (publication.track) audioPromise ??= consumeTrack(publication.track as RemoteTrack);
      }
    }
  };

  try {
    await withTimeout(
      room.connect(authorization.url, authorization.jwt, {
        autoSubscribe: true,
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
      30000,
      "Loopback LiveKit connection",
    );
    requestSubscriptions();
    room.e2eeManager?.getKeyProvider().setKey(key.backendIdentity, key.keyIndex, key.rawKey);
  } catch (error) {
    room.removeAllListeners();
    await Promise.allSettled([room.disconnect()]);
    throw error;
  }

  return {
    waitForAudio: async () => {
      const publicationSummary = [...room.remoteParticipants.values()].flatMap((participant) => {
        return [...participant.trackPublications.values()].map((publication) => ({
          sid: publication.sid,
          kind: publication.kind,
          subscribed: publication.subscribed,
          hasTrack: publication.track !== undefined,
        }));
      });
      const deadline = Date.now() + 20000;
      while (!audioPromise && Date.now() < deadline) {
        requestSubscriptions();
        await delay(50);
      }
      if (!audioPromise) {
        const message = `Bot audio track was not subscribed by the loopback receiver: ${JSON.stringify(publicationSummary)}`;
        if (encryptionErrors > 0) throw new Error(`Loopback receiver reported ${encryptionErrors} encryption errors: ${message}`);
        throw new Error(message);
      }
      try {
        return await withTimeout(audioPromise, Math.max(deadline - Date.now(), 1), "Loopback audio reception");
      } catch (error) {
        if (encryptionErrors > 0) throw new Error(`Loopback receiver reported ${encryptionErrors} encryption errors and no decrypted audio: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    close: async () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.removeAllListeners();
      await Promise.allSettled([room.isConnected ? room.disconnect() : Promise.resolve()]);
    },
  };
}
