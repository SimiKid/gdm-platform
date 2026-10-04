import type { EtherpadService } from "../etherpad/etherpad.service";
import { toCsv } from "./csv";
import { pseudonymize } from "./pseudonym";
import { cell } from "./report-values";

type EtherpadDocument = Awaited<ReturnType<EtherpadService["documents"]>>[number];

export type ResearchPad = ReturnType<typeof researchPad>;

/** One Etherpad document with pseudonymous ids (grants are never exported). */
export function researchPad(d: EtherpadDocument) {
  return {
    padPseudonym: pseudonymize("D", d.id),
    sessionPseudonym: d.sessionId ? pseudonymize("S", d.sessionId) : null,
    participantPseudonym: d.participantId ? pseudonymize("P", d.participantId) : null,
    conditionId: d.conditionId ?? null, round: d.roundId ?? null,
    phase: d.phase, state: d.state, deadline: d.deadline,
    capturedAt: d.capturedAt ?? null, revision: d.revision, text: d.text,
  };
}

export function etherpadCsv(pads: ResearchPad[]): string {
  return toCsv([
    ["pad_pseudonym", "session_pseudonym", "participant_pseudonym", "condition_id", "round", "phase", "state", "deadline", "captured_at", "revision", "raw_text"],
    ...pads.map(p => [p.padPseudonym, cell(p.sessionPseudonym), cell(p.participantPseudonym), cell(p.conditionId), cell(p.round), p.phase, p.state, p.deadline, cell(p.capturedAt), cell(p.revision), cell(p.text)]),
  ]);
}
