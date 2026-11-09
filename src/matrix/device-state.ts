import { promises as fs } from "node:fs";
import path from "node:path";
import { lock } from "proper-lockfile";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import { ensureWritableDirectory, readJsonFile, writeJsonAtomic } from "../util/fs.js";

const metadataSchema = z.object({
  version: z.literal(1),
  homeserver: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  cryptoDatabasePrefix: z.string(),
  cryptoOrigin: z.string().url(),
});

export class DeviceState {
  readonly cryptoDirectory: string;
  readonly indexedDbDirectory: string;
  private readonly metadataPath: string;
  private readonly lockTarget: string;
  private release: (() => Promise<void>) | undefined;

  constructor(private readonly config: AppConfig) {
    this.cryptoDirectory = path.join(config.DATA_DIR, "crypto");
    this.indexedDbDirectory = path.join(this.cryptoDirectory, "indexeddb");
    this.metadataPath = path.join(this.cryptoDirectory, "device.json");
    this.lockTarget = path.join(this.cryptoDirectory, ".lock-target");
  }

  async acquire(): Promise<void> {
    if (this.release) throw new Error("Crypto directory lock is already held by this process");
    await ensureWritableDirectory(this.cryptoDirectory);
    await ensureWritableDirectory(this.indexedDbDirectory);
    await fs.open(this.lockTarget, "a", 0o600).then((handle) => handle.close());
    this.release = await lock(this.lockTarget, {
      realpath: false,
      stale: 20_000,
      update: 5_000,
      retries: 0,
    });

    try {
      const expected: z.input<typeof metadataSchema> = {
        version: 1,
        homeserver: this.config.MATRIX_HOMESERVER,
        userId: this.config.MATRIX_USER_ID,
        deviceId: this.config.MATRIX_DEVICE_ID,
        cryptoDatabasePrefix: this.config.MATRIX_CRYPTO_DATABASE_PREFIX,
        cryptoOrigin: this.config.MATRIX_CRYPTO_ORIGIN,
      };
      const persisted = await readJsonFile<unknown>(this.metadataPath);
      if (persisted === undefined) {
        await writeJsonAtomic(this.metadataPath, expected);
      } else {
        const actual = metadataSchema.parse(persisted);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error("Persisted Matrix device metadata does not match the configured identity or crypto prefix");
        }
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    await release?.();
  }
}
