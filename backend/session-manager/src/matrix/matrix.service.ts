import { Injectable, Logger } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import {
  fetchWithRateLimitRetry,
  nonNegativeInt,
  positiveInt,
} from "@gdm/shared/server";

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

    const res = await this.requestWithRetry("register", () =>
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
    const login = await this.requestWithRetry("orchestrator login", () =>
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

    const register = await this.requestWithRetry(
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
    const res = await this.requestWithRetry("createRoom", () =>
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
    const res = await this.requestWithRetry("invite", () =>
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

  /** Remove a participant from an aborted live room so stale clients cannot write. */
  async kick(roomId: string, userId: string, reason: string): Promise<void> {
    const orch = await this.getOrchestrator();
    const res = await this.requestWithRetry("kick", () =>
      fetch(
        `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${orch.accessToken}`,
          },
          body: JSON.stringify({ user_id: userId, reason }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      ),
    );
    if (!res.ok) {
      throw new Error(`kick failed (${res.status}): ${await res.text()}`);
    }
  }

  /** Set a user's power level in a room (e.g. to grant redaction rights). */
  async setUserPowerLevel(
    roomId: string,
    userId: string,
    level: number,
  ): Promise<void> {
    const orch = await this.getOrchestrator();
    // Fetch current power levels, patch the user, and PUT back.
    const getRes = await fetch(
      `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`,
      { headers: { Authorization: `Bearer ${orch.accessToken}` } },
    );
    if (!getRes.ok) {
      throw new Error(`get power_levels failed (${getRes.status})`);
    }
    const powerLevels = (await getRes.json()) as Record<string, unknown>;
    const users = (powerLevels.users ?? {}) as Record<string, number>;
    users[userId] = level;
    powerLevels.users = users;
    const putRes = await fetch(
      `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${orch.accessToken}`,
        },
        body: JSON.stringify(powerLevels),
      },
    );
    if (!putRes.ok) {
      throw new Error(`set power_levels failed (${putRes.status})`);
    }
  }

  /** Join a user (by their own token) into a room. */
  async joinRoom(accessToken: string, roomId: string): Promise<void> {
    const res = await this.requestWithRetry("join", () =>
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
  private requestWithRetry(
    operation: string,
    request: () => Promise<Response>,
  ): Promise<Response> {
    return fetchWithRateLimitRetry(request, {
      retries: this.rateLimitRetries,
      maxDelayMs: this.maxRetryDelayMs,
      onRetry: (retryAfterMs, attempt) =>
        this.log.warn(
          `${operation} rate-limited; retrying in ${retryAfterMs}ms ` +
            `(${attempt}/${this.rateLimitRetries})`,
        ),
    });
  }
}
