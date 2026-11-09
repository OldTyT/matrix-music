import type { AppConfig } from "../config/schema.js";
import type { MatrixCommand, MatrixRuntime } from "../matrix/runtime.js";
import { SubsonicClient, type MusicCollection, type MusicTrack } from "../subsonic/client.js";
import { PlaybackRoomSession } from "../playback/room-session.js";
import { RtcCallManager } from "../rtc/manager.js";
import type { AppLogger } from "../util/logger.js";

interface PendingSelection {
  sender: string;
  tracks: MusicTrack[];
  collections: MusicCollection[];
  expiresAt: number;
}

interface SelectionItem {
  title: string;
  subtitle: string;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTrack(index: number | undefined, track: MusicTrack): string {
  const prefix = index === undefined ? "" : `${index}. `;
  return `${prefix}${track.title} — ${track.artist} (${formatDuration(track.durationSeconds)})`;
}

export class MusicApplication {
  private readonly rtcManager: RtcCallManager;
  private readonly subsonic: SubsonicClient;
  private readonly sessions = new Map<string, PlaybackRoomSession>();
  private readonly pendingSelections = new Map<string, PendingSelection>();
  private stopped = false;

  constructor(
    private readonly runtime: MatrixRuntime,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {
    this.rtcManager = new RtcCallManager(runtime, config, logger);
    this.subsonic = new SubsonicClient(config, runtime.fetchFn);
    runtime.setCommandHandler((command) => this.handleCommand(command));
    runtime.setBeforeStop(async () => this.stop());
  }

  async handleCommand(command: MatrixCommand): Promise<void> {
    const args = command.body.slice(this.config.COMMAND_PREFIX.length).trim().split(/\s+/).filter(Boolean);
    const action = (args.shift() ?? "").toLowerCase();
    const argument = args.join(" ");
    try {
      if (action === "help") {
        await this.reply(command.roomId, "Commands: !play <search>, !album <search>, !playlist <search>, !select <1-5>, !queue, !np, !skip, !stop, !volume [0-200], !shuffle on|off, !autoplay on|off, !join, !leave");
      } else if (action === "join") {
        await this.ensureSession(command.roomId);
        await this.reply(command.roomId, "Encrypted call connected.");
      } else if (action === "leave") {
        await this.closeSession(command.roomId);
        await this.rtcManager.leave(command.roomId, "Leave requested");
        await this.reply(command.roomId, "Left the call.");
      } else if (action === "play") {
        await this.commandPlay(command, argument);
      } else if (action === "album") {
        await this.commandCollection(command, argument, "album");
      } else if (action === "playlist") {
        await this.commandCollection(command, argument, "playlist");
      } else if (action === "select") {
        await this.commandSelect(command, args[0]);
      } else if (action === "queue") {
        await this.commandQueue(command.roomId);
      } else if (action === "np" || action === "nowplaying") {
        await this.commandNowPlaying(command.roomId);
      } else if (action === "skip") {
        const session = this.requireSession(command.roomId);
        const hasNext = await session.skip();
        await this.reply(command.roomId, hasNext ? "Skipped." : "Skipped; queue is empty.");
      } else if (action === "stop") {
        this.requireSession(command.roomId);
        await this.sessions.get(command.roomId)?.stop(true);
        await this.reply(command.roomId, "Stopped playback and cleared the queue.");
      } else if (action === "volume") {
        await this.commandVolume(command.roomId, args[0]);
      } else if (action === "shuffle") {
        const session = this.requireSession(command.roomId);
        const enabled = this.parseSwitch(argument);
        session.setShuffle(enabled);
        await this.reply(command.roomId, `Shuffle is ${enabled ? "on" : "off"}.`);
      } else if (action === "autoplay") {
        const session = this.requireSession(command.roomId);
        const enabled = this.parseSwitch(argument);
        await session.setAutoplay(enabled);
        await this.reply(command.roomId, `Autoplay is ${enabled ? "on" : "off"}.`);
      } else if (action === "status") {
        await this.commandStatus(command.roomId);
      } else if (action) {
        await this.reply(command.roomId, `Unknown command: ${action}. Use ${this.config.COMMAND_PREFIX}help.`);
      }
    } finally {
      this.pendingSelections.forEach((selection, roomId) => {
        if (selection.expiresAt <= Date.now()) this.pendingSelections.delete(roomId);
      });
    }
  }

  private async ensureSession(roomId: string): Promise<PlaybackRoomSession> {
    if (this.stopped) throw new Error("Application is stopping");
    const existing = this.sessions.get(roomId);
    if (existing) return existing;
    const call = await this.rtcManager.join(roomId, {
      onClosed: () => {
        void this.sessions.get(roomId)?.stop(false);
        this.sessions.delete(roomId);
      },
    });
    const session = new PlaybackRoomSession(call, this.subsonic, this.config, this.logger);
    this.sessions.set(roomId, session);
    return session;
  }

  private requireSession(roomId: string): PlaybackRoomSession {
    const session = this.sessions.get(roomId);
    if (!session) throw new Error("Bot is not connected to the call; use !join first.");
    return session;
  }

  private async closeSession(roomId: string): Promise<void> {
    await this.sessions.get(roomId)?.stop(true);
    this.sessions.delete(roomId);
    this.pendingSelections.delete(roomId);
  }

  private async commandPlay(command: MatrixCommand, query: string): Promise<void> {
    if (!query) throw new Error("Usage: !play <song search>");
    const tracks = await this.subsonic.searchSongs(query, 5);
    if (tracks.length === 0) {
      await this.reply(command.roomId, "No songs found.");
      return;
    }
    if (tracks.length === 1) {
      await this.enqueueAndReply(command.roomId, tracks);
      return;
    }
    this.pendingSelections.set(command.roomId, {
      sender: command.sender,
      tracks,
      collections: [],
      expiresAt: Date.now() + 120000,
    });
    await this.reply(command.roomId, this.formatSelection("Select a song with !select <number>", tracks.map((track) => ({ title: track.title, subtitle: `${track.artist} • ${track.album} • ${formatDuration(track.durationSeconds)}` }))));
  }

  private async commandCollection(command: MatrixCommand, query: string, kind: "album" | "playlist"): Promise<void> {
    if (!query) throw new Error(`Usage: !${kind} <search>`);
    const collections = kind === "album" ? await this.subsonic.searchAlbums(query, 5) : await this.subsonic.listPlaylists(query, 5);
    if (collections.length === 0) {
      await this.reply(command.roomId, `No ${kind}s found.`);
      return;
    }
    if (collections.length === 1) {
      await this.enqueueCollectionAndReply(command.roomId, collections[0] as MusicCollection);
      return;
    }
    this.pendingSelections.set(command.roomId, {
      sender: command.sender,
      tracks: [],
      collections,
      expiresAt: Date.now() + 120000,
    });
    await this.reply(command.roomId, this.formatSelection(`Select a ${kind} with !select <number>`, collections.map((collection) => ({ title: collection.title, subtitle: collection.artist }))));
  }

  private async commandSelect(command: MatrixCommand, value: string | undefined): Promise<void> {
    const selection = this.pendingSelections.get(command.roomId);
    if (!selection) throw new Error("No pending selection. Use !play, !album, or !playlist first.");
    if (selection.sender !== command.sender) throw new Error("Only the user who created the selection can choose.");
    if (selection.expiresAt <= Date.now()) {
      this.pendingSelections.delete(command.roomId);
      throw new Error("Selection expired; run the search again.");
    }
    const index = Number(value);
    const item = Number.isInteger(index) ? (selection.tracks[index - 1] ?? selection.collections[index - 1]) : undefined;
    if (!item) throw new Error("Usage: !select <1-5>");
    this.pendingSelections.delete(command.roomId);
    if ("durationSeconds" in item) await this.enqueueAndReply(command.roomId, [item as MusicTrack]);
    else await this.enqueueCollectionAndReply(command.roomId, item as MusicCollection);
  }

  private async enqueueAndReply(roomId: string, tracks: MusicTrack[]): Promise<void> {
    const session = await this.ensureSession(roomId);
    const accepted = session.enqueue(tracks);
    const first = tracks[0];
    await this.reply(roomId, accepted > 0 && first ? `Queued: ${formatTrack(undefined, first)}` : "Queue is full.");
  }

  private async enqueueCollectionAndReply(roomId: string, collection: MusicCollection): Promise<void> {
    const tracks = collection.kind === "album" ? await this.subsonic.albumTracks(collection.id, this.config.MAX_COLLECTION_TRACKS) : await this.subsonic.playlistTracks(collection.id, this.config.MAX_COLLECTION_TRACKS);
    if (tracks.length === 0) {
      await this.reply(roomId, `${collection.title} has no playable tracks.`);
      return;
    }
    const session = await this.ensureSession(roomId);
    const accepted = session.enqueue(tracks);
    await this.reply(roomId, `Queued ${accepted}/${tracks.length} tracks from ${collection.title}.`);
  }

  private async commandQueue(roomId: string): Promise<void> {
    const session = this.requireSession(roomId);
    const status = session.status();
    const queued = session.queuedTracks(this.config.QUEUE_PAGE_SIZE);
    const lines = queued.map((track, index) => formatTrack(index + 1, track));
    const suffix = status.queueLength > lines.length ? [`…and ${status.queueLength - lines.length} more`] : [];
    await this.reply(roomId, [`Queue (${status.queueLength}):`, ...lines, ...suffix].join("\n"));
  }

  private async commandNowPlaying(roomId: string): Promise<void> {
    const status = this.requireSession(roomId).status();
    if (!status.currentTrack) {
      await this.reply(roomId, "Nothing is playing.");
      return;
    }
    await this.reply(roomId, `Now playing: ${formatTrack(undefined, status.currentTrack)}\nQueue: ${status.queueLength}`);
  }

  private async commandVolume(roomId: string, value: string | undefined): Promise<void> {
    const session = this.requireSession(roomId);
    if (value === undefined) {
      await this.reply(roomId, `Volume is ${session.getVolume()}%.`);
      return;
    }
    session.setVolume(Number(value));
    await this.reply(roomId, `Volume set to ${session.getVolume()}%.`);
  }

  private async commandStatus(roomId: string): Promise<void> {
    const call = this.rtcManager.get(roomId);
    const session = this.sessions.get(roomId);
    const status = session?.status();
    await this.reply(roomId, [
      `Call: ${call?.isConnected ? "connected" : "not connected"}`,
      status ? `Playback: ${status.playing ? "playing" : "idle"}, queue ${status.queueLength}, volume ${status.volumePercent}%, shuffle ${status.shuffle ? "on" : "off"}, autoplay ${status.autoplay ? "on" : "off"}` : "Playback: no session",
    ].join("\n"));
  }

  private formatSelection(title: string, items: SelectionItem[]): string {
    return [title, ...items.slice(0, 5).map((item, index) => `${index + 1}. ${item.title} — ${item.subtitle}`)].join("\n");
  }

  private parseSwitch(value: string): boolean {
    const normalized = value.toLowerCase();
    if (normalized === "on" || normalized === "true" || normalized === "1") return true;
    if (normalized === "off" || normalized === "false" || normalized === "0") return false;
    throw new Error("Use on or off.");
  }

  private async reply(roomId: string, body: string): Promise<void> {
    await this.runtime.sendText(roomId, body);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all([...this.sessions.values()].map((session) => session.stop(true)));
    this.sessions.clear();
    this.pendingSelections.clear();
    await this.rtcManager.stopAll();
  }
}
