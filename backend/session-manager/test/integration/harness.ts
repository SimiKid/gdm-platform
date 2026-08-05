import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { inject } from "vitest";
import type {
  OpenSessionResponse,
  PublicSession,
  StartSessionNotification,
} from "@gdm/shared";
import { AppModule } from "../../src/app.module";
import { MatrixService, type MatrixCreds } from "../../src/matrix/matrix.service";
import { configureRequestBodyLimit } from "../../src/request-body";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** Fake origins so any accidental real network call fails loudly. */
export const CHAT_SERVICE_URL = "http://chat-service.integration-test";
export const MATRIX_PUBLIC_URL = "http://matrix.integration-test";

/**
 * Stand-in for Synapse provisioning (the one boundary these tests fake).
 * Hands out deterministic credentials and records every call.
 */
export class FakeMatrixService {
  registered: MatrixCreds[] = [];
  createdRooms: string[] = [];
  joins: { accessToken: string; roomId: string }[] = [];
  invites: { roomId: string; userId: string }[] = [];

  async registerUser(localpartHint: string): Promise<MatrixCreds> {
    const creds = {
      userId: `@${localpartHint}_${this.registered.length + 1}:test`,
      accessToken: `token-${this.registered.length + 1}`,
    };
    this.registered.push(creds);
    return creds;
  }

  async createRoom(_name: string): Promise<string> {
    const roomId = `!room-${this.createdRooms.length + 1}:test`;
    this.createdRooms.push(roomId);
    return roomId;
  }

  async invite(roomId: string, userId: string): Promise<void> {
    this.invites.push({ roomId, userId });
  }

  async joinRoom(accessToken: string, roomId: string): Promise<void> {
    this.joins.push({ accessToken, roomId });
  }
}

export interface ChatServiceCall {
  url: string;
  body: StartSessionNotification;
}

/** Outbound notifications the app sent to the (fake) Chat Service. */
export const chatServiceCalls: ChatServiceCall[] = [];

let fetchInstalled = false;

/**
 * SessionsService notifies the Chat Service over global fetch; capture that
 * and reject every other outbound URL (Matrix goes through FakeMatrixService,
 * so nothing else may leave the process).
 */
function installFetchRecorder(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url === `${CHAT_SERVICE_URL}/internal/bot`) {
      return new Response(JSON.stringify({ userId: "@gdm_bot:test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith(CHAT_SERVICE_URL)) {
      chatServiceCalls.push({
        url,
        body: JSON.parse(String(init?.body ?? "null")) as StartSessionNotification,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected outbound fetch in integration test: ${url}`);
  }) as typeof fetch;
}

let prisma: PrismaClient | undefined;

/**
 * Wipe every table so each test starts from an empty database. The next
 * createTestApp() re-seeds the five study conditions via StoreService.
 */
export async function resetDatabase(): Promise<void> {
  process.env.DATABASE_URL = inject("databaseUrl");
  prisma ??= new PrismaClient();
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE reactions, messages, surveys, ranking_history, interventions, window_evaluations, participants, sessions, conditions, study_rounds, study_settings CASCADE",
  );
  chatServiceCalls.length = 0;
}

/** Disconnect the harness's own Prisma client (call from afterAll). */
export async function closeHarness(): Promise<void> {
  await prisma?.$disconnect();
  prisma = undefined;
}

export interface TestApp {
  app: INestApplication;
  /** Pass to supertest: request(t.http)… */
  http: ReturnType<INestApplication["getHttpServer"]>;
  matrix: FakeMatrixService;
  chatServiceCalls: ChatServiceCall[];
  close(): Promise<void>;
}

/**
 * Boot the real AppModule (controller, services, StoreService in Postgres
 * mode, PrismaService) with only MatrixService replaced, mirroring the
 * bootstrap in src/main.ts (global "api" prefix).
 */
export async function createTestApp(): Promise<TestApp> {
  process.env.DATABASE_URL = inject("databaseUrl");
  process.env.CHAT_SERVICE_URL = CHAT_SERVICE_URL;
  process.env.MATRIX_PUBLIC_URL = MATRIX_PUBLIC_URL;
  installFetchRecorder();

  const matrix = new FakeMatrixService();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MatrixService)
    .useValue(matrix)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureRequestBodyLimit(app);
  app.setGlobalPrefix("api");
  await app.init();

  return {
    app,
    http: app.getHttpServer(),
    matrix,
    chatServiceCalls,
    close: () => app.close(),
  };
}

/** POST /api/sessions for one participant. */
export async function openSession(
  t: TestApp,
  name: string,
  conditionId?: string,
): Promise<OpenSessionResponse> {
  const res = await request(t.http)
    .post("/api/sessions")
    .send({ trackingToken: `tt-${name}`, participantName: name, conditionId })
    .expect(201);
  return res.body as OpenSessionResponse;
}

/** Fill one group completely (groupSize participants) and return all responses. */
export async function fillSession(
  t: TestApp,
  conditionId: string,
  groupSize = 3,
): Promise<OpenSessionResponse[]> {
  const responses: OpenSessionResponse[] = [];
  for (let i = 1; i <= groupSize; i++) {
    responses.push(await openSession(t, `P${i}-${conditionId}`, conditionId));
  }
  // Room provisioning is intentionally detached from participant enrollment;
  // mirror the real waiting-room poll before tests act on the live session.
  await waitForRunningSession(t, responses[0].session.id);
  return responses;
}

/** Poll exactly like the participant waiting room until provisioning is safe. */
export async function waitForRunningSession(
  t: TestApp,
  sessionId: string,
): Promise<PublicSession> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await request(t.http).get(`/api/sessions/${sessionId}`).expect(200);
    if (current.body.status === "running") {
      return current.body as PublicSession;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`session ${sessionId} did not finish provisioning`);
}
