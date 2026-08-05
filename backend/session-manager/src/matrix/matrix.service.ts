import { Injectable, Logger } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";

export interface MatrixCreds {
  userId: string;
  accessToken: string;
}

/**
 * Thin client for provisioning against the local Synapse (open registration
 * is enabled in homeserver.yaml, so no admin token is needed for dev).
 *
 * Registers participant users, and uses a lazily-created "orchestrator"
 * service account to create study rooms. Rooms are invite-only; participants
 * are invited and then joined server-side with their own tokens, so their
 * synced clients see the room appear the moment the group is complete.
 */
@Injectable()
export class MatrixService {
  private readonly log = new Logger(MatrixService.name);
  /** URL reachable from this backend (docker: http://synapse:8008). */
  private readonly internalUrl =
    process.env.MATRIX_INTERNAL_URL ?? "http://localhost:8008";
  private orchestrator?: MatrixCreds;
  /** Keep room creation ordered for the one shared orchestrator account. */
  private roomCreationChain: Promise<unknown> = Promise.resolve();
  private readonly servicePassword =
    process.env.MATRIX_SERVICE_PASSWORD ?? "gdm-dev-orchestrator-password";
  private readonly rateLimitRetries = nonNegativeInt(
    process.env.MATRIX_RATE_LIMIT_RETRIES,
    8,
  );
  private readonly maxRetryDelayMs = nonNegativeInt(
    process.env.MATRIX_RETRY_MAX_DELAY_MS,
    30_000,
  );
  private readonly requestTimeoutMs = positiveInt(
    process.env.MATRIX_REQUEST_TIMEOUT_MS,
    15_000,
  );

  /** Register a fresh Matrix user and return its credentials. */
  async registerUser(localpartHint: string): Promise<MatrixCreds> {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const username = `${localpartHint}_${suffix}`;
    const password = `${randomBytes(24).toString("base64url")}Aa1!`;

    const res = await this.fetchWithRateLimitRetry("register", () =>
      fetch(`${this.internalUrl}/_matrix/client/v3/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          auth: { type: "m.login.dummy" },
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
    );
    if (!res.ok) {
      throw new Error(`register failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { user_id: string; access_token: string };
    return { userId: data.user_id, accessToken: data.access_token };
  }

  private async getOrchestrator(): Promise<MatrixCreds> {
    if (!this.orchestrator) {
      this.orchestrator = await this.loginOrRegisterOrchestrator();
      this.log.log(`Orchestrator account: ${this.orchestrator.userId}`);
    }
    return this.orchestrator;
  }

  private async loginOrRegisterOrchestrator(): Promise<MatrixCreds> {
    const login = await this.fetchWithRateLimitRetry("orchestrator login", () =>
      fetch(`${this.internalUrl}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: "gdm_orchestrator" },
          password: this.servicePassword,
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
    );
    if (login.ok) {
      const data = (await login.json()) as {
        user_id: string;
        access_token: string;
      };
      return { userId: data.user_id, accessToken: data.access_token };
    }

    const register = await this.fetchWithRateLimitRetry(
      "orchestrator register",
      () =>
        fetch(`${this.internalUrl}/_matrix/client/v3/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "gdm_orchestrator",
            password: this.servicePassword,
            auth: { type: "m.login.dummy" },
          }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        }),
    );
    if (!register.ok) {
      throw new Error(
        `orchestrator login/register failed (${login.status}/${register.status})`,
      );
    }
    const data = (await register.json()) as {
      user_id: string;
      access_token: string;
    };
    return { userId: data.user_id, accessToken: data.access_token };
  }

  /**
   * Create a study room and return its id. Invite-only (private_chat): with
   * open registration on the homeserver, a joinable-by-id room would let
   * outsiders enter a live study session.
   */
  createRoom(name: string): Promise<string> {
    const run = this.roomCreationChain
      .catch(() => undefined)
      .then(() => this.doCreateRoom(name));
    this.roomCreationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doCreateRoom(name: string): Promise<string> {
    const orch = await this.getOrchestrator();
    const res = await this.fetchWithRateLimitRetry("createRoom", () =>
      fetch(`${this.internalUrl}/_matrix/client/v3/createRoom`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${orch.accessToken}`,
        },
        body: JSON.stringify({
          name,
          preset: "private_chat",
          visibility: "private",
          // Participant credentials live in the browser. Keep direct Matrix API
          // calls from inviting extra accounts into an active study room.
          power_level_content_override: { invite: 100 },
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
    );
    if (!res.ok) {
      throw new Error(`createRoom failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { room_id: string };
    return data.room_id;
  }

  /** Invite a user into a room (sent by the room-owning orchestrator). */
  async invite(roomId: string, userId: string): Promise<void> {
    const orch = await this.getOrchestrator();
    const res = await this.fetchWithRateLimitRetry("invite", () =>
      fetch(
        `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${orch.accessToken}`,
          },
          body: JSON.stringify({ user_id: userId }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      ),
    );
    if (!res.ok) {
      throw new Error(`invite failed (${res.status}): ${await res.text()}`);
    }
  }

  /** Join a user (by their own token) into a room. */
  async joinRoom(accessToken: string, roomId: string): Promise<void> {
    const res = await this.fetchWithRateLimitRetry("join", () =>
      fetch(
        `${this.internalUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: "{}",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      ),
    );
    if (!res.ok) {
      throw new Error(`join failed (${res.status}): ${await res.text()}`);
    }
  }

  /** Respect Synapse's retry_after hint, but keep retries bounded. */
  private async fetchWithRateLimitRetry(
    operation: string,
    request: () => Promise<Response>,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await request();
      if (response.status !== 429 || attempt >= this.rateLimitRetries) {
        return response;
      }
      const hintedDelayMs = Math.min(
        this.maxRetryDelayMs,
        await matrixRetryAfterMs(response),
      );
      // Synapse gives many burst requests the same retry hint. Positive jitter
      // prevents them all waking together and immediately recreating the 429.
      const retryAfterMs = Math.min(
        this.maxRetryDelayMs,
        hintedDelayMs + Math.floor(Math.random() * Math.min(1000, hintedDelayMs / 4)),
      );
      this.log.warn(
        `${operation} rate-limited; retrying in ${retryAfterMs}ms ` +
          `(${attempt + 1}/${this.rateLimitRetries})`,
      );
      await delay(retryAfterMs);
    }
  }
}

async function matrixRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers?.get?.("retry-after");
  const headerSeconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.max(1, Math.round(headerSeconds * 1000));
  }
  try {
    const clone = response.clone();
    const body = (await clone.json()) as { retry_after_ms?: unknown };
    const value = Number(body.retry_after_ms);
    if (Number.isFinite(value) && value >= 0) return Math.max(1, Math.round(value));
  } catch {
    // Plain test doubles and malformed 429 responses fall back safely.
  }
  return 1000;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
