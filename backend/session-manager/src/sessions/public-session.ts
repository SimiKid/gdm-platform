import type { PublicSession, Session } from "@gdm/shared";

/** Strip per-participant secrets before a session leaves the participant API. */
export function toPublicSession(session: Session): PublicSession {
  const {
    behavioralEvents: _behavioralEvents,
    contributionClassifications: _contributionClassifications,
    windowEvaluations: _windowEvaluations,
    classificationFailures: _classificationFailures,
    processedEventIds: _processedEventIds,
    redactedReactionEventIds: _redactedReactionEventIds,
    reactionEvents: _reactionEvents,
    runtimeState: _runtimeState,
    checkpointRevision: _checkpointRevision,
    ...publicFields
  } = session;
  return {
    ...publicFields,
    // A room persisted mid-provisioning is recovery metadata, not an
    // invitation to enter a half-configured room.
    roomId: session.status === "provisioning" ? undefined : session.roomId,
    participants: session.participants.map((p) => ({ id: p.id, name: p.name })),
  };
}
