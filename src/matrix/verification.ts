import { createInterface } from "node:readline/promises";
import type { MatrixClient } from "matrix-js-sdk";
import {
  VerificationRequestEvent,
  VerificationPhase,
  VerifierEvent,
  type VerificationRequest,
  type Verifier,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import type { AppConfig } from "../config/schema.js";
import type { AppLogger } from "../util/logger.js";
import { withTimeout } from "../util/time.js";

async function initializeNewCrossSigning(client: MatrixClient, config: AppConfig): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Rust crypto is unavailable");
  if (await crypto.isCrossSigningReady()) return;
  const hasExistingIdentity = await crypto.userHasCrossSigningKeys(config.MATRIX_USER_ID, true);
  if (hasExistingIdentity) {
    throw new Error("An existing cross-signing identity is not locally trusted; verify with an existing bot device or recovery instead of resetting it");
  }
  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: false,
    authUploadDeviceSigningKeys: async (makeRequest) => makeRequest(null),
  });
}

async function selectAdministratorDevice(client: MatrixClient, adminUserId: string, requestedDeviceId: string | undefined): Promise<string> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Rust crypto is unavailable");
  const devices = (await crypto.getUserDeviceInfo([adminUserId], true)).get(adminUserId);
  if (!devices || devices.size === 0) throw new Error(`No devices found for ${adminUserId}`);
  if (requestedDeviceId) {
    if (!devices.has(requestedDeviceId)) throw new Error(`Administrator device ${requestedDeviceId} was not found`);
    return requestedDeviceId;
  }
  if (devices.size === 1) return devices.keys().next().value as string;

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const entries = [...devices.values()];
    entries.forEach((device, index) => {
      process.stdout.write(`${index + 1}. ${device.deviceId} ${device.displayName ?? ""}\n`);
    });
    const answer = await readline.question("Select the administrator device to verify: ");
    const index = Number(answer) - 1;
    const selected = entries[index];
    if (!selected) throw new Error("Invalid administrator device selection");
    return selected.deviceId;
  } finally {
    readline.close();
  }
}

async function runSasVerification(request: VerificationRequest): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        let verifier: Verifier | undefined;
        let starting = false;
        let settled = false;
        const succeed = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const attachVerifier = (candidate: Verifier): void => {
          if (verifier) return;
          verifier = candidate;
          verifier.once(VerifierEvent.Cancel, (error) => {
            fail(new Error(`Verification cancelled: ${error instanceof Error ? error.message : error.getContent().code ?? "unknown"}`));
          });
          verifier.on(VerifierEvent.ShowSas, (callbacks) => {
            void (async () => {
              const emoji = callbacks.sas.emoji?.map(([symbol, name]) => `${symbol} ${name}`).join("\n") ?? "Emoji unavailable";
              const decimal = callbacks.sas.decimal?.join(" ") ?? "Decimal unavailable";
              process.stdout.write(`Compare these values with the administrator's Element client:\n\n${emoji}\n\n${decimal}\n\n`);
              const answer = await readline.question("Do they match exactly? Type yes to confirm: ");
              if (answer.trim().toLowerCase() !== "yes") {
                callbacks.mismatch();
                fail(new Error("SAS values were rejected"));
                return;
              }
              await callbacks.confirm();
            })().catch(fail);
          });
          void verifier.verify().then(succeed, fail);
        };
        const onChange = (): void => {
          if (request.phase === VerificationPhase.Cancelled) {
            fail(new Error(`Verification cancelled: ${request.cancellationCode ?? "unknown"}`));
            return;
          }
          if (request.phase === VerificationPhase.Done) {
            succeed();
            return;
          }
          if (request.phase === VerificationPhase.Started && request.verifier) attachVerifier(request.verifier);
          if (request.phase === VerificationPhase.Ready && request.initiatedByMe && !starting) {
            starting = true;
            void request.startVerification(VerificationMethod.Sas).then(attachVerifier, fail);
          }
        };
        request.on(VerificationRequestEvent.Change, onChange);
        onChange();
      }),
      300000,
      "SAS verification",
    );
  } finally {
    readline.close();
  }
}

export async function verifyAdministratorDevice(
  client: MatrixClient,
  config: AppConfig,
  logger: AppLogger,
  adminUserId: string,
  adminDeviceId?: string,
): Promise<void> {
  if (!config.MATRIX_ADMIN_USER_IDS.includes(adminUserId)) throw new Error("The specified user is not a configured administrator");
  await initializeNewCrossSigning(client, config);
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Rust crypto is unavailable");
  const deviceId = await selectAdministratorDevice(client, adminUserId, adminDeviceId);
  process.stdout.write(`Accept the verification request in Element for ${adminUserId} ${deviceId}.\n`);
  const request = await crypto.requestDeviceVerification(adminUserId, deviceId);
  await runSasVerification(request);
  const keys = await crypto.getOwnDeviceKeys();
  process.stdout.write(`Verification complete. Bot Ed25519 fingerprint: ${keys.ed25519}\n`);
  logger.info({ adminUserId, adminDeviceId: deviceId }, "Administrator device verification completed");
}
