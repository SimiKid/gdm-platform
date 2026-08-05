import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const profiles = JSON.parse(open("../profiles.json"));
const profileName = __ENV.LOADTEST_PROFILE || "smoke";
const profile = profiles[profileName];
if (!profile) throw new Error(`Unknown load profile: ${profileName}`);

const baseUrl = (__ENV.LOADTEST_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const apiUrl = `${baseUrl}/api`;
const conditionId = __ENV.LOADTEST_CONDITION_ID;
const runId = __ENV.LOADTEST_RUN_ID || `manual-${Date.now()}`;
const syncTimeoutMs = intEnv("LOADTEST_SYNC_TIMEOUT_MS", 5000);
const messageMinSeconds = intEnv("LOADTEST_MESSAGE_MIN_SECONDS", 20);
const messageMaxSeconds = intEnv("LOADTEST_MESSAGE_MAX_SECONDS", 45);
const cursorSeconds = intEnv("LOADTEST_CURSOR_SECONDS", 10);
const rankingMinSeconds = intEnv("LOADTEST_RANKING_MIN_SECONDS", 60);
const rankingMaxSeconds = intEnv("LOADTEST_RANKING_MAX_SECONDS", 120);
const reactionMinSeconds = intEnv("LOADTEST_REACTION_MIN_SECONDS", 45);
const reactionMaxSeconds = intEnv("LOADTEST_REACTION_MAX_SECONDS", 120);
const enrollmentBackoffBaseSeconds = intEnv(
  "LOADTEST_ENROLL_BACKOFF_BASE_SECONDS",
  1,
);
const enrollmentBackoffMaxSeconds = intEnv(
  "LOADTEST_ENROLL_BACKOFF_MAX_SECONDS",
  15,
);

if (!conditionId || !conditionId.startsWith("e2e-load-")) {
  throw new Error("LOADTEST_CONDITION_ID must be an isolated e2e-load-* condition");
}

const sessionOpenMs = new Trend("session_open_ms", true);
const groupReadyMs = new Trend("group_ready_ms", true);
const matrixInitialSyncMs = new Trend("matrix_initial_sync_ms", true);
const matrixSendAckMs = new Trend("matrix_send_ack_ms", true);
const matrixOwnDeliveryMs = new Trend("matrix_own_delivery_ms", true);
const matrixPeerDeliveryMs = new Trend("matrix_peer_delivery_ms", true);
const apiLatencyMs = new Trend("gdm_api_latency_ms", true);
const protocolFailureRate = new Rate("protocol_failure_rate");
const http429 = new Counter("http_429_count");
const http5xx = new Counter("http_5xx_count");
const messagesSent = new Counter("messages_sent");
const messagesObserved = new Counter("messages_observed");
const matrixEventsSent = new Counter("matrix_events_sent");

const failureLimit = Number(__ENV.LOADTEST_SLO_FAILURE_RATE || 0.01);
const continueAfterSloFailure = profile.continueAfterSloFailure === true;
const sendP95 = intEnv("LOADTEST_SLO_SEND_P95_MS", 750);
const sendP99 = intEnv("LOADTEST_SLO_SEND_P99_MS", 2000);
const peerP95 = intEnv("LOADTEST_SLO_PEER_P95_MS", 1500);
const peerP99 = intEnv("LOADTEST_SLO_PEER_P99_MS", 3000);
const apiP95 = intEnv("LOADTEST_SLO_API_P95_MS", 1000);
const sessionOpenP95 = intEnv("LOADTEST_SLO_SESSION_OPEN_P95_MS", 5000);
const groupReadyP95 = intEnv("LOADTEST_SLO_GROUP_READY_P95_MS", 15000);
const measuredTargets = [
  ...new Set(profile.stages.map((stage) => stage.target).filter((target) => target > 0)),
];
const stageThresholds = {};
for (const target of measuredTargets) {
  stageThresholds[`matrix_send_ack_ms{load_target:${target}}`] = [
    `p(95)<${sendP95}`,
    `p(99)<${sendP99}`,
  ];
  stageThresholds[`matrix_peer_delivery_ms{load_target:${target}}`] = [
    `p(95)<${peerP95}`,
    `p(99)<${peerP99}`,
  ];
  stageThresholds[`session_open_ms{load_target:${target}}`] = [
    `p(95)<${sessionOpenP95}`,
  ];
  stageThresholds[`group_ready_ms{load_target:${target}}`] = [
    `p(95)<${groupReadyP95}`,
  ];
  stageThresholds[`protocol_failure_rate{load_target:${target}}`] = [
    `rate<${failureLimit}`,
  ];
}

export const options = {
  discardResponseBodies: false,
  scenarios: {
    participants: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.stages,
      gracefulRampDown: "15s",
      exec: "participant",
      tags: { scope: "loadtest", profile: profileName },
    },
  },
  thresholds: {
    checks: [
      {
        threshold: `rate>${1 - failureLimit}`,
        abortOnFail: !continueAfterSloFailure,
        delayAbortEval: "2m",
      },
    ],
    protocol_failure_rate: [
      {
        threshold: `rate<${failureLimit}`,
        abortOnFail: !continueAfterSloFailure,
        delayAbortEval: "2m",
      },
      // Keep collecting through ordinary SLO degradation, but stop if the
      // platform broadly collapses for several minutes.
      {
        threshold: "rate<0.25",
        abortOnFail: true,
        delayAbortEval: "5m",
      },
    ],
    http_429_count: ["count==0"],
    http_5xx_count: ["count==0"],
    matrix_send_ack_ms: [`p(95)<${sendP95}`, `p(99)<${sendP99}`],
    matrix_peer_delivery_ms: [`p(95)<${peerP95}`, `p(99)<${peerP99}`],
    session_open_ms: [`p(95)<${sessionOpenP95}`],
    group_ready_ms: [`p(95)<${groupReadyP95}`],
    "gdm_api_latency_ms{endpoint:session_poll}": [`p(95)<${apiP95}`],
    ...stageThresholds,
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

let state;
let enrollmentFailures = 0;

export function participant() {
  if (!state) {
    try {
      state = enroll();
      enrollmentFailures = 0;
    } catch (error) {
      enrollmentFailures += 1;
      const exponential = Math.min(
        enrollmentBackoffMaxSeconds,
        enrollmentBackoffBaseSeconds * 2 ** Math.min(6, enrollmentFailures - 1),
      );
      // Per-VU jitter avoids synchronized retries becoming a second traffic
      // spike while preserving the failed iteration in k6's metrics.
      sleep(randomBetween(exponential * 0.75, exponential * 1.25));
      throw error;
    }
  }
  runDueActions(state);
  syncOnce(state, syncTimeoutMs);
}

function enroll() {
  const vuId = exec.vu.idInTest;
  const trackingToken = `${conditionId}-${runId}-vu-${vuId}`;
  const participantShell = request(
    "GET",
    `${baseUrl}/`,
    null,
    requestParams("participant_shell"),
  );
  requireStatus(participantShell, 200, "participant shell");

  const openedAt = Date.now();
  const response = request(
    "POST",
    `${apiUrl}/sessions`,
    JSON.stringify({
      trackingToken,
      participantName: `Load participant ${vuId}`,
      conditionId,
    }),
    jsonParams("session_open"),
  );
  sessionOpenMs.add(Date.now() - openedAt, metricTags());
  requireStatus(response, 201, "session opened");

  const data = response.json();
  if (!data?.session?.id || !data?.participantId || !data?.matrix?.accessToken) {
    protocolFailureRate.add(true, metricTags());
    throw new Error("openSession returned an incomplete response");
  }

  const participantState = {
    vuId,
    sessionId: data.session.id,
    participantId: data.participantId,
    homeserverUrl: normalizeHomeserverUrl(data.matrix.homeserverUrl || baseUrl),
    userId: data.matrix.userId,
    accessToken: data.matrix.accessToken,
    roomId: data.matrix.roomId || data.session.roomId || "",
    since: "",
    messageSequence: 0,
    rankingOrder: Array.isArray(data.session?.ranking?.order)
      ? data.session.ranking.order.slice()
      : [],
    recentMessageIds: [],
    seenEventIds: new Set(),
    nextMessageAt: future(messageMinSeconds, messageMaxSeconds),
    nextCursorAt: future(cursorSeconds, cursorSeconds),
    nextRankingAt: future(rankingMinSeconds, rankingMaxSeconds),
    nextReactionAt: future(reactionMinSeconds, reactionMaxSeconds),
  };

  submitEntrySurvey(participantState);
  const initialSyncAt = Date.now();
  syncOnce(participantState, 0);
  matrixInitialSyncMs.add(Date.now() - initialSyncAt, metricTags());

  while (!participantState.roomId) {
    syncOnce(participantState, 1000);
    const pollStarted = Date.now();
    const poll = request(
      "GET",
      `${apiUrl}/sessions/${encodeURIComponent(participantState.sessionId)}`,
      null,
      requestParams("session_poll"),
    );
    apiLatencyMs.add(Date.now() - pollStarted, {
      ...metricTags(),
      endpoint: "session_poll",
    });
    requireStatus(poll, 200, "waiting-room poll");
    const session = poll.json();
    if (session.status === "aborted") {
      protocolFailureRate.add(true, metricTags());
      throw new Error(`Session ${participantState.sessionId} was aborted while waiting`);
    }
    participantState.roomId = session.roomId || "";
    if (Array.isArray(session?.ranking?.order)) {
      participantState.rankingOrder = session.ranking.order.slice();
    }
    if (!participantState.roomId) sleep(1);
  }

  groupReadyMs.add(Date.now() - openedAt, metricTags());
  protocolFailureRate.add(false, metricTags());
  return participantState;
}

function submitEntrySurvey(participantState) {
  const started = Date.now();
  const response = request(
    "POST",
    `${apiUrl}/surveys`,
    JSON.stringify({
      sessionId: participantState.sessionId,
      participantId: participantState.participantId,
      kind: "entry",
      survey: {
        submittedAt: new Date().toISOString(),
        answers: {
          loadTest: true,
          runId,
          virtualUser: participantState.vuId,
        },
      },
    }),
    jsonParams("entry_survey"),
  );
  apiLatencyMs.add(Date.now() - started, {
    ...metricTags(),
    endpoint: "entry_survey",
  });
  requireStatus(response, 201, "entry survey stored");
}

function runDueActions(participantState) {
  const now = Date.now();
  if (now >= participantState.nextCursorAt) {
    sendMatrixEvent(participantState, "de.gdm.behavior", {
      type: "cursor-activity",
      sampleCount: randomInt(20, 100),
      distancePx: randomInt(250, 2500),
      lastX: randomInt(100, 1300),
      lastY: randomInt(100, 800),
    }, "cursor_activity");
    participantState.nextCursorAt = future(cursorSeconds, cursorSeconds);
  }

  if (now >= participantState.nextMessageAt) {
    sendTypingAndMessage(participantState);
    participantState.nextMessageAt = future(messageMinSeconds, messageMaxSeconds);
  }

  if (now >= participantState.nextRankingAt && participantState.rankingOrder.length > 1) {
    sendRanking(participantState);
    participantState.nextRankingAt = future(rankingMinSeconds, rankingMaxSeconds);
  }

  if (now >= participantState.nextReactionAt && participantState.recentMessageIds.length > 0) {
    sendReaction(participantState);
    participantState.nextReactionAt = future(reactionMinSeconds, reactionMaxSeconds);
  }
}

function sendTypingAndMessage(participantState) {
  const typingStartedAt = Date.now();
  sendTyping(participantState, true, 4000);
  sendMatrixEvent(participantState, "de.gdm.behavior", { type: "typing-start" }, "typing_start");
  sleep(randomBetween(0.8, 2.2));

  participantState.messageSequence += 1;
  const sentAt = Date.now();
  const marker =
    `GDM_LOAD|${runId}|${sentAt}|${participantState.vuId}|` +
    `${participantState.messageSequence}`;
  const response = sendMatrixEvent(
    participantState,
    "m.room.message",
    {
      msgtype: "m.text",
      body: `${marker} Collaborative load-test message ${participantState.messageSequence}`,
    },
    "chat_message",
    true,
  );
  if (response?.status === 200) messagesSent.add(1, metricTags());

  sendTyping(participantState, false, 0);
  sendMatrixEvent(
    participantState,
    "de.gdm.behavior",
    { type: "typing-stop", durationMs: Date.now() - typingStartedAt },
    "typing_stop",
  );
}

function sendTyping(participantState, typing, timeout) {
  const url =
    `${participantState.homeserverUrl}/_matrix/client/v3/rooms/` +
    `${encodeURIComponent(participantState.roomId)}/typing/` +
    `${encodeURIComponent(participantState.userId)}`;
  const response = request(
    "PUT",
    url,
    JSON.stringify({ typing, timeout }),
    matrixParams(participantState, "matrix_typing"),
  );
  requireStatus(response, 200, "Matrix typing");
}

function sendRanking(participantState) {
  const order = participantState.rankingOrder.slice();
  const from = randomInt(0, order.length - 1);
  const to = from === order.length - 1 ? from - 1 : from + 1;
  const itemId = order[from];
  [order[from], order[to]] = [order[to], order[from]];
  participantState.rankingOrder = order;
  sendMatrixEvent(
    participantState,
    "de.gdm.ranking",
    {
      taskId: "moon-survival",
      order,
      updatedAt: new Date().toISOString(),
      updatedBy: participantState.userId,
      movement: { itemId, from, to },
    },
    "ranking",
  );
}

function sendReaction(participantState) {
  const target =
    participantState.recentMessageIds[
      randomInt(0, participantState.recentMessageIds.length - 1)
    ];
  const emojis = ["👍", "👎", "❤️"];
  sendMatrixEvent(
    participantState,
    "m.reaction",
    {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: target,
        key: emojis[randomInt(0, emojis.length - 1)],
      },
    },
    "reaction",
  );
}

function sendMatrixEvent(
  participantState,
  eventType,
  content,
  endpoint,
  measureMessage = false,
) {
  const transactionId =
    `load-${runId}-${participantState.vuId}-${Date.now()}-` +
    `${Math.random().toString(36).slice(2, 8)}`;
  const url =
    `${participantState.homeserverUrl}/_matrix/client/v3/rooms/` +
    `${encodeURIComponent(participantState.roomId)}/send/` +
    `${encodeURIComponent(eventType)}/${encodeURIComponent(transactionId)}`;
  const started = Date.now();
  const response = request(
    "PUT",
    url,
    JSON.stringify(content),
    matrixParams(participantState, endpoint),
  );
  if (measureMessage) matrixSendAckMs.add(Date.now() - started, metricTags());
  requireStatus(response, 200, `Matrix ${endpoint}`);
  matrixEventsSent.add(1, metricTags());
  return response;
}

function syncOnce(participantState, timeoutMs) {
  const query = [`timeout=${timeoutMs}`];
  if (participantState.since) {
    query.push(`since=${encodeURIComponent(participantState.since)}`);
  }
  const response = request(
    "GET",
    `${participantState.homeserverUrl}/_matrix/client/v3/sync?${query.join("&")}`,
    null,
    matrixParams(participantState, "matrix_sync"),
  );
  requireStatus(response, 200, "Matrix sync");
  const payload = response.json();
  if (payload?.next_batch) participantState.since = payload.next_batch;
  observeTimeline(participantState, payload);
}

function observeTimeline(participantState, payload) {
  const joined = payload?.rooms?.join || {};
  for (const room of Object.values(joined)) {
    for (const event of room?.timeline?.events || []) {
      if (!event?.event_id || participantState.seenEventIds.has(event.event_id)) continue;
      participantState.seenEventIds.add(event.event_id);
      if (event.type !== "m.room.message") continue;
      participantState.recentMessageIds.push(event.event_id);
      if (participantState.recentMessageIds.length > 30) {
        participantState.recentMessageIds.shift();
      }
      const marker = parseMarker(event?.content?.body);
      if (!marker || marker.runId !== runId) continue;
      const latency = Math.max(0, Date.now() - marker.sentAt);
      if (event.sender === participantState.userId) {
        matrixOwnDeliveryMs.add(latency, metricTags());
      } else {
        matrixPeerDeliveryMs.add(latency, metricTags());
      }
      messagesObserved.add(1, metricTags());
    }
  }
}

function parseMarker(body) {
  if (typeof body !== "string" || !body.startsWith("GDM_LOAD|")) return null;
  const [prefix, markerRunId, sentAt] = body.split("|", 5);
  const timestamp = Number(sentAt);
  if (prefix !== "GDM_LOAD" || !markerRunId || !Number.isFinite(timestamp)) return null;
  return { runId: markerRunId, sentAt: timestamp };
}

function request(method, url, body, params) {
  const response = http.request(method, url, body, params);
  if (response.status === 429) http429.add(1, metricTags());
  if (response.status >= 500) http5xx.add(1, metricTags());
  return response;
}

function requireStatus(response, expected, label) {
  const ok = check(
    response,
    { [`${label}: HTTP ${expected}`]: (item) => item.status === expected },
    metricTags(),
  );
  protocolFailureRate.add(!ok, metricTags());
  if (!ok) {
    throw new Error(
      `${label} failed: HTTP ${response.status} ${String(response.body).slice(0, 300)}`,
    );
  }
}

function requestParams(endpoint) {
  return {
    timeout: `${Math.max(syncTimeoutMs + 5000, 15000)}ms`,
    tags: { endpoint, name: endpoint, ...metricTags() },
  };
}

function jsonParams(endpoint) {
  const params = requestParams(endpoint);
  params.headers = { "Content-Type": "application/json" };
  return params;
}

function matrixParams(participantState, endpoint) {
  const params = jsonParams(endpoint);
  params.headers.Authorization = `Bearer ${participantState.accessToken}`;
  return params;
}

function future(minSeconds, maxSeconds) {
  return Date.now() + randomBetween(minSeconds, maxSeconds) * 1000;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomInt(min, max) {
  return Math.floor(randomBetween(min, max + 1));
}

function intEnv(name, fallback) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be numeric`);
  return Math.round(value);
}

function metricTags() {
  return { load_target: currentLoadTarget() };
}

function currentLoadTarget() {
  let elapsedMs = exec.instance.currentTestRunDuration;
  for (const stage of profile.stages) {
    const durationMs = durationToMs(stage.duration);
    if (elapsedMs <= durationMs) return String(stage.target);
    elapsedMs -= durationMs;
  }
  return String(profile.stages[profile.stages.length - 1]?.target ?? 0);
}

function durationToMs(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(value));
  if (!match) throw new Error(`Unsupported stage duration: ${value}`);
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
  return Number(match[1]) * factor;
}

function normalizeHomeserverUrl(value) {
  let normalized = String(value).replace(/\/+$/, "");
  if (baseUrl.includes("host.docker.internal")) {
    normalized = normalized
      .replace("://localhost", "://host.docker.internal")
      .replace("://127.0.0.1", "://host.docker.internal");
  }
  return normalized;
}
