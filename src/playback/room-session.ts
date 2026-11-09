import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { AudioFrame } from "@livekit/rtc-node";
import type { AppConfig } from "../config/schema.js";
import type { MusicTrack, SubsonicClient } from "../subsonic/client.js";
import type { RtcRoomCall } from "../rtc/room-call.js";
import type { AppLogger } from "../util/logger.js";
import { withTimeout } from "../util/time.js";

export interface PlaybackStatus {
  playing: boolean;
  currentTrack: MusicTrack | undefined;
  queueLength: number;
  volumePercent: number;
  shuffle: boolean;
  autoplay: boolean;
}

export function applyVolume(samples: Int16Array, volumePercent: number): Int16Array {
  const gain = Math.min(Math.max(volumePercent, 0), 200) / 100;
  if (gain === 1) return samples;
  const adjusted = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    adjusted[index] = Math.max(-32768, Math.min(32767, Math.round((samples[index] ?? 0) * gain)));
  }
  return adjusted;
}

export class PlaybackRoomSession {
  private readonly queue: MusicTrack[] = [];
  private readonly recentTrackIds: string[] = [];
  private currentTrack: MusicTrack | undefined;
  private currentChild: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private generation = 0;
  private workerRunning = false;
  private volumePercent: number;
  private shuffle = false;
  private autoplay = false;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly call: RtcRoomCall,
    private readonly subsonic: SubsonicClient,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {
    this.volumePercent = config.DEFAULT_VOLUME_PERCENT;
  }

  get isPlaying(): boolean {
    return this.currentTrack !== undefined;
  }

  enqueue(tracks: MusicTrack[]): number {
    const accepted = tracks.slice(0, Math.max(this.config.MAX_QUEUE_SIZE - this.queue.length - (this.currentTrack ? 1 : 0), 0));
    if (accepted.length === 0 && tracks.length > 0) throw new Error(`Queue is full (${this.config.MAX_QUEUE_SIZE} tracks)`);
    if (this.shuffle) accepted.sort(() => Math.random() - 0.5);
    this.queue.push(...accepted);
    for (const track of accepted.slice(-50)) {
      this.recentTrackIds.push(track.id);
      if (this.recentTrackIds.length > 50) this.recentTrackIds.shift();
    }
    this.clearIdleTimer();
    void this.startWorker();
    return accepted.length;
  }

  async skip(): Promise<boolean> {
    this.generation += 1;
    this.call.clearAudioQueue();
    await this.killCurrentChild();
    return this.queue.length > 0;
  }

  async stop(clearQueue = true): Promise<void> {
    this.generation += 1;
    if (clearQueue) this.queue.length = 0;
    this.currentTrack = undefined;
    this.call.clearAudioQueue();
    await this.killCurrentChild();
    this.scheduleIdleTimer();
  }

  setVolume(percent: number): void {
    if (!Number.isInteger(percent) || percent < 0 || percent > 200) throw new Error("Volume must be an integer from 0 to 200");
    this.volumePercent = percent;
  }

  getVolume(): number {
    return this.volumePercent;
  }

  setShuffle(enabled: boolean): void {
    this.shuffle = enabled;
    if (enabled && this.queue.length > 1) this.queue.sort(() => Math.random() - 0.5);
  }

  getShuffle(): boolean {
    return this.shuffle;
  }

  async setAutoplay(enabled: boolean): Promise<void> {
    this.autoplay = enabled;
    if (enabled && !this.workerRunning) {
      this.clearIdleTimer();
      await this.startWorker();
    }
  }

  getAutoplay(): boolean {
    return this.autoplay;
  }

  status(): PlaybackStatus {
    return {
      playing: this.isPlaying,
      currentTrack: this.currentTrack,
      queueLength: this.queue.length,
      volumePercent: this.volumePercent,
      shuffle: this.shuffle,
      autoplay: this.autoplay,
    };
  }

  queuedTracks(limit: number): MusicTrack[] {
    return this.queue.slice(0, limit);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.call.leave("Playback queue is empty");
    }, this.config.PLAYBACK_IDLE_TIMEOUT_MS);
  }

  private async startWorker(): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (true) {
        if (!this.call.isConnected) return;
        let track = this.queue.shift();
        if (!track && this.autoplay) {
          const suggestions = await this.subsonic.randomTracks(this.config.AUTOPLAY_BATCH_SIZE, this.recentTrackIds);
          const accepted = this.enqueueWithoutStarting(suggestions);
          if (accepted.length > 0) track = this.queue.shift();
        }
        if (!track) {
          this.currentTrack = undefined;
          this.scheduleIdleTimer();
          return;
        }
        this.currentTrack = track;
        const generation = ++this.generation;
        try {
          await this.playTrack(track, generation);
        } catch (error) {
          if (this.generation === generation) {
            this.logger.warn({ roomId: this.call.roomId, trackId: track.id, error: error instanceof Error ? error.message : String(error) }, "Failed to play track");
          }
        } finally {
          if (this.generation === generation) this.currentTrack = undefined;
        }
      }
    } finally {
      this.workerRunning = false;
    }
  }

  private enqueueWithoutStarting(tracks: MusicTrack[]): MusicTrack[] {
    const fresh = tracks.filter((track) => !this.recentTrackIds.includes(track.id));
    const accepted = fresh.slice(0, Math.max(this.config.MAX_QUEUE_SIZE - this.queue.length, 0));
    this.queue.push(...accepted);
    for (const track of accepted) {
      this.recentTrackIds.push(track.id);
      if (this.recentTrackIds.length > 50) this.recentTrackIds.shift();
    }
    return accepted;
  }

  private async playTrack(track: MusicTrack, generation: number): Promise<void> {
    const url = this.subsonic.streamUrl(track.id);
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      "-re",
      "-i", url,
      "-vn",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    this.currentChild = child;

    let stderr = "";
    let writing = Promise.resolve();
    let writeError: Error | undefined;
    let lastDataAt = Date.now();
    const generationChanged = (): boolean => this.generation !== generation;

    const stallTimer = setInterval(() => {
      if (Date.now() - lastDataAt >= this.config.PLAYBACK_STALL_TIMEOUT_MS && !generationChanged()) {
        child.kill("SIGKILL");
      }
    }, 1000);
    stallTimer.unref();

    let buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (generationChanged()) return;
      lastDataAt = Date.now();
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 3840) {
        const bytes = buffer.subarray(0, 3840);
        buffer = buffer.subarray(3840);
        const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        writing = writing.then(async () => {
          if (!generationChanged()) {
            const adjusted = applyVolume(samples, this.volumePercent);
            await this.call.captureFrame(new AudioFrame(adjusted, 48000, 2, 960));
          }
        }).catch((error: unknown) => {
          writeError ??= error instanceof Error ? error : new Error(String(error));
          child.kill("SIGKILL");
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });

    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (generationChanged() || code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      });
    });

    try {
      await withTimeout(exit, Math.max((track.durationSeconds + 30) * 1000, 60000), `Playback of ${track.title}`);
      await withTimeout(writing, 5000, "Audio queue drain");
      if (writeError) throw writeError;
    } finally {
      clearInterval(stallTimer);
      if (this.currentChild === child) this.currentChild = undefined;
    }
  }

  private async killCurrentChild(): Promise<void> {
    const child = this.currentChild;
    this.currentChild = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await withTimeout(new Promise<void>((resolve) => child.once("close", () => resolve())), this.config.FFMPEG_KILL_TIMEOUT_MS, "FFmpeg stop").catch(async () => {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve())).catch(() => undefined);
    });
  }
}
