import { Injectable, Logger } from "@nestjs/common";

export interface MatrixCreds {
  userId: string;
  accessToken: string;
}

/**
 * Thin client for provisioning against the local Synapse (open registration
 * is enabled in homeserver.yaml, so no admin token is needed for dev).
 *
 * Registers participant users, and uses a lazily-created "orchestrator"
 * service account to create study rooms. Participants are joined server-side
 * with their own tokens (public_chat preset), so their synced clients see the
 * room appear the moment the group is complete.
 */
@Injectable()
export class MatrixService {
  private readonly log = new Logger(MatrixService.name);
  /** URL reachable from this backend (docker: http://synapse:8008). */
  private readonly internalUrl =
    process.env.MATRIX_INTERNAL_URL ?? "http://localhost:8008";
  private orchestrator?: MatrixCreds;

  /** Register a fresh Matrix user and return its credentials. */
  async registerUser(localpartHint: string): Promise<MatrixCreds> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const username = `${localpartHint}_${suffix}`;
    const password = `${Math.random().toString(36).slice(2)}Aa1!`;

    const res = await fetch(`${this.internalUrl}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        auth: { type: "m.login.dummy" },
      }),
    });
    if (!res.ok) {
      throw new Error(`register failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { user_id: string; access_token: string };
    return { userId: data.user_id, accessToken: data.access_token };
  }

  private async getOrchestrator(): Promise<MatrixCreds> {
    if (!this.orchestrator) {
      this.orchestrator = await this.registerUser("gdm_orchestrator");
      this.log.log(`Orchestrator account: ${this.orchestrator.userId}`);
    }
    return this.orchestrator;
  }

  /** Create a study room and return its id. */
  async createRoom(name: string): Promise<string> {
    const orch = await this.getOrchestrator();
    const res = await fetch(`${this.internalUrl}/_matrix/client/v3/createRoom`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${orch.accessToken}`,
      },
      body: JSON.stringify({ name, preset: "public_chat", visibility: "private" }),
    });
    if (!res.ok) {
      throw new Error(`createRoom failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { room_id: string };
    return data.room_id;
  }

  /** Join a user (by their own token) into a room. */
  async joinRoom(accessToken: string, roomId: string): Promise<void> {
    const res = await fetch(
      `${this.internalUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: "{}",
      },
    );
    if (!res.ok) {
      throw new Error(`join failed (${res.status}): ${await res.text()}`);
    }
  }
}
