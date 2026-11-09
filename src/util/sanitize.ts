const REDACTED = "[Redacted]";
const sensitiveKey = /(access.?token|password|passwd|secret|storage.?key|crypto.?store.?key|private.?key|jwt|openid|shared.?key|raw.?key)/i;
const sensitiveQuery = /((?:^|[?&\s])(?:access_token|password|token|jwt|openid_token|storage_key|key|signature|sig|salt|s|t)=)[^&\s]+/gi;

function sanitizeString(input: string, secrets: readonly string[]): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length > 0) output = output.split(secret).join(REDACTED);
  }
  output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      return url.toString();
    } catch {
      return candidate;
    }
  });
  return output.replace(sensitiveQuery, `$1${REDACTED}`);
}

export function sanitizeForLog<T>(value: T, secrets: readonly string[] = [], seen = new WeakSet<object>()): T {
  if (typeof value === "string") return sanitizeString(value, secrets) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]" as T;
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message, secrets),
      stack: value.stack ? sanitizeString(value.stack, secrets) : undefined,
    } as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLog(entry, secrets, seen)) as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key) ? REDACTED : sanitizeForLog(entry, secrets, seen);
  }
  return output as T;
}

export function sanitizedError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeForLog(message, secrets);
}
