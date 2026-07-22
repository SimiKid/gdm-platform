import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { inject } from "vitest";
import type {
  Condition,
  FinalizeSessionRequest,
  InterventionMode,
  Ranking,
} from "@gdm/shared";
import { AppModule } from "../../src/app.module";
import { MatrixBotService } from "../../src/matrix/matrix-bot.service";

declare module "vitest" {
  export interface ProvidedContext {
    synapseUrl: string;
  }
}

export function synapseUrl(): string {
  return inject("synapseUrl");
}

// ── Fake Session Manager ───────────────────────────────────────────

export interface FinalizeCall {
  path: string;
  body: FinalizeSessionRequest;
}

export interface FakeSessionManager {
  url: string;
  /** Every checkpoint/finalize request, in arrival order. */
  calls: FinalizeCall[];
  close(): Promise<void>;
}

/** Records the finalize callbacks the chat-service posts at session end. */
export function startFakeSessionManager(): Promise<FakeSessionManager> {
  const calls: FinalizeCall[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls.push({ path: req.url ?? "", body: JSON.parse(raw || "null") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

// ── The chat-service app under test ────────────────────────────────

export interface ChatApp {
  app: INestApplication;
  moduleRef: TestingModule;
  /** Pass to supertest: request(t.http)… */
  http: ReturnType<INestApplication["getHttpServer"]>;
  bot: MatrixBotService;
  close(): Promise<void>;
}

/**
 * Boot the real AppModule — real MatrixBotService (registers a bot user on
 * the test Synapse and starts its sync loop) and real ContributionBotRules.
 * Nothing is faked inside the service.
 */
export async function createChatApp(sessionManagerUrl: string): Promise<ChatApp> {
  process.env.MATRIX_INTERNAL_URL = synapseUrl();
  process.env.SESSION_MANAGER_URL = sessionManagerUrl;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  const bot = moduleRef.get(MatrixBotService);
  return {
    app,
    moduleRef,
    http: app.getHttpServer(),
    bot,
    close: async () => {
      bot.stop();
      await app.close();
    },
  };
}

// ── Minimal Matrix client for test participants ────────────────────

export interface MatrixUser {
  userId: string;
  accessToken: string;
}

let txnCounter = 0;

async function matrixFetch(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Record<string, unknown>> {
  const { token, ...rest } = init;
  const res = await fetch(`${synapseUrl()}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Register a participant. Keep names free of "bot"/"orchestrator" — those are filtered as service users. */
export async function registerUser(localpart: string): Promise<MatrixUser> {
  const data = await matrixFetch("/_matrix/client/v3/register", {
    method: "POST",
    body: JSON.stringify({
      username: `${localpart}_${Date.now()}_${txnCounter++}`,
      password: "Integration1!",
      auth: { type: "m.login.dummy" },
    }),
  });
  return { userId: data.user_id as string, accessToken: data.access_token as string };
}

/** Same preset the session-manager orchestrator uses, so join-by-id works. */
export async function createPublicRoom(user: MatrixUser, name: string): Promise<string> {
  const data = await matrixFetch("/_matrix/client/v3/createRoom", {
    method: "POST",
    token: user.accessToken,
    body: JSON.stringify({ name, preset: "public_chat", visibility: "private" }),
  });
  return data.room_id as string;
}

export async function joinRoom(user: MatrixUser, roomId: string): Promise<void> {
  await matrixFetch(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
    method: "POST",
    token: user.accessToken,
    body: "{}",
  });
}

async function sendEvent(
  user: MatrixUser,
  roomId: string,
  type: string,
  content: Record<string, unknown>,
): Promise<string> {
  const data = await matrixFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/t${txnCounter++}`,
    { method: "PUT", token: user.accessToken, body: JSON.stringify(content) },
  );
  return data.event_id as string;
}

export function sendText(user: MatrixUser, roomId: string, body: string): Promise<string> {
  return sendEvent(user, roomId, "m.room.message", { msgtype: "m.text", body });
}

export function sendReaction(
  user: MatrixUser,
  roomId: string,
  targetEventId: string,
  key: string,
): Promise<string> {
  return sendEvent(user, roomId, "m.reaction", {
    "m.relates_to": { rel_type: "m.annotation", event_id: targetEventId, key },
  });
}

export async function redactEvent(
  user: MatrixUser,
  roomId: string,
  eventId: string,
): Promise<void> {
  await matrixFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/t${txnCounter++}`,
    { method: "PUT", token: user.accessToken, body: "{}" },
  );
}

export function sendRanking(
  user: MatrixUser,
  roomId: string,
  ranking: Ranking,
): Promise<string> {
  return sendEvent(user, roomId, "de.gdm.ranking", ranking as unknown as Record<string, unknown>);
}

export async function joinedMembers(user: MatrixUser, roomId: string): Promise<string[]> {
  const data = await matrixFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    { token: user.accessToken },
  );
  return Object.keys((data.joined ?? {}) as Record<string, unknown>);
}

export interface RoomEvent {
  type: string;
  sender: string;
  event_id: string;
  content: Record<string, unknown>;
}

export async function roomMessages(user: MatrixUser, roomId: string): Promise<RoomEvent[]> {
  const data = await matrixFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`,
    { token: user.accessToken },
  );
  return (data.chunk ?? []) as RoomEvent[];
}

// ── Polling ────────────────────────────────────────────────────────

/** Poll `fn` until it returns a truthy value; throws with `what` on timeout. */
export async function until<T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  timeoutMs = 20_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ── Study fixtures ─────────────────────────────────────────────────

/**
 * A condition with all protection windows opened up so rules can fire
 * immediately; the mode and thresholds stay per-test.
 */
export function testCondition(
  mode: InterventionMode,
  overrides: Partial<Condition> = {},
): Condition {
  return {
    id: `it-${mode}`,
    name: `Integration ${mode}`,
    active: true,
    goal: 5,
    durationMinutes: 10,
    groupSize: 2,
    config: {
      interventionMode: mode,
      contributionThreshold: 0.55,
      protectedStartMinutes: 0,
      protectedEndMinutes: 0,
      cooldownSeconds: 1800,
      contributionWindowMinutes: 30,
      scoreWeights: { messages: 1, words: 0.05 },
    },
    ...overrides,
  };
}
