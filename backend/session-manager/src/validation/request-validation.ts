import { BadRequestException } from "@nestjs/common";
import type {
  Condition,
  OpenSessionRequest,
  RecordParticipationProgressRequest,
  RecordProlificArrivalRequest,
  SubmitSurveyRequest,
  TerminateParticipationRequest,
} from "@gdm/shared";

const SAFE_ID = /^[A-Za-z0-9._:@-]+$/;

export function validateOpenSessionRequest(
  value: unknown,
): asserts value is OpenSessionRequest {
  const request = record(value, "Invalid session request");
  const trackingToken = boundedString(
    request.trackingToken,
    "trackingToken",
    1,
    256,
  );
  if (/\s/.test(trackingToken)) bad("trackingToken must not contain whitespace");
  boundedString(request.participantName, "participantName", 0, 100);
  optionalSafeId(request.conditionId, "conditionId", 128);
  if (request.prolific !== undefined) validateProlificShape(request.prolific);
}

export function validateProlificArrivalRequest(
  value: unknown,
): asserts value is RecordProlificArrivalRequest {
  const request = record(value, "Invalid Prolific request");
  validateProlificShape(request.prolific);
}

export function validateParticipationProgressRequest(
  value: unknown,
): asserts value is RecordParticipationProgressRequest {
  const request = record(value, "Invalid participation progress");
  validateProlificShape(request.prolific);
  if (!['arrived', 'consent', 'entry', 'waiting', 'chat', 'exit'].includes(String(request.stage))) {
    bad("Invalid participation stage");
  }
}

export function validateTerminateParticipationRequest(
  value: unknown,
): asserts value is TerminateParticipationRequest {
  const request = record(value, "Invalid participation termination");
  validateProlificShape(request.prolific);
  if (
    !["declined_consent", "ineligible", "voluntary_withdrawal"].includes(
      String(request.outcome),
    )
  ) {
    bad("Invalid participant-selectable outcome");
  }
  if (request.reason !== undefined) boundedString(request.reason, "reason", 0, 500);
}

export function validateSurveyRequest(
  value: unknown,
): asserts value is SubmitSurveyRequest {
  const request = record(value, "Invalid survey request");
  boundedString(request.sessionId, "sessionId", 1, 100);
  boundedString(request.participantId, "participantId", 1, 100);
  if (request.kind !== "entry" && request.kind !== "exit") {
    bad("kind must be entry or exit");
  }
  const survey = record(request.survey, "Invalid survey");
  const submittedAt = boundedString(
    survey.submittedAt,
    "survey.submittedAt",
    1,
    64,
  );
  if (!Number.isFinite(Date.parse(submittedAt))) {
    bad("survey.submittedAt must be a valid timestamp");
  }
  const answers = record(survey.answers, "survey.answers must be an object");
  validateBoundedJson(answers, "survey.answers");
}

/** Validate the actual study questionnaire before it reaches persistence. */
export function validateSurveyAnswers(
  request: SubmitSurveyRequest,
  expectedItemIds: string[],
): void {
  const answers = request.survey.answers;
  if (request.kind === "entry") {
    for (const key of [
      "consentAdult",
      "consentInformed",
      "consentParticipation",
      "groupInstructionsAcknowledged",
    ]) {
      if (answers[key] !== undefined && answers[key] !== true) {
        bad(`${key} must be accepted`);
      }
    }
    if (answers.age !== undefined) integerInRange(answers.age, "age", 18, 120);
    if (answers.gender !== undefined) {
      boundedString(answers.gender, "gender", 1, 40);
    }
    if (answers.education !== undefined) {
      boundedString(answers.education, "education", 1, 120);
    }
    if (answers.fieldOfStudy !== undefined) {
      boundedString(answers.fieldOfStudy, "fieldOfStudy", 1, 200);
    }
    if (answers.genderCustom !== undefined) {
      boundedString(answers.genderCustom, "genderCustom", 1, 200);
    }
    if (answers.educationOther !== undefined) {
      boundedString(answers.educationOther, "educationOther", 1, 200);
    }
    if (
      answers.agePreferNotToSay !== undefined &&
      typeof answers.agePreferNotToSay !== "boolean"
    ) {
      bad("agePreferNotToSay must be a boolean");
    }
    if (answers.individualRanking !== undefined) {
      exactRanking(answers.individualRanking, expectedItemIds, "individualRanking");
    }
    if (
      answers.rankingCompleted !== undefined &&
      typeof answers.rankingCompleted !== "boolean"
    ) {
      bad("rankingCompleted must be a boolean");
    }
    if (answers.rankingSecondsUsed !== undefined) {
      integerInRange(
        answers.rankingSecondsUsed,
        "rankingSecondsUsed",
        0,
        300,
      );
    }
    if (answers.englishProficiency !== undefined) {
      boundedString(
        answers.englishProficiency,
        "englishProficiency",
        1,
        40,
      );
    }
    if (answers.teamworkFrequency !== undefined) {
      boundedString(
        answers.teamworkFrequency,
        "teamworkFrequency",
        1,
        40,
      );
    }
    if (answers.chatComfort !== undefined) {
      integerInRange(answers.chatComfort, "chatComfort", 1, 7);
    }
    if (answers.topicFamiliarity !== undefined) {
      integerInRange(answers.topicFamiliarity, "topicFamiliarity", 1, 7);
    }
    if (answers.spaceflightFamiliarity !== undefined) {
      integerInRange(answers.spaceflightFamiliarity, "spaceflightFamiliarity", 1, 5);
    }
    if (answers.survivalFamiliarity !== undefined) {
      integerInRange(answers.survivalFamiliarity, "survivalFamiliarity", 1, 5);
    }
    // GAAIS AI attitudes (1–5) and TIPI personality (1–7)
    for (let i = 1; i <= 10; i++) {
      const gaaisKey = `gaais${i}`;
      if (answers[gaaisKey] !== undefined) {
        integerInRange(answers[gaaisKey], gaaisKey, 1, 5);
      }
      const tipiKey = `tipi${i}`;
      if (answers[tipiKey] !== undefined) {
        integerInRange(answers[tipiKey], tipiKey, 1, 7);
      }
    }
  } else {
    if (answers.finalRanking !== undefined) {
      exactRanking(answers.finalRanking, expectedItemIds, "finalRanking");
    }
    // Legacy exit fields (pre-v2)
    if (answers.satisfaction !== undefined) {
      integerInRange(answers.satisfaction, "satisfaction", 1, 7);
    }
    if (answers.fairness !== undefined) {
      integerInRange(answers.fairness, "fairness", 1, 7);
    }
    if (answers.feltHeard !== undefined) {
      integerInRange(answers.feltHeard, "feltHeard", 1, 7);
    }
    // v2 exit fields
    if (answers.taskConfidence !== undefined) {
      integerInRange(answers.taskConfidence, "taskConfidence", 1, 5);
    }
    const exitLikert5Keys = [
      "groupConsidered", "groupBalanced", "attentionCheck1",
      "groupDominated", "feltTeam", "comfortableAgain",
      "safeSpeakUp", "raiseConcerns", "contradicted",
      "attentionCheck2", "contributionSerious", "contributionInfluenced",
      "heldBack", "botIntrusive", "botHelpful", "botAppropriate",
      "botObserved", "botSupport",
    ];
    for (const key of exitLikert5Keys) {
      if (answers[key] !== undefined) {
        integerInRange(answers[key], key, 1, 5);
      }
    }
    if (answers.debriefFeedback !== undefined) {
      boundedString(answers.debriefFeedback, "debriefFeedback", 0, 4_000);
    }
  }
}

export function validateRoundLabel(value: unknown): string {
  if (value === undefined) return "";
  return boundedString(value, "label", 0, 120).trim();
}

export function validateCompensationUrl(
  value: unknown,
  field = "compensationUrl",
): string {
  const url = boundedString(value, field, 0, 2_000).trim();
  if (!url) return "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return bad(`${field} must be a valid URL`);
  }
  const localHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    bad(`${field} must use HTTPS`);
  }
  return parsed.toString();
}

export function validateCondition(value: unknown): asserts value is Condition {
  const condition = record(value, "Invalid condition");
  optionalSafeId(condition.id, "condition.id", 128);
  boundedString(condition.name, "condition.name", 1, 160);
  if (typeof condition.active !== "boolean") {
    bad("condition.active must be a boolean");
  }
  finiteNumber(condition.goal, "condition.goal");
  finiteNumber(condition.durationMinutes, "condition.durationMinutes");
  finiteNumber(condition.groupSize, "condition.groupSize");
  const config = record(condition.config, "condition.config must be an object");
  validateBoundedJson(config, "condition.config");
}

function validateProlificShape(value: unknown): void {
  const prolific = record(value, "Invalid Prolific identity");
  for (const key of ["participantId", "studyId", "sessionId"] as const) {
    const id = boundedString(prolific[key], `prolific.${key}`, 1, 64);
    if (!SAFE_ID.test(id)) bad(`prolific.${key} contains invalid characters`);
  }
}

function exactRanking(value: unknown, expected: string[], field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    bad(`${field} must be a ranking`);
  }
  const order = value as string[];
  const expectedSet = new Set(expected);
  if (
    order.length !== expected.length ||
    new Set(order).size !== expected.length ||
    order.some((item) => !expectedSet.has(item))
  ) {
    bad(`${field} must contain every task item exactly once`);
  }
}

function validateBoundedJson(
  value: unknown,
  field: string,
  depth = 0,
  counter = { nodes: 0 },
): void {
  counter.nodes += 1;
  if (counter.nodes > 500 || depth > 8) bad(`${field} is too complex`);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > 4_000) bad(`${field} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) bad(`${field} contains an oversized array`);
    value.forEach((item) => validateBoundedJson(item, field, depth + 1, counter));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 100) bad(`${field} has too many properties`);
    for (const [key, item] of entries) {
      if (key.length > 100) bad(`${field} contains an oversized property name`);
      validateBoundedJson(item, field, depth + 1, counter);
    }
    return;
  }
  bad(`${field} contains an unsupported value`);
}

function integerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    return bad(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return bad(`${field} must be a finite number`);
  }
  return value;
}

function optionalSafeId(value: unknown, field: string, maximum: number): void {
  if (value === undefined) return;
  const id = boundedString(value, field, 1, maximum);
  if (!SAFE_ID.test(id)) bad(`${field} contains invalid characters`);
}

function boundedString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) {
    return bad(`${field} must be a string of ${minimum}-${maximum} characters`);
  }
  return value;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) return bad(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(message: string): never {
  throw new BadRequestException(message);
}
