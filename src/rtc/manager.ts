import { dispose } from "@livekit/rtc-node";
import type { AppConfig } from "../config/schema.js";
import type { MatrixRuntime } from "../matrix/runtime.js";
import type { AppLogger } from "../util/logger.js";
import { RtcRoomCall, type RtcRoomCallEvents } from "./room-call.js";

export class RtcCallManager {
  private readonly calls = new Map<string, RtcRoomCall>();
  private readonly joining = new Map<string, Promise<RtcRoomCall>>();
  private stopped = false;

  constructor(
    private readonly runtime: MatrixRuntime,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {}

  get activeCount(): number {
    return this.calls.size;
  }

  get(roomId: string): RtcRoomCall | undefined {
    return this.calls.get(roomId);
  }

  async join(roomId: string, events: RtcRoomCallEvents = {}, options: { wrongKeyControl?: boolean } = {}): Promise<RtcRoomCall> {
    if (this.stopped) throw new Error("RTC manager is stopped");
    const existingJoin = this.joining.get(roomId);
    if (existingJoin) return existingJoin;
    const existing = this.calls.get(roomId);
    if (existing?.isConnected) return existing;
    if (!existing && this.calls.size >= this.config.MAX_ACTIVE_CALLS) {
      throw new Error(`Maximum active call count (${this.config.MAX_ACTIVE_CALLS}) reached`);
    }

    const call = new RtcRoomCall(roomId, this.runtime, this.config, this.logger, {
      ...events,
      onClosed: (reason) => {
        this.calls.delete(roomId);
        events.onClosed?.(reason);
      },
    });
    this.calls.set(roomId, call);
    const joinPromise = call.join(options).then(() => call);
    this.joining.set(roomId, joinPromise);
    try {
      return await joinPromise;
    } catch (error) {
      if (this.calls.get(roomId) === call) this.calls.delete(roomId);
      throw error;
    } finally {
      this.joining.delete(roomId);
    }
  }

  async leave(roomId: string, reason?: string): Promise<void> {
    await this.calls.get(roomId)?.leave(reason);
    this.calls.delete(roomId);
  }

  async stopAll(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled([...this.calls.values()].map((call) => call.leave("Bot shutdown")));
    this.calls.clear();
    await dispose();
  }
}
