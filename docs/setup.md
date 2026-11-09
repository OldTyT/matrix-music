# Complete setup and credential guide

This guide describes the complete setup flow for the music bot: creating the Matrix identity, issuing the long-lived bot token, configuring the OpenSubsonic media server user, authorizing rooms, verifying the bot device, and validating the deployment.

A shorter quick-start version is available in [README](../README.md). This document is the detailed source of truth for setup and credentials.

## 1. Actors and access model

| Actor | Purpose | Required access |
|---|---|---|
| Matrix administrator | Creates the bot account, invites the bot, verifies its device, and manages room power levels | Normal Element administrator account; no bot admin token is stored |
| `musicbot` Matrix account | Dedicated runtime identity | SSO-provisioned account plus a dedicated MAS compatibility token |
| `MUSICBOTDEVICE` Matrix device | Stable crypto/device identity used by the Docker process | Created by `mas-cli manage issue-compatibility-token` |
| OpenSubsonic user | Searches and streams music through the compatible media server | Unprivileged user with library/search/stream permissions |
| Docker host user | Owns the checkout and local `data/` directory | Normal Docker and Docker Compose access |

Do not place the Matrix administrator password, administrator access token, MAS admin token, or recovery keys in `.env`.

## 2. Create the Matrix account through Authentik OIDC

The supported identity flow is **Authentik → MAS → Synapse**. The Matrix account must be linked to an Authentik OIDC user.

1. In Authentik Admin, open **Directory → Users → Create**.
2. Create the user:
   - **Username:** `musicbot`;
   - **Name:** `Music Bot`;
   - **Email:** optional, according to your Authentik policy;
   - **Active:** enabled;
   - **Staff** and **Superuser:** disabled;
   - **Password:** set a strong random password with **Set password**.
3. Open the existing Matrix/Synapse application in **Applications → Applications**.
4. If the application uses policy or group bindings, add `musicbot` to the allowed group or create a user binding. Do not create a second OIDC provider.
5. Open Element Web in a private browser window so the current administrator SSO session is not reused.
6. Select the homeserver and sign in through SSO as `musicbot`.
7. Complete the first login. MAS/Synapse provisions the Matrix account automatically.
8. In Element settings, copy the exact Matrix user ID. It must look like:

   ```text
   @musicbot:matrix.example.org
   ```

9. Close the browser window. The browser session is only needed to provision the account and must not be used as the bot credential.

Do not use `mas-cli register-user` or direct Synapse registration for this flow. Those create a local account that is not linked to the Authentik identity.

## 3. Create the dedicated bot device and access token

The bot needs a long-lived Matrix access token tied to a device ID that is not used by an interactive Element client.

1. Choose a unique device ID, for example:

   ```text
   MUSICBOTDEVICE
   ```

   If that ID was already used by an earlier bot attempt, choose a new one such as `MUSICBOTDEVICE2`.

2. On the MAS host, run:

   ```bash
   docker exec matrix_mas mas-cli manage issue-compatibility-token musicbot MUSICBOTDEVICE
   ```

3. The command prints a compatibility access token. Copy it immediately into your password manager or directly into `.env`. It is a secret and must not be committed, logged, screenshotted, or sent to chat.

4. Set these values:

   ```dotenv
   MATRIX_USER_ID=@musicbot:matrix.example.org
   MATRIX_DEVICE_ID=MUSICBOTDEVICE
   MATRIX_ACCESS_TOKEN=<compatibility-token-from-mas-cli>
   ```

5. Keep the device ID and crypto directory stable. Reusing a browser Element device ID with a new bot crypto store causes one-time-key and identity conflicts.

### Why not use the browser access token?

A browser OIDC token may be short-lived and can be refreshed or revoked independently of the bot. It is acceptable only for temporary troubleshooting. The MAS compatibility token is the supported long-lived bot credential.

### If the token is compromised

1. Stop the bot.
2. Issue a new compatibility token for a new device ID, such as `MUSICBOTDEVICE2`.
3. Update `MATRIX_DEVICE_ID` and `MATRIX_ACCESS_TOKEN`.
4. Rename or remove `data/crypto/` so the new device gets a fresh crypto store.
5. Restart the bot and verify the new fingerprint.
6. Revoke or expire the old MAS session through your MAS administration tooling if available.

## 4. Create the OpenSubsonic media server user

Any OpenSubsonic-compatible media server can be used. The user only needs music access; it does not need server administration.

1. In the media server's user management, create a dedicated user such as `musicbot`.
2. Grant permissions required for:
   - library browsing;
   - search;
   - album and playlist retrieval;
   - streaming;
   - random-song retrieval for autoplay, if autoplay will be used.
3. Do not grant server administration, file-system, or destructive permissions.
4. Set a strong random password.
5. Confirm the base URL used by the bot. It must be reachable from the Docker container:

   ```dotenv
   SUBSONIC_URL=http://media-server:5273
   SUBSONIC_USERNAME=musicbot
   SUBSONIC_PASSWORD=<media-server-password>
   ```

6. For Octo, external song discovery may require Octo `ENABLE_SEARCH_DISCOVERY=true` and `LASTFM_API_KEY`. Without a Last.fm key, the bot's external album fallback can still resolve and stream suitable results through Octo.

## 5. Create the local crypto-store key

The local Rust crypto database has its own encryption key, independent of Matrix and media-server passwords.

```bash
cd musicbot_matrix_subsonic
openssl rand -hex 32
```

Set:

```dotenv
MATRIX_CRYPTO_STORE_KEY=<64-hex-characters>
```

Rules:

- generate a new random value; do not reuse a placeholder;
- never commit it;
- never change it for an existing `data/` directory;
- back it up with the same care as the access token.

Changing `MATRIX_CRYPTO_DATABASE_PREFIX` or `MATRIX_CRYPTO_ORIGIN` after the first run has the same compatibility risk as changing the crypto key.

## 6. Configure administrators and room authorization

The bot distinguishes between Matrix room membership and bot authorization.

- **Room membership** means the bot account has joined the Matrix room.
- **Bot authorization** means the room is present in `MATRIX_ROOM_IDS` or persisted in `data/authorized-rooms.json`.
- Commands are accepted only in encrypted, authorized rooms and only from joined users.

### Configure administrators

Set the Matrix IDs that are allowed to invite and verify the bot:

```dotenv
MATRIX_ADMIN_USER_IDS=@admin:matrix.example.org,@second-admin:matrix.example.org
```

Use full Matrix user IDs, not display names.

### Authorize by static room ID

For permanently managed rooms, copy each room ID from the Element room URL or advanced room settings:

```dotenv
MATRIX_ROOM_IDS=!opaque-room-id,!another-room-id
```

The bot joins these rooms during startup.

### Authorize by invitation

1. Create or open an encrypted Matrix room.
2. Invite `@musicbot:matrix.example.org` from an account listed in `MATRIX_ADMIN_USER_IDS`.
3. Keep this setting enabled:

   ```dotenv
   MATRIX_AUTO_ACCEPT_INVITES=true
   ```

4. The bot accepts the invitation while running and also processes pending invitations during startup.
5. The bot ignores invitations from non-administrators and invitations to unencrypted rooms.
6. After joining, the bot stores the room ID in `data/authorized-rooms.json`.

If room membership state changes later, the persisted authorization can be removed by editing that file while the bot is stopped.

### Required room properties

- End-to-end encryption must be enabled.
- The bot must have joined membership.
- Users sending commands must also have joined membership.
- MatrixRTC membership state events must be allowed for the bot. If the bot reports `MatrixRTC membership forbidden`, adjust the room power levels or server policy.

## 7. Create and validate `.env`

Create the file from the template:

```bash
cp .env.example .env
chmod 600 .env
mkdir -p data
chmod 700 data
```

Annotated template:

```dotenv
MATRIX_HOMESERVER=https://matrix.example.org
MATRIX_USER_ID=@musicbot:matrix.example.org
MATRIX_DEVICE_ID=MUSICBOTDEVICE
MATRIX_ACCESS_TOKEN=<mas-compatibility-token>
MATRIX_ADMIN_USER_IDS=@admin:matrix.example.org
MATRIX_ROOM_IDS=
MATRIX_AUTO_ACCEPT_INVITES=true
MATRIX_REQUIRE_E2EE=true

DATA_DIR=/var/lib/musicbot
MATRIX_CRYPTO_STORE_KEY=<64-hex-random-bytes>
MATRIX_CRYPTO_DATABASE_PREFIX=musicbot-matrix-subsonic
MATRIX_CRYPTO_ORIGIN=https://musicbot.example.org
MATRIX_RTC_MEMBERSHIP_MODE=legacy

SUBSONIC_URL=http://media-server:5273
SUBSONIC_USERNAME=musicbot
SUBSONIC_PASSWORD=<media-server-password>

COMMAND_PREFIX=!
MAX_ACTIVE_CALLS=4
LOG_LEVEL=info
```

Validate the file before starting the long-running service:

```bash
docker compose build
docker compose run --rm musicbot doctor
```

Expected checks:

- `whoami` matches `MATRIX_USER_ID` and `MATRIX_DEVICE_ID`;
- the Rust crypto store opens;
- the device fingerprint is printed;
- MatrixRTC transports are available;
- the OpenSubsonic media server answers `ping.view`;
- FFmpeg is available.

Only one process may use `data/` at a time. Stop the main service before running `doctor`, verification, or diagnostics.

## 8. Verify the bot device

Verification is recommended so other Matrix clients can reason about the bot's identity and E2EE sessions.

1. Stop the main service:

   ```bash
   docker compose stop
   ```

2. Start verification from the bot to an administrator device:

   ```bash
   docker compose run --rm musicbot verify:device @admin:matrix.example.org
   ```

3. If the administrator has multiple devices, select the intended device from the list or pass it explicitly:

   ```bash
   docker compose run --rm musicbot verify:device @admin:matrix.example.org ADMIN_DEVICE_ID
   ```

4. Accept the request in the administrator's Element client.
5. Compare emoji and decimal SAS values. Type `yes` only if they match exactly.
6. Save the printed bot Ed25519 fingerprint in your credential inventory.

For a brand-new account, the command initializes cross-signing only if no identity exists. An existing cross-signing identity is never reset automatically. If an identity already exists but is not locally trusted, recover it with an existing bot device or recovery material instead of replacing it.

## 9. Start and smoke-test the bot

```bash
docker compose up -d
docker compose logs -f --tail=100
```

In an encrypted authorized room:

1. Start Element Call with at least one human participant.
2. Send:

   ```text
   !status
   ```

3. Search and queue music:

   ```text
   !play Village People - YMCA
   ```

4. If multiple choices are returned, select one:

   ```text
   !select 1
   ```

5. Verify playback, then test:

   ```text
   !volume 75
   !queue
   !skip
   !stop
   ```

Use [docs/rtc-validation.md](rtc-validation.md) for the required encrypted Element Call acceptance test.

## 10. GHCR publishing credentials

No personal access token is required for the provided GitHub Actions workflow.

- Push to `main` publishes `ghcr.io/<owner>/<repository>:latest`.
- Manual workflow dispatch also creates a commit-SHA tag.
- GitHub Actions receives `GITHUB_TOKEN` with `packages: write` from the workflow permissions.
- The publishing workflow intentionally does not run lint, typecheck, or tests; normal validation is in `.github/workflows/ci.yml`.

## 11. Credential inventory checklist

Store these values in a secrets manager and record non-secret fingerprints separately:

| Credential | Created by | Stored in | Rotation effect |
|---|---|---|---|
| Authentik `musicbot` password | Authentik admin | Authentik secrets manager | Not used by the bot runtime |
| MAS compatibility token | `mas-cli manage issue-compatibility-token` | `.env` and secrets manager | Requires matching device ID and working crypto store |
| Matrix device ID | Operator choice passed to MAS CLI | `.env` | Must match token and crypto metadata |
| Matrix crypto-store key | `openssl rand -hex 32` | `.env` and encrypted backup | Changing it invalidates local crypto history |
| Media-server password | Media server admin | `.env` and secrets manager | Update `.env`; bot search/stream immediately uses the new value |
| Bot Ed25519 fingerprint | Rust crypto initialization | Credential inventory and verification record | Used to detect identity changes |
| Authorized room IDs | Bot/operator | `.env` or `data/authorized-rooms.json` | Removing access requires deleting the room authorization |

Never commit `.env`, `data/`, access tokens, OpenID tokens, LiveKit JWTs, media-server URLs containing credentials, or raw crypto material.
