import { spawn } from "node:child_process";

export async function ffmpegVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg -version timed out"));
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 16384) output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 4096) errors += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`FFmpeg is unavailable: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg -version exited with code ${code}: ${errors}`));
        return;
      }
      resolve(output.split("\n")[0] ?? "ffmpeg version unknown");
    });
  });
}
