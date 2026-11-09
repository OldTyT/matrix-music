import { Agent } from "undici";
import { withTimeout } from "./time.js";

export class ManagedHttpAgent {
  private readonly agent = new Agent({
    keepAliveTimeout: 1000,
    keepAliveMaxTimeout: 10000,
  });

  readonly fetch: typeof globalThis.fetch = (input, init) => {
    const options = { ...init, dispatcher: this.agent } as RequestInit & { dispatcher: Agent };
    return globalThis.fetch(input, options);
  };

  async close(): Promise<void> {
    try {
      await withTimeout(this.agent.close(), 5000, "HTTP agent close");
    } catch {
      await this.agent.destroy();
    }
  }
}
