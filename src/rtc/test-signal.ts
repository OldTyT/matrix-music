import { AudioFrame } from "@livekit/rtc-node";
import type { RtcRoomCall } from "./room-call.js";

export function stereoTestFrame(frameIndex: number): AudioFrame {
  const samplesPerChannel = 960;
  const data = new Int16Array(samplesPerChannel * 2);
  for (let index = 0; index < samplesPerChannel; index += 1) {
    const time = (frameIndex * samplesPerChannel + index) / 48000;
    data[index * 2] = Math.round(Math.sin(2 * Math.PI * 440 * time) * 6553);
    data[index * 2 + 1] = Math.round(Math.sin(2 * Math.PI * 880 * time) * 6553);
  }
  return new AudioFrame(data, 48000, 2, samplesPerChannel);
}

export async function streamStereoTestSignal(call: RtcRoomCall, durationSeconds: number, signal?: AbortSignal): Promise<number> {
  const frameCount = durationSeconds * 50;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    if (signal?.aborted) throw signal.reason;
    await call.captureFrame(stereoTestFrame(frameIndex));
  }
  if (signal?.aborted) throw signal.reason;
  await call.waitForPlayout();
  return frameCount;
}
