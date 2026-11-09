import path from "node:path";
import type { AppConfig } from "../config/schema.js";
import { ensureWritableDirectory } from "../util/fs.js";
import type { DeviceState } from "./device-state.js";

interface ShimIndexedDb {
  __useShim(): void;
  __setConnectionQueueOrigin(origin?: string): void;
}

export async function initializeIndexedDb(config: AppConfig, state: DeviceState): Promise<void> {
  const systemDirectory = path.join(state.indexedDbDirectory, "system");
  await ensureWritableDirectory(systemDirectory);
  Object.defineProperty(globalThis, "location", {
    value: new URL(config.MATRIX_CRYPTO_ORIGIN),
    configurable: true,
    enumerable: false,
    writable: false,
  });
  const { default: setGlobalVars } = await import("indexeddbshim");
  setGlobalVars(globalThis, {
    databaseBasePath: state.indexedDbDirectory,
    sysDatabaseBasePath: systemDirectory,
    avoidAutoShim: false,
  });
  const shim = (globalThis as typeof globalThis & { shimIndexedDB?: ShimIndexedDb }).shimIndexedDB;
  if (!shim) throw new Error("IndexedDB shim initialization failed");
  shim.__useShim();
  shim.__setConnectionQueueOrigin(config.MATRIX_CRYPTO_ORIGIN);
  if (!globalThis.indexedDB || !globalThis.IDBKeyRange) {
    throw new Error("IndexedDB globals are unavailable after shim initialization");
  }
}
