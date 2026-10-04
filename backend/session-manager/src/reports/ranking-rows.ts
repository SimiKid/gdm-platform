import { MOON_SURVIVAL } from "@gdm/shared";
import type { Session } from "@gdm/shared";
import { toCsv } from "./csv";
import { pseudonymize, senderPseudonym } from "./pseudonym";
import { cell, isEtherpad, rankingAnswer, scalarAnswer } from "./report-values";
import { rankingErrorScore } from "./scoring";

/** rankings.csv: one row per ranking with one rank column per item. */
export function rankingsCsv(rankings: RankingRow[]): string {
  const itemIds = MOON_SURVIVAL.items.map((item) => item.id);
  return toCsv([
    [
      "session_pseudonym",
      "condition_id",
      "round",
      "type",
      "participant_pseudonym",
      "edit_index",
      "timestamp",
      "ranking_completed",
      "error",
      // One numeric column per item: the assigned 1..N rank.
      ...itemIds,
    ],
    ...rankings.map((row) => [
      row.sessionPseudonym,
      row.conditionId,
      String(row.round),
      row.type,
      row.participantPseudonym ?? "",
      cell(row.editIndex),
      row.timestamp ?? "",
      cell(row.rankingCompleted),
      cell(row.error),
      ...itemIds.map((itemId) => cell(row.ranks[itemId])),
    ]),
  ]);
}

export interface RankingRow {
  sessionPseudonym: string;
  conditionId: string;
  round: number;
  /** entry/exit = individual surveys; group-edit = one shared-ranking state; group-final = the session's end state. */
  type: "entry" | "exit" | "group-edit" | "group-final";
  /** For group rows: the editor who produced this state (null = system shuffle). */
  participantPseudonym: string | null;
  /** Position in the shared-ranking history (group-edit only), oldest = 0. */
  editIndex: number | null;
  timestamp: string | null;
  /** Entry only: false = timed out and auto-completed in shown order. */
  rankingCompleted: boolean | null;
  error: number | null;
  order: string[];
  /** item id -> assigned 1..N rank; null when the item is missing. */
  ranks: Record<string, number | null>;
}

function ranksOf(order: string[]): Record<string, number | null> {
  const ranks: Record<string, number | null> = {};
  for (const item of MOON_SURVIVAL.items) ranks[item.id] = null;
  order.forEach((id, index) => {
    if (id in ranks) ranks[id] = index + 1;
  });
  return ranks;
}

function editorPseudonym(session: Session, updatedBy: string): string | null {
  if (!updatedBy || updatedBy === "system") return null;
  return senderPseudonym(session, updatedBy);
}
/**
 * One row per ranking: each participant's entry and exit ranking, every
 * shared-ranking edit, and the group's final order. Etherpad sessions have
 * no rankings.
 */
export function rankingRows(session: Session): RankingRow[] {
  if (isEtherpad(session)) return [];
  const base = {
    sessionPseudonym: pseudonymize("S", session.id),
    conditionId: session.condition.id,
    round: session.roundId,
  };
  const rows: RankingRow[] = [];
  for (const participant of session.participants) {
    const pseudonym = pseudonymize("P", participant.id);
    const entryOrder = rankingAnswer(participant.entrySurvey, "individualRanking");
    if (entryOrder) {
      const completed =
        scalarAnswer(participant.entrySurvey, "rankingCompleted") === true;
      rows.push({
        ...base,
        type: "entry",
        participantPseudonym: pseudonym,
        editIndex: null,
        timestamp: participant.entrySurvey?.submittedAt ?? null,
        rankingCompleted: completed,
        // Same policy as participants.csv: timed-out orders are not scored,
        // but the raw order is still here for anyone who wants to relax it.
        error: completed ? rankingErrorScore(entryOrder) : null,
        order: entryOrder,
        ranks: ranksOf(entryOrder),
      });
    }
    const exitOrder = rankingAnswer(participant.exitSurvey, "finalRanking");
    if (exitOrder) {
      rows.push({
        ...base,
        type: "exit",
        participantPseudonym: pseudonym,
        editIndex: null,
        timestamp: participant.exitSurvey?.submittedAt ?? null,
        rankingCompleted: null,
        error: rankingErrorScore(exitOrder),
        order: exitOrder,
        ranks: ranksOf(exitOrder),
      });
    }
  }
  (session.rankingHistory ?? []).forEach((ranking, index) => {
    rows.push({
      ...base,
      type: "group-edit",
      participantPseudonym: editorPseudonym(session, ranking.updatedBy),
      editIndex: index,
      timestamp: ranking.updatedAt || null,
      rankingCompleted: null,
      error: rankingErrorScore(ranking.order),
      order: ranking.order,
      ranks: ranksOf(ranking.order),
    });
  });
  rows.push({
    ...base,
    type: "group-final",
    participantPseudonym: editorPseudonym(session, session.ranking.updatedBy),
    editIndex: null,
    timestamp: session.ranking.updatedAt || null,
    rankingCompleted: null,
    error: rankingErrorScore(session.ranking.order),
    order: session.ranking.order,
    ranks: ranksOf(session.ranking.order),
  });
  return rows;
}
