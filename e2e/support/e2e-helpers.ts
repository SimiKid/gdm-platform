import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const API =
  process.env.E2E_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
export const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:3003";
export const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
export const API_HEADERS = ADMIN_TOKEN
  ? { "x-admin-token": ADMIN_TOKEN }
  : undefined;

const PROGRESS_STORAGE_KEY = "gdm-study-progress";

export interface TestCondition {
  id: string;
  name: string;
  active: boolean;
  goal: number;
  durationMinutes: number;
  groupSize: number;
  config: {
    interventionMode: string;
    llmMode?: "off" | "active";
    [key: string]: unknown;
  };
}

export type TestConditionOverrides = Omit<
  Partial<TestCondition>,
  "config"
> & {
  config?: Partial<TestCondition["config"]>;
};

export interface MatrixCredentials {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  roomId: string;
}

interface PublicSession {
  id: string;
  status: string;
  roomId?: string;
  condition: TestCondition;
  participants: { id: string; name: string }[];
  [key: string]: unknown;
}

interface OpenSessionResponse {
  session: PublicSession;
  participantId: string;
  matrix: MatrixCredentials;
}

export interface AdminSession {
  id: string;
  status: string;
  roomId?: string;
  condition: TestCondition;
  participants: Array<{
    id: string;
    name: string;
    trackingToken: string;
    entrySurvey?: unknown;
    exitSurvey?: unknown;
  }>;
  chat: {
    messages: Array<{
      id: string;
      senderId: string;
      recipientId?: string | null;
      text: string;
      reactions: Array<{
        key: string;
        senderId: string;
        timestamp: string;
      }>;
    }>;
  };
  rankingHistory?: Array<{
    taskId: string;
    order: string[];
    updatedAt: string;
    updatedBy: string;
    movement?: { itemId: string; from: number; to: number };
  }>;
  interventions: Array<{
    id: string;
    sessionId: string;
    roomId: string;
    conditionId: string;
    mode: string;
    audience: "public" | "private" | "none";
    timestamp: string;
    trigger: string;
    threshold: number;
    llmMode: "off" | "active";
    contributionWindowMinutes: number;
    contributionSplit: Array<{
      userId: string;
      identityName: string;
      messageCount: number;
      wordCount: number;
      score: number;
      share: number;
      meaningfulnessScore: number;
      dominanceScore: number;
    }>;
    targets: Array<{ userId: string; identityName: string }>;
    quietMembers: Array<{ userId: string; identityName: string }>;
    message: string;
  }>;
  behavioralEvents: Array<{
    id: string;
    type: string;
    participantId: string;
    timestamp: string;
    durationMs?: number;
    payload?: Record<string, string | number | boolean | string[]>;
  }>;
  contributionClassifications: Array<{
    messageId: string;
    senderId: string;
    classifiedAt: string;
    respondsToPrior: { value: boolean; reason: string };
    referencesTaskItem: { value: boolean; reason: string };
    hasDiscussionStructure: { value: boolean; reason: string };
    invitesParticipation: { value: boolean; reason: string };
    meaningfulnessScore: number;
    model: string;
    promptVersion: string;
    prompt: string;
    rawOutput: string;
  }>;
  processedEventIds?: string[];
  runtimeState?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProvisionedMember {
  context: BrowserContext;
  page: Page;
  participantId: string;
  trackingToken: string;
  matrix: MatrixCredentials;
}

export interface ProvisionedGroup {
  sessionId: string;
  conditionId: string;
  roomId: string;
  members: ProvisionedMember[];
  pages: Page[];
  request: APIRequestContext;
}

const createdConditions = new Map<string, TestCondition>();

/** A collision-resistant id that can never enter the real study exports. */
export function uniqueId(prefix: string): string {
  const safePrefix = prefix.startsWith("e2e-") ? prefix : `e2e-${prefix}`;
  return `${safePrefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function createCondition(
  request: APIRequestContext,
  overrides: TestConditionOverrides = {},
): Promise<TestCondition> {
  const id = overrides.id ?? uniqueId("condition");
  if (!id.startsWith("e2e-")) {
    throw new Error(`E2E conditions must use the e2e- prefix (received ${id})`);
  }

  const condition: TestCondition = {
    id,
    name: `E2E ${id.slice(4)}`,
    active: true,
    goal: 1_000,
    durationMinutes: 2,
    groupSize: 2,
    ...overrides,
    config: {
      interventionMode: "baseline",
      ...overrides.config,
    },
  };
  const response = await request.put(`${API}/conditions/${condition.id}`, {
    headers: API_HEADERS,
    data: { condition },
  });
  await requireOk(response, `create condition ${condition.id}`);
  createdConditions.set(condition.id, condition);
  return condition;
}

export async function deactivateCondition(
  request: APIRequestContext,
  conditionOrId: TestCondition | string,
): Promise<void> {
  let condition =
    typeof conditionOrId === "string"
      ? createdConditions.get(conditionOrId)
      : conditionOrId;

  if (!condition && typeof conditionOrId === "string") {
    const response = await request.get(`${API}/conditions`, {
      headers: API_HEADERS,
    });
    await requireOk(response, `load condition ${conditionOrId}`);
    const conditions = (await response.json()) as TestCondition[];
    condition = conditions.find((item) => item.id === conditionOrId);
  }
  if (!condition) return;

  const inactive = { ...condition, active: false };
  const response = await request.put(`${API}/conditions/${inactive.id}`, {
    headers: API_HEADERS,
    data: { condition: inactive },
  });
  await requireOk(response, `deactivate condition ${inactive.id}`);
  createdConditions.set(inactive.id, inactive);
}

/**
 * Provision a complete Matrix-backed group through the API, then resume each
 * participant directly in chat using the same sessionStorage contract as F5.
 */
export async function provisionGroup(
  browser: Browser,
  request: APIRequestContext,
  conditionId: string,
  size: number,
): Promise<ProvisionedGroup> {
  if (!conditionId.startsWith("e2e-")) {
    throw new Error(`Refusing to provision a non-E2E condition: ${conditionId}`);
  }

  const opened: Array<{
    participantId: string;
    trackingToken: string;
    matrix: MatrixCredentials;
  }> = [];
  let sessionId = "";
  const contexts: BrowserContext[] = [];

  try {
    for (let seat = 0; seat < size; seat += 1) {
      const trackingToken = uniqueId(`participant-${seat + 1}`);
      const response = await request.post(`${API}/sessions`, {
        data: {
          trackingToken,
          participantName: `E2E participant ${seat + 1}`,
          conditionId,
        },
      });
      await requireOk(response, `open participant ${seat + 1}`);
      const body = (await response.json()) as OpenSessionResponse;
      sessionId ||= body.session.id;
      if (body.session.id !== sessionId) {
        throw new Error("E2E participants were assigned to different sessions");
      }
      opened.push({
        participantId: body.participantId,
        trackingToken,
        matrix: body.matrix,
      });
    }

    let publicSession: PublicSession | undefined;
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API}/sessions/${sessionId}`);
          await requireOk(response, `load session ${sessionId}`);
          publicSession = (await response.json()) as PublicSession;
          return publicSession.status === "running" && Boolean(publicSession.roomId);
        },
        {
          message: `session ${sessionId} should become ready`,
          timeout: 30_000,
        },
      )
      .toBe(true);

    const roomId = publicSession!.roomId!;
    const members: ProvisionedMember[] = [];
    for (const member of opened) {
      const context = await browser.newContext();
      contexts.push(context);
      const matrix = { ...member.matrix, roomId };
      await context.addInitScript(
        ({ progressKey, progress }) => {
          sessionStorage.setItem(progressKey, JSON.stringify(progress));
        },
        {
          progressKey: PROGRESS_STORAGE_KEY,
          progress: {
            stage: "chat",
            sessionId,
            participantId: member.participantId,
            matrix,
          },
        },
      );
      members.push({
        ...member,
        matrix,
        context,
        page: await context.newPage(),
      });
    }

    await Promise.all(members.map((member) => member.page.goto("/")));
    await Promise.all(
      members.map((member) =>
        expect(member.page.getByPlaceholder("Type a message")).toBeVisible({
          timeout: 30_000,
        }),
      ),
    );

    return {
      sessionId,
      conditionId,
      roomId,
      members,
      pages: members.map((member) => member.page),
      request,
    };
  } catch (error) {
    await Promise.allSettled(contexts.map((context) => context.close()));
    if (sessionId) {
      await request.post(`${API}/sessions/${sessionId}/complete`).catch(() => undefined);
    }
    throw error;
  }
}

export async function pollAdminSession(
  request: APIRequestContext,
  sessionId: string,
  predicate: (session: AdminSession) => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<AdminSession> {
  let latest: AdminSession | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`${API}/admin/sessions/${sessionId}`, {
          headers: API_HEADERS,
        });
        await requireOk(response, `load admin session ${sessionId}`);
        latest = (await response.json()) as AdminSession;
        return predicate(latest);
      },
      {
        message: `admin session ${sessionId} should reach the expected state`,
        timeout: timeoutMs,
        intervals: [250, 500, 1_000],
      },
    )
    .toBe(true);
  return latest!;
}

export async function sendChat(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder("Type a message");
  await input.fill(text);
  await input.press("Enter");
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
}

/** Close browser clients and prevent failed E2E sessions staying live. */
export async function closeGroup(group: ProvisionedGroup): Promise<void> {
  await Promise.allSettled(
    group.members.map((member) => member.context.close()),
  );
  await group.request
    .post(`${API}/sessions/${group.sessionId}/complete`)
    .catch(() => undefined);
}

async function requireOk(
  response: APIResponse,
  operation: string,
): Promise<void> {
  if (response.ok()) return;
  throw new Error(
    `${operation} failed with HTTP ${response.status()}: ${await response.text()}`,
  );
}
