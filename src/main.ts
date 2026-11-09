import { pino } from "pino";
import { loadConfig } from "./config/load.js";
import type { AppConfig } from "./config/schema.js";
import { DeviceState } from "./matrix/device-state.js";
import { initializeIndexedDb } from "./matrix/indexeddb.js";
import type { MatrixRuntime } from "./matrix/runtime.js";
import { SubsonicClient } from "./subsonic/client.js";
import { ensureWritableDirectory } from "./util/fs.js";
import { ffmpegVersion } from "./util/ffmpeg.js";
import { createLogger, type AppLogger } from "./util/logger.js";
import { sanitizeForLog, sanitizedError } from "./util/sanitize.js";

function parseDuration(args: string[]): number {
  const argument = args.find((value) => value.startsWith("--duration="));
  if (!argument) return 60;
  const duration = Number(argument.slice("--duration=".length));
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) throw new Error("--duration must be an integer from 5 to 600 seconds");
  return duration;
}

async function doctor(runtime: MatrixRuntime, config: AppConfig, state: DeviceState, ffmpeg: string): Promise<void> {
  const crypto = runtime.matrixClient.getCrypto();
  if (!crypto) throw new Error("Rust crypto is unavailable");
  const identity = await runtime.matrixClient.whoami();
  const ownKeys = await crypto.getOwnDeviceKeys();
  const transports = await runtime.discoverTransports();
  const subsonic = await new SubsonicClient(config, runtime.fetchFn).ping();
  const report = sanitizeForLog({
    matrix: {
      userId: identity.user_id,
      deviceId: identity.device_id,
      ed25519Fingerprint: ownKeys.ed25519,
      crossSigningReady: await crypto.isCrossSigningReady(),
    },
    cryptoStore: {
      directory: state.cryptoDirectory,
      databasePrefix: config.MATRIX_CRYPTO_DATABASE_PREFIX,
      persistent: true,
    },
    rtcTransports: transports,
    subsonic: { reachable: true, version: subsonic.version },
    ffmpeg,
  }, [config.MATRIX_ACCESS_TOKEN, config.MATRIX_CRYPTO_STORE_KEY, config.SUBSONIC_PASSWORD]);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function execute(config: AppConfig, logger: AppLogger, args: string[]): Promise<void> {
  await ensureWritableDirectory(config.DATA_DIR);
  const ffmpeg = await ffmpegVersion();
  const state = new DeviceState(config);
  await state.acquire();
  await initializeIndexedDb(config, state);
  const { MatrixRuntime } = await import("./matrix/runtime.js");
  const runtime = new MatrixRuntime(config, logger);
  let resolveShutdown: () => void = () => undefined;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const shutdownController = new AbortController();
  const onSignal = (): void => {
    logger.info("Shutdown signal received");
    shutdownController.abort(new Error("Shutdown requested"));
    resolveShutdown();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const [command = "run", ...commandArgs] = args;
    if (command === "doctor") {
      await runtime.start({ joinConfiguredRooms: false });
      await doctor(runtime, config, state, ffmpeg);
      return;
    }
    if (command === "verify:device") {
      await runtime.start({ joinConfiguredRooms: false });
      const { verifyAdministratorDevice } = await import("./matrix/verification.js");
      const adminUserId = commandArgs[0] ?? config.MATRIX_ADMIN_USER_IDS[0];
      if (!adminUserId) throw new Error("No administrator user ID is configured");
      await verifyAdministratorDevice(runtime.matrixClient, config, logger, adminUserId, commandArgs[1]);
      return;
    }
    if (command === "rtc:vertical-slice") {
      const roomId = commandArgs[0];
      if (!roomId) throw new Error("Usage: npm run rtc:vertical-slice -- <room-id> [--duration=60] [--wrong-key-control] [--loopback-check]");
      await runtime.start();
      const { runRtcVerticalSlice } = await import("./rtc/vertical-slice.js");
      await runRtcVerticalSlice(runtime, config, logger, roomId, parseDuration(commandArgs), {
        wrongKeyControl: commandArgs.includes("--wrong-key-control"),
        loopbackCheck: commandArgs.includes("--loopback-check"),
        signal: shutdownController.signal,
      });
      return;
    }
    if (command === "rtc:matrix-receiver") {
      const roomId = commandArgs[0];
      const publisherDeviceId = commandArgs[1];
      if (!roomId || !publisherDeviceId) throw new Error("Usage: node dist/main.js rtc:matrix-receiver <room-id> <publisher-device-id>");
      await runtime.start();
      const { runMatrixReceiverCheck } = await import("./rtc/receiver-check.js");
      const stats = await runMatrixReceiverCheck(runtime, config, logger, roomId, publisherDeviceId);
      process.stdout.write(`${JSON.stringify(sanitizeForLog(stats, [config.MATRIX_ACCESS_TOKEN, config.MATRIX_CRYPTO_STORE_KEY, config.SUBSONIC_PASSWORD]), null, 2)}\n`);
      return;
    }
    if (command !== "run") throw new Error(`Unknown command: ${command}`);
    await runtime.start();
    const { MusicApplication } = await import("./commands/application.js");
    const application = new MusicApplication(runtime, config, logger);
    logger.info("Music bot service is running");
    await shutdown;
    await application.stop();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runtime.stop();
    await state.close();
  }
}

async function main(): Promise<void> {
  let logger: AppLogger | undefined;
  let secrets: string[] = [];
  try {
    const config = loadConfig();
    secrets = [config.MATRIX_ACCESS_TOKEN, config.MATRIX_CRYPTO_STORE_KEY, config.SUBSONIC_PASSWORD];
    logger = createLogger(config, pino.destination(2));
    await execute(config, logger, process.argv.slice(2));
  } catch (error) {
    const message = sanitizedError(error, secrets);
    if (logger) {
      logger.error({ error: sanitizeForLog(error, secrets) }, "Music bot stopped with an error");
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
}

await main();
