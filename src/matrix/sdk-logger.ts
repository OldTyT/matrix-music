import { logger as sdkRootLogger, type Logger as MatrixLogger } from "matrix-js-sdk/lib/logger.js";
import type { AppLogger } from "../util/logger.js";
import { sanitizeForLog } from "../util/sanitize.js";

export class MatrixSdkLogger implements MatrixLogger {
  constructor(
    private readonly logger: AppLogger,
    private readonly secrets: readonly string[] = [],
  ) {}

  trace(...messages: unknown[]): void {
    this.logger.trace({ matrix: sanitizeForLog(messages, this.secrets) });
  }

  debug(...messages: unknown[]): void {
    this.logger.debug({ matrix: sanitizeForLog(messages, this.secrets) });
  }

  info(...messages: unknown[]): void {
    this.logger.info({ matrix: sanitizeForLog(messages, this.secrets) });
  }

  warn(...messages: unknown[]): void {
    this.logger.warn({ matrix: sanitizeForLog(messages, this.secrets) });
  }

  error(...messages: unknown[]): void {
    this.logger.error({ matrix: sanitizeForLog(messages, this.secrets) });
  }

  getChild(namespace: string): MatrixSdkLogger {
    return new MatrixSdkLogger(this.logger.child({ namespace }), this.secrets);
  }
}

interface MutableRootLogger {
  methodFactory(methodName: string, logLevel: unknown, loggerName: string): (...messages: unknown[]) => void;
  rebuild(): void;
  setLevel(level: AppLogger["level"]): void;
}

export function configureMatrixRootLogger(logger: AppLogger, secrets: readonly string[], level: AppLogger["level"]): void {
  const matrixLogger = new MatrixSdkLogger(logger, secrets);
  const root = sdkRootLogger as unknown as MutableRootLogger;
  root.methodFactory = (methodName) => {
    return (...messages) => {
      if (methodName === "trace") matrixLogger.trace(...messages);
      else if (methodName === "debug") matrixLogger.debug(...messages);
      else if (methodName === "warn") matrixLogger.warn(...messages);
      else if (methodName === "error") matrixLogger.error(...messages);
      else matrixLogger.info(...messages);
    };
  };
  root.setLevel(level);
  root.rebuild();
}
