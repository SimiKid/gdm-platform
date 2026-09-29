import {
  BadRequestException,
  ServiceUnavailableException,
  type Logger,
} from "@nestjs/common";
import type { ProlificIdentity } from "@gdm/shared";
import { prolificApiFetch } from "../prolific/prolific-api";

/** A verified Prolific submission is not re-checked for this long. */
const PROLIFIC_VERIFICATION_TTL_MS = 60_000;
/** Upper bound of the verification cache (identifiers are client-supplied). */
const PROLIFIC_VERIFICATION_CACHE_MAX = 5_000;
/** Timeout of the Prolific submission lookup. */
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Reject malformed URL identifiers and a submission from another study
 * before anything is stored or looked up.
 */
export function assertProlificIdentifiers(
  identity: ProlificIdentity,
  apiToken: string | undefined,
): void {
  // Prolific identifiers are 24 alphanumeric characters. They are not
  // guaranteed to be hexadecimal, particularly in participant previews.
  const idPattern = /^[a-z0-9]{24}$/i;
  // Prolific's researcher preview uses shorter synthetic submission IDs whose
  // length can vary. Accept those only while API-backed validation is off;
  // secure validation still requires the real 24-character submission ID.
  const previewSessionIdPattern = /^[a-z0-9]{12,23}$/i;
  const validSessionId =
    idPattern.test(identity.sessionId) ||
    (!apiToken && previewSessionIdPattern.test(identity.sessionId));
  if (
    !idPattern.test(identity.participantId) ||
    !idPattern.test(identity.studyId) ||
    !validSessionId
  ) {
    throw new BadRequestException("Invalid Prolific identifiers");
  }
  const expectedStudyId = process.env.PROLIFIC_STUDY_ID?.trim();
  if (expectedStudyId && identity.studyId !== expectedStudyId) {
    throw new BadRequestException("Unexpected Prolific study");
  }
}

/**
 * Confirms a submission against the Prolific API. A verified submission is
 * cached briefly to avoid repeating the lookup across arrival → resume →
 * join.
 */
export class ProlificSubmissionVerifier {
  private readonly verifiedSubmissions = new Map<string, number>();

  constructor(private readonly log: Logger) {}

  /**
   * Require the submission to exist, belong to this participant and study,
   * and still be in progress (`allowEnded` also admits ended submissions,
   * e.g. to show a returning participant their outcome).
   */
  async verify(
    identity: ProlificIdentity,
    apiToken: string,
    allowEnded: boolean,
  ): Promise<void> {
    const cacheKey = [
      identity.studyId,
      identity.sessionId,
      identity.participantId,
    ].join(":");
    const cachedUntil = this.verifiedSubmissions.get(cacheKey) ?? 0;
    if (cachedUntil > Date.now()) return;
    this.pruneCache();

    let response: Response;
    try {
      response = await prolificApiFetch(
        apiToken,
        `/submissions/${identity.sessionId}/`,
        { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
      );
    } catch (error) {
      this.log.error(`Prolific submission verification failed: ${String(error)}`);
      throw new ServiceUnavailableException(
        "Prolific submission verification is temporarily unavailable",
      );
    }

    if (response.status === 404) {
      throw new BadRequestException("Unknown Prolific submission");
    }
    if (!response.ok) {
      this.log.error(
        `Prolific submission verification returned ${response.status}`,
      );
      throw new ServiceUnavailableException(
        "Prolific submission verification is temporarily unavailable",
      );
    }

    const submission = (await response.json()) as {
      id?: string;
      study_id?: string;
      participant?: string;
      status?: string;
    };
    if (
      submission.id !== identity.sessionId ||
      submission.study_id !== identity.studyId ||
      submission.participant !== identity.participantId
    ) {
      throw new BadRequestException("Prolific submission identity mismatch");
    }
    // Prolific's current API documents underscore-separated enum values, while
    // older responses used display-style spaces. Normalize both forms so a
    // legitimate participant can still resume after submitting their study.
    const submissionStatus = submission.status
      ?.trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    const allowedStatuses = [
      "RESERVED",
      "ACTIVE",
      "AWAITING_REVIEW",
      "APPROVED",
      ...(allowEnded
        ? ["RETURNED", "TIMED_OUT", "SCREENED_OUT", "REJECTED"]
        : []),
    ];
    if (submissionStatus && !allowedStatuses.includes(submissionStatus)) {
      throw new BadRequestException(
        `Prolific submission is ${submissionStatus.toLowerCase()}`,
      );
    }

    this.verifiedSubmissions.set(
      cacheKey,
      Date.now() + PROLIFIC_VERIFICATION_TTL_MS,
    );
  }

  /** Keep attacker-controlled identifiers from growing the verification cache forever. */
  private pruneCache(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.verifiedSubmissions) {
      if (expiresAt <= now) this.verifiedSubmissions.delete(key);
    }
    while (this.verifiedSubmissions.size >= PROLIFIC_VERIFICATION_CACHE_MAX) {
      const oldest = this.verifiedSubmissions.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.verifiedSubmissions.delete(oldest);
    }
  }
}
