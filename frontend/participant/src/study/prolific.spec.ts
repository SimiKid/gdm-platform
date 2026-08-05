import { beforeEach, describe, expect, it } from "vitest";
import {
  loadProlificIdentity,
  parseProlificIdentity,
  prolificTrackingToken,
  storeProlificIdentity,
} from "./prolific";

const identity = {
  participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  sessionId: "cccccccccccccccccccccccc",
};

beforeEach(() => sessionStorage.clear());

describe("Prolific URL identity", () => {
  it("parses the complete standard parameter set", () => {
    const params = new URLSearchParams({
      PROLIFIC_PID: identity.participantId,
      STUDY_ID: identity.studyId,
      SESSION_ID: identity.sessionId,
    });
    expect(parseProlificIdentity(params)).toEqual({
      identity,
      incomplete: false,
    });
  });

  it("marks partial parameter sets as incomplete", () => {
    expect(
      parseProlificIdentity(
        new URLSearchParams({ PROLIFIC_PID: identity.participantId }),
      ),
    ).toEqual({ incomplete: true });
  });

  it("stores the identity and derives a PID-free tracking token", () => {
    storeProlificIdentity(identity);
    expect(loadProlificIdentity()).toEqual(identity);
    expect(prolificTrackingToken(identity)).toBe(
      `prolific:${identity.studyId}:${identity.sessionId}`,
    );
    expect(prolificTrackingToken(identity)).not.toContain(identity.participantId);
  });
});
