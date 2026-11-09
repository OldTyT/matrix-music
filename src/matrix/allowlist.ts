import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import { readJsonFile, writeJsonAtomic } from "../util/fs.js";

const persistedSchema = z.object({
  version: z.literal(1),
  roomIds: z.array(z.string().regex(/^![^\s,]+$/)),
});

export class RoomAllowlist {
  private readonly filePath: string;
  private readonly staticRooms: Set<string>;
  private readonly authorizedRooms = new Set<string>();

  constructor(config: AppConfig) {
    this.filePath = path.join(config.DATA_DIR, "authorized-rooms.json");
    this.staticRooms = new Set(config.MATRIX_ROOM_IDS);
  }

  async load(): Promise<void> {
    const persisted = await readJsonFile<unknown>(this.filePath);
    if (persisted === undefined) return;
    const parsed = persistedSchema.parse(persisted);
    for (const roomId of parsed.roomIds) this.authorizedRooms.add(roomId);
  }

  isAuthorized(roomId: string): boolean {
    return this.staticRooms.has(roomId) || this.authorizedRooms.has(roomId);
  }

  async authorize(roomId: string): Promise<void> {
    if (this.isAuthorized(roomId)) return;
    const roomIds = [...this.authorizedRooms, roomId].sort();
    await writeJsonAtomic(this.filePath, { version: 1, roomIds });
    this.authorizedRooms.add(roomId);
  }

  rooms(): string[] {
    return [...new Set([...this.staticRooms, ...this.authorizedRooms])].sort();
  }
}
