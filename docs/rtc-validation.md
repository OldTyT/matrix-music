# MatrixRTC/LiveKit vertical-slice validation

Current status: unit checks, a real positive stereo test, and the wrong-key negative control passed on the current backend. Use `MATRIX_RTC_MEMBERSHIP_MODE=legacy` for the current Synapse/MAS deployment: the sticky delayed leave can hide the join from other participants. A final check with two people hearing each other remains mandatory.

## Preparation

1. Complete [docs/setup.md](setup.md), including Matrix credentials, room authorization, media-server credentials, and `doctor`.
2. Set `MATRIX_RTC_MEMBERSHIP_MODE=legacy` for the current backend.
3. Ensure that an administrator invited the bot account and that the bot joined the encrypted room.
4. Start Element Call in that room from Element Web.
5. Add two people with working microphones and headphones. Verify that they can hear each other before starting the bot.
6. Use per-participant media encryption. Call password and shared-key mode are unsupported.
7. Stop the main bot container to release the crypto-directory lock:

```bash
cd musicbot_matrix_subsonic
docker compose stop
```

## Preliminary diagnostics

```bash
docker compose run --rm musicbot doctor
```

Verify a successful exit, matching user/device IDs, a compatible LiveKit transport, and a successful OpenSubsonic media server ping. Do not publish the raw `.env`, access token, OpenID token, LiveKit JWT, or Subsonic URL in bug reports.

Running `doctor` a second time after the first run also verifies that the persistent crypto store reopens. The device fingerprint must remain unchanged.

## Positive stereo test

Do not end the human Element Call. Run:

```bash
docker compose run --rm musicbot rtc:vertical-slice '!ROOM_ID:matrix.example.org' --duration=60
```

The join is successful only after:

- MatrixRTC membership is confirmed;
- a LiveKit token is issued for the expected `backendIdentity`;
- the SFU connection is established with `autoSubscribe: false`;
- GCM E2EE is enabled with key ring 256, HKDF, and ratchet window/failure tolerance 10;
- the per-participant media key is installed;
- the stereo track is published and a frame cryptor appears for the same `trackSid`.

During the signal, verify:

- the left channel contains a 440 Hz tone;
- the right channel contains an independent 880 Hz tone;
- audio does not interrupt for 60 seconds;
- both people continue hearing each other independently of the bot;
- logs contain no browser, E2EE, or decryption errors.

After the signal, the bot waits for the audio queue to drain and leaves only its own participation. It does not end the human Element Call.

## Wrong-key negative control

Run:

```bash
docker compose run --rm musicbot rtc:vertical-slice '!ROOM_ID:matrix.example.org' --duration=30 --wrong-key-control
```

In this mode, the publisher intentionally uses the wrong raw media key. The expected result is that people cannot hear a discernible test tone. This test must not be treated as working playback.

## Restart and reconnect checks

Full acceptance additionally verifies:

- a fresh process using the same `DATA_DIR`, device ID, database prefix, origin, and crypto key;
- reconnecting without restarting the Matrix client;
- key reinstallation through `reemitEncryptionKeys()`;
- preserving the latest own key index after `LocalTrackRepublished`;
- leaving and shutting down without leaked FFmpeg or LiveKit resources.

## Current backend evidence

- SFU loopback decryption: one Opus frame, 466 nonzero PCM samples, zero encryption errors.
- Positive human test in legacy mode: the participant heard the stereo tone.
- Wrong-key human test: the tone was absent.
- Encrypted `!play`: an OpenSubsonic media server track was queued and heard in Element Call.
- Queue, volume, selection, and skip commands completed without application errors.

These results do not replace the final two-sided test: two people must simultaneously confirm that they hear the tone and continue hearing each other.

## After validation

```bash
docker compose up -d
docker compose logs -f --tail=100
```

The music queue and OpenSubsonic media server playback are active after the positive test, negative control, and lifecycle checks. An identity mismatch, plaintext/shared-key mode, missing `trackSid`, or decryption errors stop work as compatibility or security blockers.
