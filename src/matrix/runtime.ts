import {
  ClientEvent,
  createClient,
  EventType,
  KnownMembership,
  MatrixEventEvent,
  MemoryStore,
  MsgType,
  RoomEvent,
  RoomMemberEvent,
  SyncState,
  type IRoomTimelineData,
  type RoomMember,
} from "matrix-js-sdk";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import type { Transport } from "matrix-js-sdk/lib/matrixrtc/index.js";
import type { AppConfig } from "../config/schema.js";
import { ManagedHttpAgent } from "../util/http-agent.js";
import { configSecrets, type AppLogger } from "../util/logger.js";
import { sanitizedError } from "../util/sanitize.js";
import { withTimeout } from "../util/time.js";
import { RoomAllowlist } from "./allowlist.js";
import { configureMatrixRootLogger, MatrixSdkLogger } from "./sdk-logger.js";

export interface MatrixCommand {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
}

export class MatrixRuntime {
  readonly allowlist: RoomAllowlist;
  private readonly httpAgent = new ManagedHttpAgent();
  private client?: MatrixClient;
  private commandHandler?: (command: MatrixCommand) => Promise<void>;
  private beforeStop?: () => Promise<void>;
  private ready = false;
  private stopping = false;
  private readonly pendingLateDecryption = new Set<string>();
  private readonly processedEvents = new Set<string>();
  private readonly invitationsInProgress = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {
    this.allowlist = new RoomAllowlist(config);
  }

  setCommandHandler(handler: (command: MatrixCommand) => Promise<void>): void {
    this.commandHandler = handler;
  }

  setBeforeStop(handler: () => Promise<void>): void {
    this.beforeStop = handler;
  }

  get matrixClient(): MatrixClient {
    if (!this.client) throw new Error("Matrix client is not running");
    return this.client;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get fetchFn(): typeof globalThis.fetch {
    return this.httpAgent.fetch;
  }

  async start(options: { joinConfiguredRooms?: boolean } = {}): Promise<void> {
    if (this.client) throw new Error("Matrix runtime has already started");
    await this.allowlist.load();
    const matrixLogger = new MatrixSdkLogger(this.logger, configSecrets(this.config));
    configureMatrixRootLogger(this.logger, configSecrets(this.config), this.config.LOG_LEVEL);
    const client = createClient({
      baseUrl: this.config.MATRIX_HOMESERVER,
      accessToken: this.config.MATRIX_ACCESS_TOKEN,
      userId: this.config.MATRIX_USER_ID,
      deviceId: this.config.MATRIX_DEVICE_ID,
      store: new MemoryStore(),
      logger: matrixLogger,
      fetchFn: this.fetchFn,
      disableVoip: false,
      isVoipWithNoMediaAllowed: true,
      useLivekitForGroupCalls: true,
      verificationMethods: [VerificationMethod.Sas],
    });
    this.client = client;

    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: this.config.MATRIX_CRYPTO_DATABASE_PREFIX,
      storageKey: Buffer.from(this.config.MATRIX_CRYPTO_STORE_KEY, "hex"),
    });

    client.on(RoomEvent.Timeline, this.onTimeline);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    client.on(RoomMemberEvent.Membership, this.onMembership);

    try {
      const prepared = this.waitUntilPrepared(client);
      await client.startClient({ initialSyncLimit: 1, lazyLoadMembers: false, disablePresence: true });
      await prepared;
      await this.validateIdentity();
      if (options.joinConfiguredRooms !== false) {
        for (const roomId of this.config.MATRIX_ROOM_IDS) {
          await this.joinConfiguredRoom(roomId);
        }
      }
      this.ready = true;
      await this.processPendingInvites();
      this.logger.info({ userId: this.config.MATRIX_USER_ID, deviceId: this.config.MATRIX_DEVICE_ID }, "Matrix runtime is ready");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private waitUntilPrepared(client: MatrixClient): Promise<void> {
    return withTimeout(
      new Promise<void>((resolve, reject) => {
        const onSync = (state: SyncState, _previous: SyncState | null, data?: { error?: unknown }): void => {
          if (state === SyncState.Prepared) {
            client.off(ClientEvent.Sync, onSync);
            resolve();
          } else if (state === SyncState.Error) {
            client.off(ClientEvent.Sync, onSync);
            reject(data?.error instanceof Error ? data.error : new Error("Initial Matrix sync failed"));
          }
        };
        client.on(ClientEvent.Sync, onSync);
      }),
      this.config.RTC_JOIN_TIMEOUT_MS,
      "Initial Matrix sync",
    );
  }

  async validateIdentity(): Promise<void> {
    const identity = await this.matrixClient.whoami();
    if (identity.user_id !== this.config.MATRIX_USER_ID || identity.device_id !== this.config.MATRIX_DEVICE_ID) {
      throw new Error("Matrix access token identity does not match MATRIX_USER_ID and MATRIX_DEVICE_ID");
    }
  }

  private async joinConfiguredRoom(roomId: string): Promise<Room> {
    const joined = await this.matrixClient.joinRoom(roomId);
    const encrypted = await this.matrixClient.getCrypto()?.isEncryptionEnabledInRoom(joined.roomId);
    if (!encrypted) {
      await this.matrixClient.leave(joined.roomId).catch((error: unknown) => {
        this.logger.warn({ roomId, error: sanitizedError(error, configSecrets(this.config)) }, "Failed to leave an unencrypted room");
      });
      throw new Error(`Room ${roomId} is not encrypted; refusing to use it`);
    }
    return joined;
  }

  async joinAuthorizedRoom(roomId: string): Promise<Room> {
    if (!this.allowlist.isAuthorized(roomId)) throw new Error("This room is not authorized for the bot");
    return this.joinConfiguredRoom(roomId);
  }

  async requireEncryptedAuthorizedRoom(roomId: string): Promise<Room> {
    const room = this.matrixClient.getRoom(roomId);
    if (!room || room.getMember(this.config.MATRIX_USER_ID)?.membership !== KnownMembership.Join) {
      throw new Error("The bot is not a joined member of this room");
    }
    if (!this.allowlist.isAuthorized(roomId)) throw new Error("This room is not authorized for the bot");
    if (!(await this.matrixClient.getCrypto()?.isEncryptionEnabledInRoom(roomId))) {
      throw new Error("This bot requires an encrypted Matrix room");
    }
    return room;
  }

  async discoverTransports(): Promise<Transport[]> {
    return withTimeout(
      this.matrixClient._unstable_getRTCTransports(),
      this.config.HTTP_TIMEOUT_MS,
      "MatrixRTC transport discovery",
    );
  }

  async sendText(roomId: string, body: string): Promise<void> {
    await this.matrixClient.sendMessage(roomId, { msgtype: MsgType.Text, body });
  }

  private readonly onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    removed: boolean,
    data: IRoomTimelineData,
  ): void => {
    if (!this.ready || !room || toStartOfTimeline || removed || data.liveEvent === false) return;
    const eventId = event.getId();
    if (!eventId) return;
    if (event.getType() === EventType.RoomEncryption || event.isEncrypted()) {
      this.pendingLateDecryption.add(eventId);
    }
    this.dispatchEvent(event, room);
  };

  private readonly onDecrypted = (event: MatrixEvent, error?: Error): void => {
    if (!this.ready || error) return;
    const eventId = event.getId();
    if (!eventId || !this.pendingLateDecryption.delete(eventId)) return;
    const room = this.matrixClient.getRoom(event.getRoomId());
    if (room) this.dispatchEvent(event, room);
  };

  private dispatchEvent(event: MatrixEvent, room: Room): void {
    const eventId = event.getId();
    const sender = event.getSender();
    if (!eventId || !sender || sender === this.config.MATRIX_USER_ID || this.processedEvents.has(eventId)) return;
    if (event.getType() !== EventType.RoomMessage) return;
    if (!event.isEncrypted()) return;
    if (!this.allowlist.isAuthorized(room.roomId)) return;
    if (room.getMember(this.config.MATRIX_USER_ID)?.membership !== KnownMembership.Join) return;
    if (!room.hasMembershipState(sender, KnownMembership.Join)) return;
    if (!room.hasEncryptionStateEvent()) return;

    const content = event.getContent();
    if (content.msgtype !== MsgType.Text || typeof content.body !== "string") return;
    const relation = content["m.relates_to"];
    if (typeof relation === "object" && relation !== null && "rel_type" in relation && relation.rel_type === "m.replace") return;
    const body = content.body.trim();
    if (!body.startsWith(this.config.COMMAND_PREFIX)) return;

    this.processedEvents.add(eventId);
    this.pendingLateDecryption.delete(eventId);
    if (this.processedEvents.size > 10000) {
      const oldest = this.processedEvents.values().next().value;
      if (oldest) this.processedEvents.delete(oldest);
    }
    const command = { eventId, roomId: room.roomId, sender, body };
    void this.invokeCommand(command);
  }

  private async invokeCommand(command: MatrixCommand): Promise<void> {
    if (!this.commandHandler) return;
    try {
      await this.commandHandler(command);
    } catch (error) {
      const message = sanitizedError(error, configSecrets(this.config));
      this.logger.warn({ roomId: command.roomId, eventId: command.eventId, error: message }, "Matrix command failed");
      await this.sendText(command.roomId, `Command failed: ${message}`).catch((replyError: unknown) => {
        this.logger.warn({ error: sanitizedError(replyError, configSecrets(this.config)) }, "Failed to send command error reply");
      });
    }
  }

  private readonly onMembership = (event: MatrixEvent, member: RoomMember): void => {
    if (!this.ready || member.userId !== this.config.MATRIX_USER_ID || member.membership !== KnownMembership.Invite) return;
    void this.handleInvitation(event.getSender(), member.roomId).catch((error: unknown) => {
      this.logger.warn({ roomId: member.roomId, error: sanitizedError(error, configSecrets(this.config)) }, "Failed to handle room invitation");
    });
  };

  private async processPendingInvites(): Promise<void> {
    if (!this.config.MATRIX_AUTO_ACCEPT_INVITES) return;
    for (const room of this.matrixClient.getRooms()) {
      if (room.getMember(this.config.MATRIX_USER_ID)?.membership !== KnownMembership.Invite) continue;
      const inviteEvent = room.currentState.getStateEvents(EventType.RoomMember, this.config.MATRIX_USER_ID);
      try {
        await this.handleInvitation(inviteEvent?.getSender(), room.roomId);
      } catch (error) {
        this.logger.warn({ roomId: room.roomId, error: sanitizedError(error, configSecrets(this.config)) }, "Failed to process a pending room invitation");
      }
    }
  }

  private async handleInvitation(inviter: string | undefined, roomId: string): Promise<void> {
    if (!this.config.MATRIX_AUTO_ACCEPT_INVITES) {
      this.logger.info({ roomId, inviter }, "Automatic invite acceptance is disabled");
      return;
    }
    if (this.invitationsInProgress.has(roomId)) return;
    this.invitationsInProgress.add(roomId);
    try {
      if (!inviter || !this.config.MATRIX_ADMIN_USER_IDS.includes(inviter)) {
        this.logger.info({ roomId, inviter }, "Ignoring invitation from a non-administrator");
        return;
      }
      const invitedRoom = this.matrixClient.getRoom(roomId);
      if (!invitedRoom?.hasEncryptionStateEvent()) {
        this.logger.warn({ roomId, inviter }, "Ignoring invitation to an unencrypted room");
        return;
      }
      await this.matrixClient.joinRoom(roomId);
      if (!(await this.matrixClient.getCrypto()?.isEncryptionEnabledInRoom(roomId))) {
        await this.matrixClient.leave(roomId);
        throw new Error("Invitation encryption state changed; left the unencrypted room");
      }
      await this.allowlist.authorize(roomId);
      await this.sendText(roomId, "Music bot is ready. Start Element Call, then use !join.");
      this.logger.info({ roomId, inviter }, "Joined and authorized an invited encrypted room");
    } finally {
      this.invitationsInProgress.delete(roomId);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.ready = false;
    this.pendingLateDecryption.clear();
    this.invitationsInProgress.clear();
    if (this.beforeStop) {
      await this.beforeStop().catch((error: unknown) => {
        this.logger.error({ error: sanitizedError(error, configSecrets(this.config)) }, "Failed to stop application services cleanly");
      });
    }
    if (this.client) {
      this.client.off(RoomEvent.Timeline, this.onTimeline);
      this.client.off(MatrixEventEvent.Decrypted, this.onDecrypted);
      this.client.off(RoomMemberEvent.Membership, this.onMembership);
      this.client.stopClient();
    }
    await this.httpAgent.close();
    this.logger.info("Matrix runtime stopped");
  }
}
