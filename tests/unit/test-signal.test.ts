import { describe, expect, it } from "vitest";
import { stereoTestFrame } from "../../src/rtc/test-signal.js";

describe("stereo vertical-slice signal", () => {
  it("generates exact 20 ms stereo frames with different channels", () => {
    const frame = stereoTestFrame(3);
    expect(frame.sampleRate).toBe(48000);
    expect(frame.channels).toBe(2);
    expect(frame.samplesPerChannel).toBe(960);
    expect(frame.data).toHaveLength(1920);
    expect(frame.data.byteLength).toBe(3840);
    const left = frame.data.filter((_, index) => index % 2 === 0);
    const right = frame.data.filter((_, index) => index % 2 === 1);
    expect(left).not.toEqual(right);
    expect(left.some((sample) => sample !== 0)).toBe(true);
    expect(right.some((sample) => sample !== 0)).toBe(true);
  });
});
