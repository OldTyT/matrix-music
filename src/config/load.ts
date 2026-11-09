import { config as loadDotenv } from "dotenv";
import { ZodError } from "zod";
import { parseConfig, type AppConfig } from "./schema.js";

export function loadConfig(): AppConfig {
  loadDotenv({ path: process.env.ENV_FILE ?? ".env", override: false, quiet: true });
  try {
    return parseConfig(process.env);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
}
