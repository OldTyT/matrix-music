import {
  type AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  type E2EEManager,
  type KeyProvider,
  type LocalTrackPublication,
} from "@livekit/rtc-node";
import { EncryptionType, KeyDerivationFunction } from "@livekit/rtc-ffi-bindings";
import { UnsupportedStickyEventsEndpointError } from "matrix-js-sdk";
import type { Room as MatrixRoom } from "matrix-js-sdk";
import { MatrixRTCSessionEvent, type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import type { CallMembershipIdentityParts } from "matrix-js-sdk/lib/matrixrtc/EncryptionManager.js";
import type { AppConfig } from "../config/schema.js";
import type { MatrixRuntime } from "../matrix/runtime.js";
import { configSecrets, type AppLogger } from "../util/logger.js";
import { sanitizedError } from "../util/sanitize.js";
import { delay, withTimeout } from "../util/time.js";
import { authorizeLivekit, selectLivekitTransport, type LivekitAuthorization, type LivekitTransportSelection } from "./transport.js";

interface OwnKey {
  rawKey: Uint8Array;
  index: number;
}

interface PendingKey extends OwnKey {
  backendIdentity: string;
}

export interface RtcRoomCallEvents {
  onClosed?: (reason: string) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onEncryptionError?: (error: Error) => void;
}

export class RtcRoomCall {
  private session: MatrixRTCSession | undefined;
  private selection: LivekitTransportSelection | undefined;
  private livekitRoom: Room | undefined;
  private keyProvider: KeyProvider | undefined;
  private audioSource: AudioSource | undefined;
  private localTrack: LocalAudioTrack | undefined;
  private publication: LocalTrackPublication | undefined;
  private ownKey: OwnKey | undefined;
  private readonly pendingKeys = new Map<string, PendingKey>();
  private active = false;
  private closing = false;
  private connected = false;
  private reconnectTask: Promise<void> | undefined;
  private reconnectAttempt = 0;
  private aloneTimer: NodeJS.Timeout | undefined;
  private lifecycleController = new AbortController();
  private wrongKeyControl = false;

  constructor(
    readonly roomId: string,
    private readonly runtime: MatrixRuntime,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly events: RtcRoomCallEvents = {},
  ) {}

  get isConnected(): boolean {
    return this.connected && this.livekitRoom?.isConnected === true;
  }

  get remoteParticipantCount(): number {
    return this.livekitRoom?.remoteParticipants.size ?? 0;
  }

  get publishedTrackSid(): string | undefined {
    return this.publication?.sid;
  }

  get livekitRoomName(): string | undefined {
    return this.livekitRoom?.name;
  }

  async loopbackAuthorization(): Promise<LivekitAuthorization> {
    if (!this.selection) throw new Error("LiveKit transport selection is missing");
    return authorizeLivekit(this.runtime.matrixClient, this.selection, this.roomId, this.config.HTTP_TIMEOUT_MS, this.runtime.fetchFn, "MUSICBOTRECV");
  }

  loopbackKeyMaterial(): { backendIdentity: string; keyIndex: number; rawKey: Uint8Array } {
    if (!this.ownKey || !this.selection) throw new Error("Own MatrixRTC key is not ready");
    return {
      backendIdentity: this.selection.backendIdentity,
      keyIndex: this.ownKey.index,
      rawKey: new Uint8Array(this.ownKey.rawKey),
    };
  }

  async join(options: { wrongKeyControl?: boolean } = {}): Promise<void> {
    if (this.active) throw new Error("This room call is already joined or joining");
    this.active = true;
    this.closing = false;
    this.wrongKeyControl = options.wrongKeyControl === true;
    this.lifecycleController = new AbortController();

    try {
      const matrixRoom = await this.runtime.requireEncryptedAuthorizedRoom(this.roomId);
      const session = this.runtime.matrixClient.matrixRTC.getRoomSession(matrixRoom);
      this.session = session;
      await session.initialMembershipCalculated;
      await session.ensureRecalculateSessionMembers();
      this.assertExistingCall(matrixRoom, session);

      const selection = await selectLivekitTransport(await this.runtime.discoverTransports(), this.config);
      this.selection = selection;
      session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, this.onEncryptionKeyChanged);
      await this.joinMembership(session, selection);
      await session.ensureRecalculateSessionMembers();
      await delay(1100, this.lifecycleController.signal);
      await this.waitForOwnKey();
      await this.connectLiveKit();
      this.updateAloneTimer();
      this.logger.info({ roomId: this.roomId, livekitRoom: this.livekitRoomName, remoteParticipants: this.remoteParticipantCount, backendIdentity: selection.backendIdentity, trackSid: this.publication?.sid }, "Encrypted MatrixRTC call is ready");
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  private assertExistingCall(room: MatrixRoom, session: MatrixRTCSession): void {
    if (session.isSlotClosed() === true) throw new Error("The Element Call in this room is closed");
    const encryption = session.getRtcSlot()?.encryption;
    if (encryption && encryption.type !== "org.matrix.msc4143.per_member") {
      throw new Error("Call-password/shared-key mode is not supported; per-participant media encryption is required");
    }
    const remoteMemberships = session.memberships.filter((membership) => membership.userId !== this.config.MATRIX_USER_ID);
    if (remoteMemberships.length === 0 || !room.hasEncryptionStateEvent()) {
      throw new Error(remoteMemberships.length === 0 ? "No active Element Call exists in this room; start it in Element Web first" : "This room is not encrypted");
    }
  }

  private async joinMembership(session: MatrixRTCSession, selection: LivekitTransportSelection): Promise<void> {
    const identity: CallMembershipIdentityParts = {
      userId: this.config.MATRIX_USER_ID,
      deviceId: this.config.MATRIX_DEVICE_ID,
      memberId: selection.memberId,
    };
    try {
      await this.joinMembershipOnce(session, identity, selection, this.config.MATRIX_RTC_MEMBERSHIP_MODE === "sticky");
    } catch (error) {
      if (!(error instanceof UnsupportedStickyEventsEndpointError) || this.config.MATRIX_RTC_MEMBERSHIP_MODE !== "sticky") {
        throw this.membershipError(error);
      }
      if (selection.authentication === "url-only") {
        throw new Error("The server does not support sticky membership required by URL-only LiveKit discovery");
      }
      this.logger.warn({ roomId: this.roomId }, "Server does not support sticky MatrixRTC events; retrying with legacy membership");
      await session.leave(5000).catch(() => false);
      this.ownKey = undefined;
      await this.joinMembershipOnce(session, identity, selection, false);
    }
  }

  private membershipError(error: unknown): Error {
    if (error instanceof UnsupportedStickyEventsEndpointError) return error;
    const message = sanitizedError(error, configSecrets(this.config));
    if (/forbidden|M_FORBIDDEN|power level/i.test(message)) {
      return new Error(`MatrixRTC membership was rejected. Ask a room administrator to allow the bot to send call membership events: ${message}`);
    }
    return error instanceof Error ? error : new Error(message);
  }

  private async joinMembershipOnce(
    session: MatrixRTCSession,
    identity: CallMembershipIdentityParts,
    selection: LivekitTransportSelection,
    sticky: boolean,
  ): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const membership = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        session.off(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
        session.off(MatrixRTCSessionEvent.MembershipManagerError, onError);
      };
      const hasOwnMembership = (): boolean => {
        return session.memberships.some((member) => {
          return member.userId === identity.userId && member.deviceId === identity.deviceId && member.memberId === identity.memberId;
        });
      };
      const onMemberships = (): void => {
        if (!hasOwnMembership()) return;
        cleanup();
        resolve();
      };
      const onError = (error: unknown): void => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      session.on(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
      session.on(MatrixRTCSessionEvent.MembershipManagerError, onError);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error("MatrixRTC membership confirmation timed out"));
      }, this.config.RTC_JOIN_TIMEOUT_MS);
      try {
        session.join(identity, [selection.transport], {
          manageMediaKeys: true,
          callIntent: "audio",
          unstableSendStickyEvents: sticky,
        });
        onMemberships();
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    try {
      await membership;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private readonly onEncryptionKeyChanged = (
    rawKey: Uint8Array,
    index: number,
    membership: CallMembershipIdentityParts,
    backendIdentity: string,
  ): void => {
    const selection = this.selection;
    if (!selection) return;
    const own = membership.userId === this.config.MATRIX_USER_ID && membership.deviceId === this.config.MATRIX_DEVICE_ID && membership.memberId === selection.memberId;
    if (own && backendIdentity === selection.backendIdentity) this.ownKey = { rawKey, index };
    const pending: PendingKey = { rawKey, index, backendIdentity };
    this.pendingKeys.set(`${backendIdentity}:${index}`, pending);
    if (this.pendingKeys.size > 4096) {
      const oldest = this.pendingKeys.keys().next().value;
      if (oldest) this.pendingKeys.delete(oldest);
    }
    this.installKey(pending);
  };

  private installKey(pending: PendingKey): void {
    if (!this.keyProvider) return;
    const wrongKey = this.wrongKeyControl && pending.backendIdentity === this.selection?.backendIdentity;
    const rawKey = wrongKey ? Uint8Array.from({ length: 16 }, () => 0x42) : pending.rawKey;
    this.keyProvider.setKey(pending.backendIdentity, pending.index, rawKey);
    if (pending.backendIdentity === this.selection?.backendIdentity) this.applyOwnKeyIndex();
  }

  private async waitForOwnKey(): Promise<void> {
    const deadline = Date.now() + this.config.RTC_JOIN_TIMEOUT_MS;
    while (!this.ownKey) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the bot's MatrixRTC per-participant media key");
      await delay(20, this.lifecycleController.signal);
    }
    if (!this.selection) throw new Error("LiveKit transport selection is missing");
  }

  private async connectLiveKit(): Promise<void> {
    if (this.closing || !this.active) throw new Error("Call is closing");
    const reconnecting = this.reconnectAttempt > 0;
    const selection = this.selection;
    if (!selection || !this.ownKey) throw new Error("Cannot connect LiveKit before MatrixRTC key initialization");
    const authorization = await authorizeLivekit(this.runtime.matrixClient, selection, this.roomId, this.config.HTTP_TIMEOUT_MS, this.runtime.fetchFn);
    const room = new Room();
    let source: AudioSource | undefined;
    let track: LocalAudioTrack | undefined;
    try {
      await withTimeout(
        room.connect(authorization.url, authorization.jwt, {
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
        this.config.RTC_JOIN_TIMEOUT_MS,
        "LiveKit connection",
      );
      if (this.closing || !this.active) throw new Error("Call closed while LiveKit was connecting");
      if (room.localParticipant?.identity !== selection.backendIdentity) {
        throw new Error(`Connected LiveKit identity ${room.localParticipant?.identity ?? "unknown"} does not match MatrixRTC backendIdentity ${selection.backendIdentity}`);
      }
      const e2ee = room.e2eeManager;
      if (!e2ee?.enabled) throw new Error("LiveKit did not enable per-participant E2EE");

      this.livekitRoom = room;
      this.keyProvider = e2ee.getKeyProvider();
      this.attachRoomEvents(room);
      this.session?.reemitEncryptionKeys();
      for (const pending of this.pendingKeys.values()) this.installKey(pending);

      source = new AudioSource(48000, 2, this.config.LIVEKIT_AUDIO_QUEUE_MS);
      track = LocalAudioTrack.createAudioTrack("musicbot-stereo", source);
      const publishOptions = new TrackPublishOptions();
      publishOptions.source = TrackSource.SOURCE_MICROPHONE;
      publishOptions.dtx = false;
      publishOptions.red = false;
      const publication = await withTimeout(
        room.localParticipant.publishTrack(track, publishOptions),
        this.config.RTC_JOIN_TIMEOUT_MS,
        "LiveKit audio publication",
      );
      if (!publication.sid) throw new Error("LiveKit publication has no track SID");
      this.audioSource = source;
      this.localTrack = track;
      this.publication = publication;
      await this.waitForPublisherCryptor(e2ee, publication.sid);
      this.session?.reemitEncryptionKeys();
      this.applyOwnKeyIndex();
      this.connected = true;
      this.reconnectAttempt = 0;
      if (reconnecting) this.events.onReconnected?.();
    } catch (error) {
      this.connected = false;
      room.removeAllListeners();
      if (this.livekitRoom === room) this.livekitRoom = undefined;
      this.keyProvider = undefined;
      this.audioSource = undefined;
      this.localTrack = undefined;
      this.publication = undefined;
      await Promise.allSettled([
        track?.close(false) ?? Promise.resolve(),
        source?.close() ?? Promise.resolve(),
        room.isConnected ? room.disconnect() : Promise.resolve(),
      ]);
      throw error;
    }
  }

  private async waitForPublisherCryptor(e2ee: E2EEManager, trackSid: string): Promise<void> {
    const deadline = Date.now() + this.config.RTC_JOIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.applyOwnKeyIndex();
      const cryptor = e2ee.frameCryptors().find((candidate) => {
        return candidate.participantIdentity === this.selection?.backendIdentity && candidate.trackSid === trackSid;
      });
      if (cryptor && this.ownKey && cryptor.keyIndex === this.ownKey.index && cryptor.enabled) return;
      await delay(20, this.lifecycleController.signal);
    }
    throw new Error("Timed out waiting for the encrypted publisher frame cryptor");
  }

  private applyOwnKeyIndex(): void {
    const manager = this.livekitRoom?.e2eeManager;
    const ownKey = this.ownKey;
    const selection = this.selection;
    if (!manager || !ownKey || !selection) return;
    for (const cryptor of manager.frameCryptors()) {
      if (cryptor.participantIdentity !== selection.backendIdentity) continue;
      cryptor.setEnabled(true);
      cryptor.setKeyIndex(ownKey.index);
    }
  }

  private attachRoomEvents(room: Room): void {
    room.on(RoomEvent.ParticipantConnected, () => {
      this.logger.info({ roomId: this.roomId, remoteParticipants: this.remoteParticipantCount }, "LiveKit remote participant connected");
      this.updateAloneTimer();
    });
    room.on(RoomEvent.ParticipantDisconnected, () => {
      this.logger.info({ roomId: this.roomId, remoteParticipants: this.remoteParticipantCount }, "LiveKit remote participant disconnected");
      this.updateAloneTimer();
    });
    room.on(RoomEvent.LocalTrackRepublished, (publication) => {
      this.publication = publication;
      this.session?.reemitEncryptionKeys();
      this.applyOwnKeyIndex();
    });
    room.on(RoomEvent.Reconnecting, () => {
      this.connected = false;
      this.events.onReconnecting?.();
    });
    room.on(RoomEvent.Reconnected, () => {
      this.connected = true;
      this.session?.reemitEncryptionKeys();
      this.applyOwnKeyIndex();
      this.events.onReconnected?.();
    });
    room.on(RoomEvent.EncryptionError, (error) => {
      this.logger.error({ roomId: this.roomId, error: sanitizedError(error, configSecrets(this.config)) }, "LiveKit E2EE error");
      this.events.onEncryptionError?.(error);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.livekitRoom !== room || this.closing || !this.active) return;
      this.connected = false;
      this.livekitRoom = undefined;
      this.keyProvider = undefined;
      const previousTrack = this.localTrack;
      const previousSource = this.audioSource;
      this.audioSource = undefined;
      this.localTrack = undefined;
      this.publication = undefined;
      room.removeAllListeners();
      void Promise.allSettled([
        previousTrack?.close(false) ?? Promise.resolve(),
        previousSource?.close() ?? Promise.resolve(),
      ]);
      this.events.onReconnecting?.();
      this.startReconnect();
    });
  }

  private startReconnect(): void {
    if (this.reconnectTask) return;
    this.reconnectTask = this.reconnectLoop().finally(() => {
      this.reconnectTask = undefined;
    });
    void this.reconnectTask.catch((error: unknown) => {
      this.logger.error({ roomId: this.roomId, error: sanitizedError(error, configSecrets(this.config)) }, "LiveKit reconnect loop failed");
    });
  }

  private async reconnectLoop(): Promise<void> {
    while (this.active && !this.closing) {
      const backoff = Math.min(1000 * 2 ** this.reconnectAttempt, this.config.RECONNECT_MAX_DELAY_MS);
      this.reconnectAttempt += 1;
      try {
        await delay(backoff, this.lifecycleController.signal);
        await this.connectLiveKit();
        this.logger.info({ roomId: this.roomId }, "LiveKit reconnection completed");
        return;
      } catch (error) {
        if (this.closing || this.lifecycleController.signal.aborted) return;
        this.logger.warn({ roomId: this.roomId, backoff, error: sanitizedError(error, configSecrets(this.config)) }, "LiveKit reconnect attempt failed");
      }
    }
  }

  private readonly updateAloneTimer = (): void => {
    if (this.aloneTimer) clearTimeout(this.aloneTimer);
    this.aloneTimer = undefined;
    if (!this.active || this.closing || this.remoteParticipantCount > 0) return;
    this.aloneTimer = setTimeout(() => {
      void this.leave("No remote participants remained in the call");
    }, this.config.ALONE_TIMEOUT_MS);
  };

  async captureFrame(frame: AudioFrame): Promise<void> {
    if (!this.isConnected || !this.audioSource) throw new Error("LiveKit audio publisher is not ready");
    await this.audioSource.captureFrame(frame);
  }

  clearAudioQueue(): void {
    this.audioSource?.clearQueue();
  }

  async waitForPlayout(): Promise<void> {
    await this.audioSource?.waitForPlayout();
  }

  async leave(reason = "Leave requested"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.active = false;
    this.connected = false;
    this.lifecycleController.abort(new Error(reason));
    if (this.aloneTimer) clearTimeout(this.aloneTimer);
    this.aloneTimer = undefined;
    await this.cleanup();
    this.events.onClosed?.(reason);
  }

  private async cleanup(): Promise<void> {
    this.closing = true;
    this.active = false;
    this.connected = false;
    this.lifecycleController.abort(new Error("Call cleanup"));
    if (this.aloneTimer) clearTimeout(this.aloneTimer);
    this.aloneTimer = undefined;
    const room = this.livekitRoom;
    this.livekitRoom = undefined;
    this.keyProvider = undefined;
    const track = this.localTrack;
    const source = this.audioSource;
    this.localTrack = undefined;
    this.audioSource = undefined;
    this.publication = undefined;
    room?.removeAllListeners();
    await Promise.allSettled([
      track?.close(false) ?? Promise.resolve(),
      source?.close() ?? Promise.resolve(),
      room?.isConnected ? withTimeout(room.disconnect(), 5000, "LiveKit disconnect") : Promise.resolve(),
    ]);
    if (this.session) {
      this.session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, this.onEncryptionKeyChanged);
      await withTimeout(this.session.leave(5000), 6000, "MatrixRTC leave").catch((error: unknown) => {
        this.logger.warn({ roomId: this.roomId, error: sanitizedError(error, configSecrets(this.config)) }, "MatrixRTC leave did not complete cleanly");
      });
    }
    this.session = undefined;
    this.selection = undefined;
    this.ownKey = undefined;
    this.pendingKeys.clear();
  }
}
