import { MOON_SURVIVAL_EXPERT_RANKING } from "@gdm/shared";
import type { Session } from "@gdm/shared";
import { toCsv } from "./csv";
import { participantRow } from "./participant-rows";
import {
  GROUP_DYNAMICS_KEYS,
  PSYCH_SAFETY_KEYS,
  byKey,
  cell,
  isEtherpad,
  rankingAnswer,
} from "./report-values";
import { rankingErrorScore } from "./scoring";

/** Expert ranking as pipe-separated item IDs, best → worst. */
const EXPERT_ORDER = Object.entries(MOON_SURVIVAL_EXPERT_RANKING)
  .sort(([, a], [, b]) => a - b)
  .map(([id]) => id)
  .join("|");

/**
 * results.csv of the research-data zip: one row per participant with
 * Prolific id, surveys, ranking scores and received nudges.
 */
export function resultsCsv(sessions: Session[]): string {
  return toCsv([
    [
      "prolific_id",
      "group_id",
      "member_id",
      "condition",
      "round",
      "session_status",
      "age",
      "gender",
      "education",
      "english",
      ...Array.from({ length: 10 }, (_, i) => `gaais${i + 1}`),
      ...Array.from({ length: 10 }, (_, i) => `person${i + 1}`),
      "team",
      "text",
      "space",
      "survival",
      "rank_true",
      "rank_init",
      "init_ranking_score",
      "rank_fin",
      "final_ranking_score",
      "rank_group",
      "group_ranking_score",
      "rank_completed",
      "confidence",
      "groupcoh1",
      "groupcoh2",
      "groupcoh3",
      "groupcoh4",
      "groupcoh5",
      "psysafe1",
      "psysafe2",
      "psysafe3",
      "psysafe4",
      "psysafe5",
      "psysafe6",
      "attention1",
      "attention2",
      "feedback",
      "message_count",
      "character_count",
      "intervention_count",
      "intervention_id",
    ],
    ...sessions.flatMap((session) =>
      session.participants.map((participant, index) => {
        const row = participantRow(session, participant);
        const nudges = session.interventions.filter((intervention) =>
          intervention.targets.some(
            (target) => target.userId === participant.matrixUserId,
          ),
        );
        const groupDynamics = byKey(GROUP_DYNAMICS_KEYS, row.groupDynamics);
        const psychSafety = byKey(PSYCH_SAFETY_KEYS, row.psychSafety);
        return [
          participant.prolific?.participantId ?? "",
          session.id,
          String(index + 1),
          session.condition.name,
          String(session.roundId),
          session.status === "completed" ? "1" : "0",
          cell(row.age),
          cell(row.gender),
          cell(row.education),
          cell(row.englishProficiency),
          ...row.gaais.map(cell),
          ...row.tipi.map(cell),
          cell(row.teamworkFrequency),
          cell(row.chatComfort),
          cell(row.spaceflightFamiliarity),
          cell(row.survivalFamiliarity),
          isEtherpad(session) ? "" : EXPERT_ORDER,
          isEtherpad(session) ? "" : rankingAnswer(participant.entrySurvey, "individualRanking")?.join("|") ?? "",
          isEtherpad(session) ? "" : cell(rankingErrorScore(rankingAnswer(participant.entrySurvey, "individualRanking"))),
          isEtherpad(session) ? "" : rankingAnswer(participant.exitSurvey, "finalRanking")?.join("|") ?? "",
          isEtherpad(session) ? "" : cell(rankingErrorScore(rankingAnswer(participant.exitSurvey, "finalRanking"))),
          isEtherpad(session) ? "" : session.ranking.order.join("|"),
          isEtherpad(session) ? "" : cell(rankingErrorScore(session.ranking.order)),
          cell(row.individualRankingCompleted),
          cell(row.taskConfidence),
          cell(groupDynamics.groupConsidered),
          cell(groupDynamics.groupBalanced),
          cell(groupDynamics.groupDominated),
          cell(groupDynamics.feltTeam),
          cell(groupDynamics.comfortableAgain),
          cell(psychSafety.safeSpeakUp),
          cell(psychSafety.raiseConcerns),
          cell(psychSafety.contradicted),
          cell(psychSafety.contributionSerious),
          cell(psychSafety.contributionInfluenced),
          cell(psychSafety.heldBack),
          cell(groupDynamics.attentionCheck1),
          cell(psychSafety.attentionCheck2),
          cell(row.debriefFeedback),
          String(row.messageCount),
          String(row.characterCount),
          String(nudges.length),
          nudges.map((n) => n.id).join("|"),
        ];
      }),
    ),
  ]);
}
