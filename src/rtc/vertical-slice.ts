import type { AppConfig } from "../config/schema.js";
import type { MatrixRuntime } from "../matrix/runtime.js";
import { type AppLogger } from "../util/logger.js";
import { sanitizeForLog } from "../util/sanitize.js";
import { prepareLoopbackReceiver, type LoopbackReceiver } from "./loopback.js";
import { RtcCallManager } from "./manager.js";
import { streamStereoTestSignal } from "./test-signal.js";

export interface RtcVerticalSliceOptions {
  wrongKeyControl?: boolean;
  loopbackCheck?: boolean;
  signal?: AbortSignal;
}

export async function runRtcVerticalSlice(
  runtime: MatrixRuntime,
  config: AppConfig,
  logger: AppLogger,
  roomId: string,
  durationSeconds: number,
  options: RtcVerticalSliceOptions = {},
): Promise<void> {
  const manager = new RtcCallManager(runtime, config, logger);
  let loopbackReceiver: LoopbackReceiver | undefined;
  try {
    const call = await manager.join(roomId, {}, { wrongKeyControl: options.wrongKeyControl === true });
    if (options.loopbackCheck === true) loopbackReceiver = await prepareLoopbackReceiver(call);
    const report = sanitizeForLog({
      matrixRoom: roomId,
      trackSid: call.publishedTrackSid,
      livekitRoom: call.livekitRoomName,
      remoteParticipants: call.remoteParticipantCount,
      stereo: true,
      sampleRate: 48000,
      channels: 2,
      wrongKeyControl: options.wrongKeyControl === true,
      loopbackCheck: options.loopbackCheck === true,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const publicationPromise = streamStereoTestSignal(call, durationSeconds, options.signal);
    const loopbackPromise = loopbackReceiver ? loopbackReceiver.waitForAudio() : Promise.resolve(undefined);
    const [frames, loopbackAudio] = await Promise.all([publicationPromise, loopbackPromise]);
    process.stdout.write(`${JSON.stringify({ result: "published", frames, durationSeconds, loopbackAudio })}\n`);
  } finally {
    await loopbackReceiver?.close();
    await manager.stopAll();
  }
}
