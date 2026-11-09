import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";

const responseSchema = z.object({
  "subsonic-response": z.object({
    status: z.string(),
    version: z.string().optional(),
    error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
  }).loose(),
}).loose();

export type SubsonicResponse = z.output<typeof responseSchema>["subsonic-response"] & Record<string, unknown>;

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
}

export interface MusicCollection {
  id: string;
  title: string;
  artist: string;
  kind: "album" | "playlist";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function trackMatchesQuery(track: MusicTrack, query: string, includeAlbum = false): boolean {
  const tokens = normalizedSearchText(query).split(" ").filter((token) => token.length > 1);
  const haystack = normalizedSearchText(includeAlbum ? `${track.artist} ${track.album} ${track.title}` : `${track.artist} ${track.title}`);
  return tokens.every((token) => haystack.includes(token));
}

export class SubsonicError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "SubsonicError";
  }
}

export class SubsonicClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: AppConfig, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.baseUrl = config.SUBSONIC_URL;
    this.username = config.SUBSONIC_USERNAME;
    this.password = config.SUBSONIC_PASSWORD;
    this.timeoutMs = config.HTTP_TIMEOUT_MS;
    this.fetchFn = fetchFn;
  }

  private authParameters(): Record<string, string> {
    const salt = randomBytes(16).toString("hex");
    return {
      u: this.username,
      t: createHash("md5").update(this.password + salt).digest("hex"),
      s: salt,
      v: "1.16.1",
      c: "musicbot-matrix-subsonic",
      f: "json",
    };
  }

  protected url(endpoint: string, parameters: Record<string, string | number> = {}): URL {
    const url = new URL(`${this.baseUrl}/rest/${endpoint}`);
    const entries = { ...this.authParameters(), ...parameters };
    for (const [key, value] of Object.entries(entries)) url.searchParams.set(key, String(value));
    return url;
  }

  protected async request(endpoint: string, parameters: Record<string, string | number> = {}, signal?: AbortSignal): Promise<SubsonicResponse> {
    const url = this.url(endpoint, parameters);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      throw new SubsonicError(`OpenSubsonic request failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new SubsonicError(`OpenSubsonic ${endpoint} returned HTTP ${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SubsonicError(`OpenSubsonic ${endpoint} returned invalid JSON`);
    }
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) throw new SubsonicError(`OpenSubsonic ${endpoint} returned an unsupported response`);
    const body = parsed.data["subsonic-response"];
    if (body.status !== "ok") {
      throw new SubsonicError(`OpenSubsonic ${endpoint} failed${body.error?.message ? `: ${body.error.message}` : ""}`, body.error?.code);
    }
    return body;
  }

  async ping(): Promise<{ version?: string }> {
    const response = await this.request("ping.view");
    return response.version === undefined ? {} : { version: response.version };
  }

  private parseTracks(value: unknown): MusicTrack[] {
    return asArray(value).map((entry) => {
      const track = asRecord(entry);
      return {
        id: String(track.id ?? ""),
        title: String(track.title ?? "Unknown title"),
        artist: String(track.artist ?? "Unknown artist"),
        album: String(track.album ?? "Unknown album"),
        durationSeconds: Number(track.duration ?? 0),
      };
    }).filter((track) => track.id.length > 0);
  }

  async searchSongs(query: string, limit: number): Promise<MusicTrack[]> {
    const response = await this.request("search3.view", { query, artistCount: 0, albumCount: 0, songCount: limit + 12 });
    const direct = this.parseTracks(asRecord(response.searchResult3).song).filter((track) => trackMatchesQuery(track, query));
    if (direct.length > 0) return direct.slice(0, limit);
    return this.searchSongsThroughAlbums(query, limit);
  }

  private async searchSongsThroughAlbums(query: string, limit: number): Promise<MusicTrack[]> {
    const albums = await this.searchAlbums(query, Math.max(limit, 3));
    const primaryMatches: MusicTrack[] = [];
    const secondaryMatches: MusicTrack[] = [];
    for (const album of albums) {
      if (primaryMatches.length >= limit) break;
      const tracks = await this.albumTracks(album.id, 50);
      for (const track of tracks) {
        if (trackMatchesQuery(track, query)) primaryMatches.push(track);
        else if (trackMatchesQuery(track, query, true)) secondaryMatches.push(track);
        if (primaryMatches.length >= limit) break;
      }
    }
    const matches = primaryMatches.length > 0 ? primaryMatches : secondaryMatches;
    return [...new Map(matches.map((track) => [track.id, track])).values()].slice(0, limit);
  }

  async searchAlbums(query: string, limit: number): Promise<MusicCollection[]> {
    const response = await this.request("search3.view", { query, artistCount: 0, albumCount: limit, songCount: 0 });
    return asArray(asRecord(response.searchResult3).album).map((entry) => {
      const album = asRecord(entry);
      return { id: String(album.id ?? ""), title: String(album.title ?? album.name ?? "Unknown album"), artist: String(album.artist ?? "Unknown artist"), kind: "album" as const };
    }).filter((album) => album.id.length > 0);
  }

  async listPlaylists(query: string, limit: number): Promise<MusicCollection[]> {
    const response = await this.request("getPlaylists.view");
    return asArray(asRecord(response.playlists).playlist).map((entry) => {
      const playlist = asRecord(entry);
      return { id: String(playlist.id ?? ""), title: String(playlist.name ?? "Unknown playlist"), artist: String(playlist.owner ?? "Playlist"), kind: "playlist" as const };
    }).filter((playlist) => {
      return playlist.id.length > 0 && playlist.title.toLowerCase().includes(query.toLowerCase());
    }).slice(0, limit);
  }

  async albumTracks(albumId: string, limit: number): Promise<MusicTrack[]> {
    const response = await this.request("getAlbum.view", { id: albumId });
    return this.parseTracks(asRecord(response.album).song).slice(0, limit);
  }

  async playlistTracks(playlistId: string, limit: number): Promise<MusicTrack[]> {
    const response = await this.request("getPlaylist.view", { id: playlistId });
    return this.parseTracks(asRecord(response.playlist).entry).slice(0, limit);
  }

  async randomTracks(limit: number, excludedIds: readonly string[]): Promise<MusicTrack[]> {
    const response = await this.request("getRandomSongs.view", { size: limit + excludedIds.length });
    return this.parseTracks(asRecord(response.randomSongs).song).filter((track) => !excludedIds.includes(track.id)).slice(0, limit);
  }

  streamUrl(trackId: string): string {
    return this.url("stream.view", { id: trackId }).toString();
  }
}
