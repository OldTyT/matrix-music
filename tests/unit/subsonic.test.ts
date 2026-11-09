import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/config/schema.js";
import { SubsonicClient } from "../../src/subsonic/client.js";

function config() {
  return parseConfig({
    MATRIX_HOMESERVER: "https://matrix.example.org",
    MATRIX_USER_ID: "@bot:example.org",
    MATRIX_DEVICE_ID: "BOTDEVICE",
    MATRIX_ACCESS_TOKEN: "matrix-secret",
    MATRIX_ADMIN_USER_IDS: "@admin:example.org",
    MATRIX_CRYPTO_STORE_KEY: "ab".repeat(32),
    SUBSONIC_URL: "https://music.example.org",
    SUBSONIC_USERNAME: "bot",
    SUBSONIC_PASSWORD: "subsonic-secret",
  });
}

function response(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...body } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Subsonic client", () => {
  it("parses song search results", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response({
      searchResult3: {
        song: [{ id: "song-1", title: "Song", artist: "Artist", album: "Album", duration: 61 }],
      },
    })));
    const tracks = await new SubsonicClient(config()).searchSongs("song", 5);
    expect(tracks).toEqual([{ id: "song-1", title: "Song", artist: "Artist", album: "Album", durationSeconds: 61 }]);
  });

  it("falls back to external album tracks when direct results do not match", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      requested.push(url.pathname);
      if (url.pathname.endsWith("search3.view") && url.searchParams.get("albumCount") !== "0") {
        return response({ searchResult3: { album: [{ id: "album-1", title: "YMCA", artist: "Village People" }] } });
      }
      if (url.pathname.endsWith("getAlbum.view")) {
        return response({ album: { song: [{ id: "song-ymca", title: "YMCA", artist: "Village People", album: "YMCA", duration: 284 }] } });
      }
      return response({ searchResult3: { song: [{ id: "wrong", title: "My Roomate", artist: "Village People", album: "YMCA", duration: 325 }] } });
    }));
    const tracks = await new SubsonicClient(config()).searchSongs("Village People - YMCA", 5);
    expect(tracks).toEqual([{ id: "song-ymca", title: "YMCA", artist: "Village People", album: "YMCA", durationSeconds: 284 }]);
    expect(requested.filter((path) => path.endsWith("search3.view"))).toHaveLength(2);
    expect(requested).toContain("/rest/getAlbum.view");
  });

  it("parses albums and playlists and excludes recent random tracks", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("search3.view")) {
        return response({ searchResult3: { album: [{ id: "album-1", title: "Album", artist: "Artist" }] } });
      }
      if (url.pathname.endsWith("getPlaylists.view")) {
        return response({ playlists: { playlist: [{ id: "playlist-1", name: "Mix", owner: "example-user" }] } });
      }
      return response({ randomSongs: { song: [{ id: "old", title: "Old" }, { id: "new", title: "New" }] } });
    }));
    const client = new SubsonicClient(config());
    await expect(client.searchAlbums("album", 5)).resolves.toEqual([{ id: "album-1", title: "Album", artist: "Artist", kind: "album" }]);
    await expect(client.listPlaylists("mix", 5)).resolves.toEqual([{ id: "playlist-1", title: "Mix", artist: "example-user", kind: "playlist" }]);
    await expect(client.randomTracks(1, ["old"])).resolves.toEqual([{ id: "new", title: "New", artist: "Unknown artist", album: "Unknown album", durationSeconds: 0 }]);
  });
});
