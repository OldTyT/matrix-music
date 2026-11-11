# musicbot_matrix_subsonic

A music bot for encrypted Matrix rooms, Element Call/LiveKit, and an OpenSubsonic-compatible media server, such as Octo. It runs as a single TypeScript/Node.js process, uses persistent Rust crypto, and keeps a separate music queue for each room.

**Current status:** configuration, persistent crypto, `doctor`, SAS/emoji verification, Dockerfile, GHCR workflow, stereo/E2EE vertical slice, OpenSubsonic media server search, per-room queues, playback, and management commands are implemented. Positive audio and wrong-key controls passed on the current backend. A final two-human acceptance test remains mandatory before production use.

**Full setup and credential guide:** [docs/setup.md](docs/setup.md). It covers Authentik account creation, MAS compatibility-token issuance, media-server credentials, room authorization, device verification, rotation, and the credential inventory.

## 1. Requirements

- Docker Engine with the Docker Compose plugin.
- A Matrix homeserver with MatrixRTC/LiveKit support.
- Element Web with Element Call using per-participant media encryption.
- An existing OpenSubsonic-compatible media server, such as Octo.
- A dedicated Matrix account for the bot. Do not use an administrator account or administrator access token.
- A separate unprivileged OpenSubsonic media server user with library, discovery, and streaming access.

FFmpeg, Node.js 22.18.0, and the native LiveKit/SQLite/canvas dependencies are already included in the Docker image. They do not need to be installed on the host.

## 2. Matrix account, device ID, and access token

For the complete credential-creation and authorization runbook, see [docs/setup.md](docs/setup.md). The steps below are the quick-start version.

With the **Authentik → MAS → Synapse** flow, the user is created in Authentik, and the Matrix account is provisioned automatically on the first SSO login. Do not use `mas-cli register-user` or Synapse registration: they create a separate local account that is not linked to the Authentik OIDC identity.

1. In Authentik Admin, open **Directory → Users → Create** and create a user:
   - **Username:** `musicbot`;
   - **Name:** `Music Bot`;
   - keep the user active, without staff or superuser privileges;
   - set a separate random password using **Set password**.
2. Check access to the existing Matrix Application in Authentik. If **Applications → Applications → Matrix/Synapse → Policy bindings** restricts access, add `musicbot` to the allowed group or create a user binding. The OIDC provider, Client ID, and Client Secret do not need to be changed.
3. Sign in to Element Web once as `musicbot` through SSO to create the Matrix account. A private browser window is sufficient. The browser session is no longer needed afterward.
4. On the MAS host, issue a separate long-lived compatibility token for a new device:

   ```bash
   docker exec matrix_mas mas-cli manage issue-compatibility-token musicbot MUSICBOTDEVICE
   ```

5. Copy the issued token to `MATRIX_ACCESS_TOKEN` and `MUSICBOTDEVICE` to `MATRIX_DEVICE_ID`. Do not reuse the device ID of a browser Element session with a separate crypto store: that causes one-time-key conflicts. If the device ID was already used, select a new one, such as `MUSICBOTDEVICE2`, and clear or rename the crypto directory.
6. A browser OIDC access token extracted through Developer Tools is suitable only for temporary diagnostics because it may be short-lived. Use the compatibility token from step 4 for the permanent bot.

The administrator token, Matrix password, and MAS token are not required and must not be stored in `.env`.

## 3. Create `.env`

The full annotated template and credential inventory are in [docs/setup.md](docs/setup.md).

```bash
cd musicbot_matrix_subsonic
cp .env.example .env
openssl rand -hex 32
```

Copy the `openssl rand -hex 32` output to `MATRIX_CRYPTO_STORE_KEY`. This is a separate random key for the local Rust crypto store, not a Matrix or media-server password. Do not leave the placeholder value and do not change the key after the first run.

Minimal example for the current backend:

```dotenv
MATRIX_HOMESERVER=https://matrix.example.org
MATRIX_USER_ID=@musicbot:matrix.example.org
MATRIX_DEVICE_ID=DEVICE_ID_FROM_THE_BOT_SESSION
MATRIX_ACCESS_TOKEN=ACCESS_TOKEN_FROM_THE_BOT_SESSION
MATRIX_ADMIN_USER_IDS=@admin:matrix.example.org
MATRIX_ROOM_IDS=
MATRIX_AUTO_ACCEPT_INVITES=true
MATRIX_REQUIRE_E2EE=true

DATA_DIR=/var/lib/musicbot
MATRIX_CRYPTO_STORE_KEY=64_HEX_CHARACTERS_FROM_OPENSSL_RAND
MATRIX_CRYPTO_DATABASE_PREFIX=musicbot-matrix-subsonic
MATRIX_CRYPTO_ORIGIN=https://musicbot.example.org
MATRIX_RTC_MEMBERSHIP_MODE=legacy

SUBSONIC_URL=http://media-server:5273
SUBSONIC_USERNAME=musicbot
SUBSONIC_PASSWORD=SUBSONIC_USER_PASSWORD

COMMAND_PREFIX=!
MAX_ACTIVE_CALLS=4
LIVEKIT_AUDIO_BITRATE_KBPS=48
LOG_LEVEL=info
```

Protect the file:

```bash
chmod 600 .env
mkdir -p data
chmod 700 data
```

The container runs as UID/GID 1000. If `data` has a different owner:

```bash
sudo chown -R 1000:1000 data
```

### Required values

| Variable | Value |
|---|---|
| `MATRIX_HOMESERVER` | HTTPS homeserver base URL. A trailing slash is automatically removed. |
| `MATRIX_USER_ID` | Full ID of the dedicated bot, for example `@musicbot:matrix.example.org`. |
| `MATRIX_DEVICE_ID` | Stable device ID for the same session as the access token. |
| `MATRIX_ACCESS_TOKEN` | Access token for the dedicated bot. |
| `MATRIX_ADMIN_USER_IDS` | Comma-separated administrator IDs. Only their invitations are accepted automatically. |
| `MATRIX_CRYPTO_STORE_KEY` | Exactly 64 hexadecimal characters: 32 random bytes. Must remain stable across restarts. |
| `SUBSONIC_URL` | HTTP(S) OpenSubsonic media server base URL without query parameters or credentials. |
| `SUBSONIC_USERNAME` | Separate OpenSubsonic media server user. |
| `SUBSONIC_PASSWORD` | OpenSubsonic media server password; used only to calculate a salted request hash. |

### Rooms and crypto identity

- `MATRIX_ROOM_IDS` is an optional comma-separated list, for example `!abc:matrix.example.org,!def:matrix.example.org`. These rooms are joined during startup.
- When `MATRIX_ROOM_IDS` is empty, invite the bot as an administrator. With `MATRIX_AUTO_ACCEPT_INVITES=true`, the bot accepts invitations while running and pending invitations during startup. Invitations from users outside `MATRIX_ADMIN_USER_IDS` and invitations to unencrypted rooms are ignored.
- `MATRIX_REQUIRE_E2EE=true` is mandatory; plaintext mode is unsupported.
- `MATRIX_CRYPTO_DATABASE_PREFIX` and `MATRIX_CRYPTO_ORIGIN` must remain stable. Do not change them after creating the store.
- `MATRIX_RTC_MEMBERSHIP_MODE=legacy` is the tested mode for the current backend. Synapse 1.147 advertises sticky API support, but its delayed leave event can override the join in other clients' sticky stores. Use `legacy` for this deployment. `sticky` remains available for backends where sticky membership is verified by tests.

### Optional limits

All variables already have safe defaults in `.env.example`:

| Variable | Default |
|---|---:|
| `MAX_ACTIVE_CALLS` | `4` |
| `MAX_QUEUE_SIZE` | `1000` |
| `MAX_COLLECTION_TRACKS` | `500` |
| `MAX_PENDING_SELECTIONS` | `20` |
| `QUEUE_PAGE_SIZE` | `10` |
| `DEFAULT_VOLUME_PERCENT` | `50`, range 0–200 |
| `COMMAND_PREFIX` | `!` |
| `MATRIX_AUTO_ACCEPT_INVITES` | `true` |
| `HTTP_TIMEOUT_MS` | `15000` |
| `RTC_JOIN_TIMEOUT_MS` | `30000` |
| `PLAYBACK_START_TIMEOUT_MS` | `20000` |
| `PLAYBACK_STALL_TIMEOUT_MS` | `30000` |
| `ALONE_TIMEOUT_MS` | `60000` |
| `PLAYBACK_IDLE_TIMEOUT_MS` | `600000` |
| `FFMPEG_KILL_GRACE_MS` | `1000` |
| `FFMPEG_KILL_TIMEOUT_MS` | `3000` |
| `RECONNECT_MAX_DELAY_MS` | `30000` |
| `LIVEKIT_AUDIO_QUEUE_MS` | `100` |
| `LIVEKIT_AUDIO_BITRATE_KBPS` | `48`, range 12–2000 |
| `AUTOPLAY_BATCH_SIZE` | `10` |
| `LOG_LEVEL` | `info` |

`LIVEKIT_AUDIO_BITRATE_KBPS` sets the LiveKit Opus publisher cap in kilobits per second. The default `48` preserves the previous behavior. Values up to `2000` are accepted; in practice Opus/WebRTC commonly caps useful audio quality around 510 kbps, so values above that may not provide a further audible improvement.

## 4. Build and diagnostics

```bash
cd musicbot_matrix_subsonic
docker compose build
docker compose run --rm musicbot doctor
```

`doctor` checks:

- access-token identity through `whoami` and matching user/device IDs;
- opening the persistent Rust crypto store and the device fingerprint;
- cross-signing status;
- MatrixRTC transport availability;
- OpenSubsonic media server `ping.view`;
- FFmpeg.

The JSON output is sanitized to remove access tokens, OpenID/JWT values, salted URLs, and key material. Logs are written to stderr; the report is written to stdout.

**Only one process may use the crypto directory.** Stop the main container before another `doctor`, verification, or vertical-slice run:

```bash
docker compose stop
```

## 5. Run the bot

After a successful `doctor`:

```bash
docker compose up -d
docker compose logs -f --tail=100
```

While logs are open, invite `@musicbot:matrix.example.org` from `@admin:matrix.example.org` to an encrypted room. The bot joins and stores only the room authorization in `data/authorized-rooms.json`.

Stop and restart:

```bash
docker compose stop
docker compose up -d
```

Remove containers without deleting crypto state:

```bash
docker compose down
```

Do not delete `data/` or lose `MATRIX_CRYPTO_STORE_KEY`: the bot would lose its crypto identity and access to previously distributed keys. Queues and playback state are intentionally not persisted in `data/`.

## 6. Music commands

Commands are accepted only in encrypted authorized rooms and only from users with `join` membership. Old edits and plaintext events are ignored.

| Command | Action |
|---|---|
| `!play <search>` | Searches for up to five songs; one result is queued immediately, while multiple results create a numbered selection. |
| `!album <search>` | Searches albums and queues the selected album. |
| `!playlist <search>` | Searches playlists by name and queues the selected playlist. |
| `!select <1-5>` | Selects the current search result; available for two minutes and only to the user who created the search. |
| `!queue` | Shows the current track and the first page of the queue. |
| `!np` | Shows the current track. |
| `!skip` | Advances to the next track. |
| `!stop` | Stops playback and clears the queue. |
| `!volume [0-200]` | Shows or changes playback volume. |
| `!shuffle on|off` | Shuffles the queue; newly added tracks are also shuffled. |
| `!autoplay on|off` | Adds up to ten random tracks after the queue ends, excluding the last 50 tracks. |
| `!join` / `!leave` | Joins an existing Element Call or leaves only the bot's participation. |
| `!status` / `!help` | Shows state and command help. |

For Octo, the bot uses standard OpenSubsonic `search3`. Octo reserves small `songCount` values for the local library, so the bot requests an expanded budget but shows no more than five choices. If direct song search is empty, the bot falls back to external album search and `getAlbum`; playback still goes through Octo, including YouTube-resolved rows. Direct external song discovery inside Octo additionally requires `LASTFM_API_KEY`; without it, the album fallback remains available.

Each room has a separate queue, intentionally not persisted to disk. When an active Element Call exists, `!play` can be sent immediately; the bot joins the existing call by itself.

## 7. Device verification

Stop the main container, then run:

```bash
docker compose run --rm musicbot verify:device @admin:matrix.example.org
```

If the administrator has multiple devices, the command presents a list. A device ID can also be provided explicitly:

```bash
docker compose run --rm musicbot verify:device @admin:matrix.example.org ADMIN_DEVICE_ID
```

Accept the request in the administrator's Element client and confirm `yes` only when the emoji and decimal SAS values match exactly. For a new account, the command creates a cross-signing identity only when none exists. An existing identity is never reset; if it exists but is not locally trusted, use an existing bot device or recovery instead of resetting keys.

## 8. Required Element Call validation

Two people are required in one encrypted room with an already-running Element Call. Do not enable call-password or shared-key mode.

```bash
docker compose stop
docker compose run --rm musicbot rtc:vertical-slice '!ROOM_ID:matrix.example.org' --duration=60
```

The expected channels are independent tones: 440 Hz on the left and 880 Hz on the right. After success, run the wrong-key negative control:

```bash
docker compose run --rm musicbot rtc:vertical-slice '!ROOM_ID:matrix.example.org' --duration=30 --wrong-key-control
```

Detailed checklist: [docs/rtc-validation.md](docs/rtc-validation.md).

After validation, start the main process again:

```bash
docker compose up -d
```

## 9. Publish the image to GHCR

`.github/workflows/docker-publish.yml` publishes `ghcr.io/<owner>/<repository>:latest` whenever a commit is pushed to `main`. Manual workflow dispatch is also supported and produces an additional commit-SHA tag. The workflow contains no lint, typecheck, or test steps. Normal validation is separate in `.github/workflows/ci.yml`.

The workflow uses `GITHUB_TOKEN` with `packages: write`; a separate PAT is not required. The image is built for `linux/amd64`.

## Troubleshooting

- **Identity mismatch in `doctor`:** the access token, `MATRIX_USER_ID`, and `MATRIX_DEVICE_ID` came from different sessions.
- **Crypto directory is locked:** stop another container or process using the same `data/` directory. Do not run the main service and CLI simultaneously.
- **Invitation ignored:** the inviter is not an administrator, the room is not encrypted, or `MATRIX_AUTO_ACCEPT_INVITES=false`. With auto-accept enabled, pending invitations are processed after the initial sync.
- **No active Element Call:** start the call in Element Web before running the vertical slice.
- **No local-homeserver LiveKit transport:** check RTC discovery on the homeserver; federation or multi-SFU transport is not selected automatically.
- **`m.livekit`-only discovery:** the backend is incompatible with per-participant MatrixRTC media encryption; no plaintext fallback is performed.
- **MatrixRTC membership forbidden:** an administrator must allow the bot to send call membership state events; sticky API fallback does not solve a power-level error.
- **Participant is visible but sticky-mode audio is silent:** set `MATRIX_RTC_MEMBERSHIP_MODE=legacy`. In the current Synapse/MAS deployment, sticky delayed leave can hide the join from other participants.
- **LiveKit/MatrixRTC identity mismatch:** this is a compatibility or security blocker, not a reason to disable E2EE.
- **OpenSubsonic media server request failed:** check the URL, dedicated user, password, and API availability from inside the container.
- **`!play` returns `No songs found` on Octo:** check `ENABLE_SEARCH_DISCOVERY=true`; direct external song search requires `LASTFM_API_KEY`. Without a Last.fm key, the external album fallback remains available, but very specific queries may not resolve.
- **`data/` permissions:** the directory must be writable by UID/GID 1000. If Docker created it as `root`, run `docker run --rm -v "$PWD/data:/data" node:22.18.0-bookworm-slim chown 1000:1000 /data`.
- **`EACCES ... /app/data`:** update `compose.yml`. Production Compose forces `/var/lib/musicbot`, regardless of an older `DATA_DIR=./data` value in `.env`.
