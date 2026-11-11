import path from "node:path";
import { z } from "zod";

const matrixUserId = z.string().regex(/^@[^:\s]+:[^:\s]+$/, "Expected a Matrix user ID such as @bot:example.org");
const matrixRoomId = z.string().regex(/^![^\s,]+$/, "Expected an opaque Matrix room ID starting with !");
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash;
  }, "Expected an HTTP(S) base URL without credentials, query, or fragment")
  .transform((value) => value.replace(/\/+$/, ""));

function list(parser: z.ZodString, required: boolean) {
  return z
    .string()
    .optional()
    .transform((value) => [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))])
    .pipe(z.array(parser))
    .refine((entries) => !required || entries.length > 0, required ? "At least one entry is required" : undefined);
}

function integer(defaultValue: number, minimum: number, maximum: number) {
  return z.preprocess(
    (value) => {
      if (value === undefined) return defaultValue;
      if (typeof value === "string" && !/^\d+$/.test(value.trim())) return Number.NaN;
      return Number(value);
    },
    z.number().int().min(minimum).max(maximum),
  );
}

function boolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (["true", "1", "yes", "on"].includes(value.trim().toLowerCase())) return true;
      if (["false", "0", "no", "off"].includes(value.trim().toLowerCase())) return false;
    }
    return value;
  }, z.boolean());
}

const requiredTrue = z.preprocess((value) => {
  if (value === undefined) return true;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.literal(true, { error: "This security setting must remain true" }));

const schema = z.object({
  MATRIX_HOMESERVER: httpUrl,
  MATRIX_USER_ID: matrixUserId,
  MATRIX_DEVICE_ID: z.string().trim().min(1).max(255),
  MATRIX_ACCESS_TOKEN: z.string().min(1),
  MATRIX_ADMIN_USER_IDS: list(matrixUserId, true),
  MATRIX_ROOM_IDS: list(matrixRoomId, false),
  MATRIX_AUTO_ACCEPT_INVITES: boolean(true),
  MATRIX_REQUIRE_E2EE: requiredTrue,
  DATA_DIR: z
    .string()
    .default("./data")
    .transform((value) => path.resolve(value)),
  MATRIX_CRYPTO_STORE_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase()),
  MATRIX_CRYPTO_DATABASE_PREFIX: z.string().regex(/^[A-Za-z0-9._-]+$/).default("musicbot-matrix-subsonic"),
  MATRIX_CRYPTO_ORIGIN: z.string().url().default("https://musicbot.example.org"),
  MATRIX_RTC_MEMBERSHIP_MODE: z.enum(["sticky", "legacy"]).default("sticky"),
  SUBSONIC_URL: httpUrl,
  SUBSONIC_USERNAME: z.string().min(1),
  SUBSONIC_PASSWORD: z.string().min(1),
  COMMAND_PREFIX: z.string().trim().min(1).max(8).default("!"),
  MAX_ACTIVE_CALLS: integer(4, 1, 32),
  MAX_QUEUE_SIZE: integer(1000, 1, 10000),
  MAX_COLLECTION_TRACKS: integer(500, 1, 5000),
  MAX_PENDING_SELECTIONS: integer(20, 1, 100),
  QUEUE_PAGE_SIZE: integer(10, 1, 30),
  HTTP_TIMEOUT_MS: integer(15000, 100, 120000),
  RTC_JOIN_TIMEOUT_MS: integer(30000, 1000, 180000),
  PLAYBACK_START_TIMEOUT_MS: integer(20000, 1000, 180000),
  PLAYBACK_STALL_TIMEOUT_MS: integer(30000, 1000, 300000),
  ALONE_TIMEOUT_MS: integer(60000, 1000, 3600000),
  PLAYBACK_IDLE_TIMEOUT_MS: integer(600000, 1000, 86400000),
  FFMPEG_KILL_GRACE_MS: integer(1000, 50, 30000),
  FFMPEG_KILL_TIMEOUT_MS: integer(3000, 50, 30000),
  RECONNECT_MAX_DELAY_MS: integer(30000, 1000, 300000),
  LIVEKIT_AUDIO_QUEUE_MS: integer(100, 20, 500),
  LIVEKIT_AUDIO_BITRATE_KBPS: integer(48, 12, 2000),
  AUTOPLAY_BATCH_SIZE: integer(10, 1, 50),
  DEFAULT_VOLUME_PERCENT: integer(50, 0, 200),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppConfig = z.output<typeof schema>;

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  return schema.parse(env);
}
