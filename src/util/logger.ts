import { pino, type Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { sanitizeForLog } from "./sanitize.js";

export type AppLogger = Logger;

export function configSecrets(config: AppConfig): string[] {
  return [config.MATRIX_ACCESS_TOKEN, config.MATRIX_CRYPTO_STORE_KEY, config.SUBSONIC_PASSWORD];
}

export function createLogger(config: AppConfig, destination?: pino.DestinationStream): AppLogger {
  const secrets = configSecrets(config);
  return pino(
    {
      level: config.LOG_LEVEL,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log(record) {
          return sanitizeForLog(record, secrets);
        },
      },
    },
    destination,
  );
}
