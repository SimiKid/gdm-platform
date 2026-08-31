import { Injectable } from "@nestjs/common";
import archiver from "archiver";
import {
  DEFAULT_INTERVENTION_CONFIG,
  MOON_SURVIVAL,
  MOON_SURVIVAL_EXPERT_RANKING,
  isServiceUser,
} from "@gdm/shared";
import type {
  Condition,
  ConditionReportSummary,
  Participant,
  ReportsSummaryResponse,
  Session,
  Survey,
  WindowEvaluation,
} from "@gdm/shared";
import { StoreService } from "../store/store.service";
import { toCsv } from "./csv";
import { filterResearchSessions, type ResearchFilter } from "./filter";
import {
  contributionScores,
  countWords,
  gini,
  meanOf,
  shareStdDev,
} from "./equality";
import { pseudonymize, senderPseudonym } from "./pseudonym";
import { rankingErrorScore } from "./scoring";

/**
 * Analysis-ready research exports and the dashboard Results summary.
 *
 * Everything here is derived on read from the sessions the StoreService
 * returns — no separate report state. All research files use pseudonymous
 * ids only; the linkage export (never part of the bundle) maps them back to
 * Prolific tokens for compensation and exclusions.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly store: StoreService) {}

  private async sessions(filter: ResearchFilter): Promise<Session[]> {
    return filterResearchSessions(await this.store.allSessions(), filter);
  }

  // ── participants ─────────────────────────────────────────────────

  async exportParticipants(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      participants: (await this.sessions(filter)).flatMap((session) =>
        session.participants.map((participant) =>
          participantRow(session, participant),
        ),
      ),
    };
  }

  async exportParticipantsCsv(filter: ResearchFilter = {}): Promise<string> {
    const { participants } = await this.exportParticipants(filter);
    return toCsv([
      [
        "participant_pseudonym",
        "session_pseudonym",
        "condition_id",
        "condition_name",
        "round",
        "intervention_mode",
        "llm_mode",
        "session_status",
        "group_size",
        "started_at",
        "entry_submitted",
        "age",
        "age_prefer_not_to_say",
        "gender",
        "gender_custom",
        "education",
        "education_other",
        "field_of_study",
        "english_proficiency",
        "gaais1",
        "gaais2",
        "gaais3",
        "gaais4",
        "gaais5",
        "gaais6",
        "gaais7",
        "gaais8",
        "gaais9",
        "gaais10",
        "tipi1",
        "tipi2",
        "tipi3",
        "tipi4",
        "tipi5",
        "tipi6",
        "tipi7",
        "tipi8",
        "tipi9",
        "tipi10",
        "teamwork_frequency",
        "chat_comfort",
        "topic_familiarity",
        "spaceflight_familiarity",
        "survival_familiarity",
        "individual_ranking_completed",
        "individual_ranking_seconds_used",
        "individual_ranking_error",
        "exit_submitted",
        "exit_ranking_error",
        "satisfaction",
        "fairness",
        "felt_heard",
        "message_count",
        "word_count",
        "character_count",
        "contribution_share",
        "meaningfulness_score_mean",
        "classified_message_count",
        "nudges_received_total",
        "nudges_received_public",
        "nudges_received_private",
        "typing_duration_ms",
        "tab_hidden_count",
        "ranking_move_count",
      ],
      ...participants.map((row) => [
        row.participantPseudonym,
        row.sessionPseudonym,
        row.conditionId,
        row.conditionName,
        String(row.round),
        row.interventionMode,
        row.llmMode,
        row.sessionStatus,
        String(row.groupSize),
        row.startedAt ?? "",
        cell(row.entrySubmitted),
        cell(row.age),
        cell(row.agePreferNotToSay),
        cell(row.gender),
        cell(row.genderCustom),
        cell(row.education),
        cell(row.educationOther),
        cell(row.fieldOfStudy),
        cell(row.englishProficiency),
        ...row.gaais.map(cell),
        ...row.tipi.map(cell),
        cell(row.teamworkFrequency),
        cell(row.chatComfort),
        cell(row.topicFamiliarity),
        cell(row.spaceflightFamiliarity),
        cell(row.survivalFamiliarity),
        cell(row.individualRankingCompleted),
        cell(row.individualRankingSecondsUsed),
        cell(row.individualRankingError),
        cell(row.exitSubmitted),
        cell(row.exitRankingError),
        cell(row.satisfaction),
        cell(row.fairness),
        cell(row.feltHeard),
        String(row.messageCount),
        String(row.wordCount),
        String(row.characterCount),
        cell(row.contributionShare),
        cell(row.meaningfulnessScoreMean),
        String(row.classifiedMessageCount),
        String(row.nudgesReceivedTotal),
        String(row.nudgesReceivedPublic),
        String(row.nudgesReceivedPrivate),
        String(row.typingDurationMs),
        String(row.tabHiddenCount),
        String(row.rankingMoveCount),
      ]),
    ]);
  }

  // ── sessions (analysis) ──────────────────────────────────────────

  async exportSessionsAnalysis(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      sessions: (await this.sessions(filter)).map(sessionRow),
    };
  }

  async exportSessionsAnalysisCsv(filter: ResearchFilter = {}): Promise<string> {
    const { sessions } = await this.exportSessionsAnalysis(filter);
    return toCsv([
      [
        "session_pseudonym",
        "condition_id",
        "condition_name",
        "round",
        "intervention_mode",
        "llm_mode",
        "status",
        "n_participants",
        "group_size",
        "created_at",
        "started_at",
        "completed_at",
        "planned_duration_minutes",
        "group_ranking_error",
        "ranking_edit_count",
        "participant_message_count",
        "bot_message_count",
        "word_count_total",
        "share_std_dev",
        "share_gini",
        "intervention_count",
        "interventions_public",
        "interventions_private",
        "windows_evaluated",
        "windows_nudged",
        "windows_no_target",
        "windows_grace_suppressed",
        "windows_baseline_suppressed",
        "classification_count",
        "classification_failure_count",
        "entry_surveys",
        "exit_surveys",
        "mean_satisfaction",
        "mean_fairness",
        "mean_felt_heard",
      ],
      ...sessions.map((row) => [
        row.sessionPseudonym,
        row.conditionId,
        row.conditionName,
        String(row.round),
        row.interventionMode,
        row.llmMode,
        row.status,
        String(row.nParticipants),
        String(row.groupSize),
        row.createdAt,
        row.startedAt ?? "",
        row.completedAt ?? "",
        String(row.plannedDurationMinutes),
        cell(row.groupRankingError),
        String(row.rankingEditCount),
        String(row.participantMessageCount),
        String(row.botMessageCount),
        String(row.wordCountTotal),
        cell(row.shareStdDev),
        cell(row.shareGini),
        String(row.interventionCount),
        String(row.interventionsPublic),
        String(row.interventionsPrivate),
        String(row.windowsEvaluated),
        String(row.windowsNudged),
        String(row.windowsNoTarget),
        String(row.windowsGraceSuppressed),
        String(row.windowsBaselineSuppressed),
        String(row.classificationCount),
        String(row.classificationFailureCount),
        String(row.entrySurveys),
        String(row.exitSurveys),
        cell(row.meanSatisfaction),
        cell(row.meanFairness),
        cell(row.meanFeltHeard),
      ]),
    ]);
  }

  // ── windows ──────────────────────────────────────────────────────

  async exportWindows(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      windows: (await this.sessions(filter)).flatMap((session) =>
        // Explicit shape: research files carry pseudonyms, not Matrix ids.
        (session.windowEvaluations ?? []).map((evaluation) => ({
          sessionPseudonym: pseudonymize("S", session.id),
          conditionId: evaluation.conditionId,
          round: session.roundId,
          interventionMode: interventionModeOf(session),
          llmMode: evaluation.llmMode,
          arm: evaluation.arm,
          windowIndex: evaluation.windowIndex,
          windowStart: evaluation.windowStart,
          windowEnd: evaluation.windowEnd,
          contributionWindowMinutes: evaluation.contributionWindowMinutes,
          threshold: evaluation.threshold,
          outcome: evaluation.outcome,
          maxDominanceScore: evaluation.maxDominanceScore,
          interventionFired: evaluation.outcome === "nudged",
          contributionSplit: evaluation.contributionSplit.map((share) => ({
            participantPseudonym: senderPseudonym(session, share.userId),
            messageCount: share.messageCount,
            wordCount: share.wordCount,
            score: share.score,
            share: share.share,
            meaningfulnessScore: share.meaningfulnessScore,
            dominanceScore: share.dominanceScore,
            isCandidateTarget: evaluation.candidateTargets.some(
              (target) => target.userId === share.userId,
            ),
            wasNudged: wasNudged(session, evaluation, share.userId),
          })),
        })),
      ),
    };
  }

  /**
   * Long format: one row per window × participant, loadable straight into
   * mixed-effects models. Windows with no computed split (warm-up, wrap-up,
   * too few participants) emit one row with the participant columns empty so
   * every evaluated boundary stays visible.
   */
  async exportWindowsCsv(filter: ResearchFilter = {}): Promise<string> {
    const sessions = await this.sessions(filter);
    const rows: string[][] = [];
    for (const session of sessions) {
      for (const evaluation of session.windowEvaluations ?? []) {
        const windowCells = [
          pseudonymize("S", session.id),
          session.condition.id,
          String(session.roundId),
          interventionModeOf(session),
          evaluation.llmMode,
          evaluation.arm,
          String(evaluation.windowIndex),
          evaluation.windowStart,
          evaluation.windowEnd,
          String(evaluation.contributionWindowMinutes),
          String(evaluation.threshold),
          evaluation.outcome,
          cell(evaluation.maxDominanceScore),
          evaluation.outcome === "nudged" ? "true" : "false",
        ];
        if (evaluation.contributionSplit.length === 0) {
          rows.push([...windowCells, "", "", "", "", "", "", "", "", ""]);
          continue;
        }
        for (const share of evaluation.contributionSplit) {
          rows.push([
            ...windowCells,
            senderPseudonym(session, share.userId),
            String(share.messageCount),
            String(share.wordCount),
            String(share.score),
            String(share.share),
            String(share.meaningfulnessScore),
            String(share.dominanceScore),
            evaluation.candidateTargets.some(
              (target) => target.userId === share.userId,
            )
              ? "true"
              : "false",
            wasNudged(session, evaluation, share.userId) ? "true" : "false",
          ]);
        }
      }
    }
    return toCsv([
      [
        "session_pseudonym",
        "condition_id",
        "round",
        "intervention_mode",
        "llm_mode",
        "arm",
        "window_index",
        "window_start",
        "window_end",
        "window_minutes",
        "threshold",
        "outcome",
        "max_dominance_score",
        "intervention_fired",
        "participant_pseudonym",
        "message_count",
        "word_count",
        "score",
        "share",
        "meaningfulness_score",
        "dominance_score",
        "is_candidate_target",
        "was_nudged",
      ],
      ...rows,
    ]);
  }

  // ── messages (pseudonymized research variant, bundle only) ──────

  async exportResearchMessagesCsv(filter: ResearchFilter = {}): Promise<string> {
    const sessions = await this.sessions(filter);
    return toCsv([
      [
        "session_pseudonym",
        "condition_id",
        "round",
        "message_id",
        "timestamp",
        "sender_pseudonym",
        "sender_is_bot",
        "recipient_pseudonym",
        "text",
        "word_count",
      ],
      ...sessions.flatMap((session) =>
        session.chat.messages.map((message) => [
          pseudonymize("S", session.id),
          session.condition.id,
          String(session.roundId),
          message.id,
          message.timestamp,
          senderPseudonym(session, message.senderId),
          isServiceUser(message.senderId) ? "true" : "false",
          message.recipientId
            ? senderPseudonym(session, message.recipientId)
            : "",
          message.text,
          String(countWords(message.text)),
        ]),
      ),
    ]);
  }

  // ── rankings (raw orders + group edit history) ──────────────────

  /**
   * One row per ranking: each participant's entry and exit ranking, every
   * shared-ranking edit, and the group's final order. Enables item-level
   * analyses (which items are systematically misplaced, convergence toward
   * the expert solution) that the error scores alone cannot support.
   */
  async exportRankings(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      rankings: (await this.sessions(filter)).flatMap(rankingRows),
    };
  }

  async exportRankingsCsv(filter: ResearchFilter = {}): Promise<string> {
    const { rankings } = await this.exportRankings(filter);
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

  // ── linkage (identifying — never in the bundle) ─────────────────

  async exportLinkageCsv(filter: ResearchFilter = {}): Promise<string> {
    const sessions = await this.sessions(filter);
    return toCsv([
      [
        "participant_pseudonym",
        "session_pseudonym",
        "round",
        "participant_id",
        "session_id",
        "tracking_token",
        "matrix_user_id",
      ],
      ...sessions.flatMap((session) =>
        session.participants.map((participant) => [
          pseudonymize("P", participant.id),
          pseudonymize("S", session.id),
          String(session.roundId),
          participant.id,
          session.id,
          participant.trackingToken,
          participant.matrixUserId ?? "",
        ]),
      ),
    ]);
  }

  // ── dashboard summary ────────────────────────────────────────────

  async summary(filter: ResearchFilter = {}): Promise<ReportsSummaryResponse> {
    const sessions = await this.sessions(filter);
    const conditions = (await this.store.listConditions()).filter(
      (condition) =>
        !condition.id.startsWith("e2e-") &&
        ((filter.conditionIds ?? []).length === 0 ||
          filter.conditionIds!.includes(condition.id)),
    );
    const byCondition = new Map<string, Session[]>();
    for (const session of sessions) {
      const group = byCondition.get(session.condition.id) ?? [];
      group.push(session);
      byCondition.set(session.condition.id, group);
    }
    // Conditions with sessions but no longer in the conditions table (e.g.
    // deleted pilot arms) still get a summary row.
    const ids = [
      ...conditions.map((condition) => condition.id),
      ...[...byCondition.keys()].filter(
        (id) => !conditions.some((condition) => condition.id === id),
      ),
    ];
    return {
      generatedAt: new Date().toISOString(),
      conditions: ids.map((conditionId) =>
        conditionSummary(
          conditionId,
          conditions.find((condition) => condition.id === conditionId)?.name,
          byCondition.get(conditionId) ?? [],
          conditions.find((condition) => condition.id === conditionId),
        ),
      ),
    };
  }

  // ── bundle ───────────────────────────────────────────────────────

  /** All research CSVs + the codebook, zipped. Excludes linkage.csv. */
  async bundleZip(filter: ResearchFilter = {}): Promise<Buffer> {
    const [participants, sessionsAnalysis, windows, rankings, messages] =
      await Promise.all([
        this.exportParticipantsCsv(filter),
        this.exportSessionsAnalysisCsv(filter),
        this.exportWindowsCsv(filter),
        this.exportRankingsCsv(filter),
        this.exportResearchMessagesCsv(filter),
      ]);
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", reject);
    });
    archive.append(participants, { name: "participants.csv" });
    archive.append(sessionsAnalysis, { name: "sessions_analysis.csv" });
    archive.append(windows, { name: "windows.csv" });
    archive.append(rankings, { name: "rankings.csv" });
    archive.append(messages, { name: "messages.csv" });
    archive.append(codebook(new Date().toISOString()), { name: "codebook.md" });
    await archive.finalize();
    await finished;
    return Buffer.concat(chunks);
  }
}

// ── row builders ───────────────────────────────────────────────────

function interventionModeOf(session: Session): string {
  return (
    session.condition.config.interventionMode ??
    DEFAULT_INTERVENTION_CONFIG.interventionMode
  );
}

function llmModeOf(session: Session): string {
  return session.condition.config.llmMode ?? "off";
}

function wasNudged(
  session: Session,
  evaluation: WindowEvaluation,
  userId: string,
): boolean {
  if (!evaluation.interventionId) return false;
  const intervention = session.interventions.find(
    (item) => item.id === evaluation.interventionId,
  );
  return intervention?.targets.some((target) => target.userId === userId) ?? false;
}

function answer(
  survey: Survey | undefined,
  key: string,
): string | number | boolean | string[] | null {
  const value = survey?.answers[key];
  return value === undefined ? null : value;
}

function scalarAnswer(
  survey: Survey | undefined,
  key: string,
): string | number | boolean | null {
  const value = answer(survey, key);
  return Array.isArray(value) ? null : value;
}

function rankingAnswer(
  survey: Survey | undefined,
  key: string,
): string[] | undefined {
  const value = answer(survey, key);
  return Array.isArray(value) ? value : undefined;
}

interface RankingRow {
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

function rankingRows(session: Session): RankingRow[] {
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

function participantRow(session: Session, participant: Participant) {
  const entry = participant.entrySurvey;
  const exit = participant.exitSurvey;
  const matrixUserId = participant.matrixUserId;
  const messages = session.chat.messages.filter(
    (message) =>
      matrixUserId !== undefined && message.senderId === matrixUserId,
  );
  const wordCount = messages.reduce(
    (sum, message) => sum + countWords(message.text),
    0,
  );
  const scores = contributionScores(session);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const index = session.participants.indexOf(participant);
  const contributionShare =
    total > 0 && index >= 0 ? round(scores[index] / total) : null;
  const classifications = session.contributionClassifications.filter(
    (item) => matrixUserId !== undefined && item.senderId === matrixUserId,
  );
  const nudges = session.interventions.filter(
    (intervention) =>
      matrixUserId !== undefined &&
      intervention.targets.some((target) => target.userId === matrixUserId),
  );
  const behavior = (type: string) =>
    session.behavioralEvents.filter(
      (event) =>
        matrixUserId !== undefined &&
        event.participantId === matrixUserId &&
        event.type === type,
    );
  const rankingCompleted = scalarAnswer(entry, "rankingCompleted");

  return {
    participantPseudonym: pseudonymize("P", participant.id),
    sessionPseudonym: pseudonymize("S", session.id),
    conditionId: session.condition.id,
    conditionName: session.condition.name,
    round: session.roundId,
    interventionMode: interventionModeOf(session),
    llmMode: llmModeOf(session),
    sessionStatus: session.status,
    groupSize: session.condition.groupSize,
    startedAt: session.startedAt ?? null,
    entrySubmitted: entry ? true : null,
    age: scalarAnswer(entry, "age"),
    agePreferNotToSay: scalarAnswer(entry, "agePreferNotToSay"),
    gender: scalarAnswer(entry, "gender"),
    genderCustom: scalarAnswer(entry, "genderCustom"),
    education: scalarAnswer(entry, "education"),
    educationOther: scalarAnswer(entry, "educationOther"),
    fieldOfStudy: scalarAnswer(entry, "fieldOfStudy"),
    englishProficiency: scalarAnswer(entry, "englishProficiency"),
    gaais: Array.from({ length: 10 }, (_, i) =>
      scalarAnswer(entry, `gaais${i + 1}`),
    ),
    tipi: Array.from({ length: 10 }, (_, i) =>
      scalarAnswer(entry, `tipi${i + 1}`),
    ),
    teamworkFrequency: scalarAnswer(entry, "teamworkFrequency"),
    chatComfort: scalarAnswer(entry, "chatComfort"),
    topicFamiliarity: scalarAnswer(entry, "topicFamiliarity"),
    spaceflightFamiliarity: scalarAnswer(entry, "spaceflightFamiliarity"),
    survivalFamiliarity: scalarAnswer(entry, "survivalFamiliarity"),
    individualRankingCompleted: rankingCompleted,
    individualRankingSecondsUsed: scalarAnswer(entry, "rankingSecondsUsed"),
    // Timed-out entry rankings are auto-completed in shown order, so only
    // rankings the participant explicitly finished are scored.
    individualRankingError:
      rankingCompleted === true
        ? rankingErrorScore(rankingAnswer(entry, "individualRanking"))
        : null,
    exitSubmitted: exit ? true : null,
    exitRankingError: rankingErrorScore(rankingAnswer(exit, "finalRanking")),
    satisfaction: scalarAnswer(exit, "satisfaction"),
    fairness: scalarAnswer(exit, "fairness"),
    feltHeard: scalarAnswer(exit, "feltHeard"),
    messageCount: messages.length,
    wordCount,
    characterCount: messages.reduce(
      (sum, message) => sum + message.text.length,
      0,
    ),
    contributionShare,
    meaningfulnessScoreMean:
      classifications.length > 0
        ? round(
            classifications.reduce(
              (sum, item) => sum + item.meaningfulnessScore,
              0,
            ) / classifications.length,
          )
        : null,
    classifiedMessageCount: classifications.length,
    nudgesReceivedTotal: nudges.length,
    nudgesReceivedPublic: nudges.filter((n) => n.audience === "public").length,
    nudgesReceivedPrivate: nudges.filter((n) => n.audience === "private").length,
    typingDurationMs: behavior("typing-stop").reduce(
      (sum, event) => sum + (event.durationMs ?? 0),
      0,
    ),
    tabHiddenCount: behavior("tab-hidden").length,
    rankingMoveCount: behavior("ranking-move").length,
  };
}

function sessionRow(session: Session) {
  const participantMessages = session.chat.messages.filter(
    (message) => !isServiceUser(message.senderId),
  );
  const scores = contributionScores(session);
  const windows = session.windowEvaluations ?? [];
  const exitSurveys = session.participants
    .map((participant) => participant.exitSurvey)
    .filter((survey): survey is Survey => survey !== undefined);
  const exitScale = (key: string) =>
    meanOf(
      exitSurveys.map((survey) => {
        const value = scalarAnswer(survey, key);
        return typeof value === "number" ? value : null;
      }),
    );

  return {
    sessionPseudonym: pseudonymize("S", session.id),
    conditionId: session.condition.id,
    conditionName: session.condition.name,
    round: session.roundId,
    interventionMode: interventionModeOf(session),
    llmMode: llmModeOf(session),
    status: session.status,
    nParticipants: session.participants.length,
    groupSize: session.condition.groupSize,
    createdAt: session.createdAt,
    startedAt: session.startedAt ?? null,
    completedAt: session.completedAt ?? null,
    plannedDurationMinutes: session.durationMinutes,
    // Computable even with zero edits (the shuffled starting order) — always
    // read together with rankingEditCount.
    groupRankingError: rankingErrorScore(session.ranking.order),
    rankingEditCount: session.rankingHistory?.length ?? 0,
    participantMessageCount: participantMessages.length,
    botMessageCount:
      session.chat.messages.length - participantMessages.length,
    wordCountTotal: participantMessages.reduce(
      (sum, message) => sum + countWords(message.text),
      0,
    ),
    shareStdDev: roundOrNull(shareStdDev(scores)),
    shareGini: roundOrNull(gini(scores)),
    interventionCount: session.interventions.length,
    interventionsPublic: session.interventions.filter(
      (item) => item.audience === "public",
    ).length,
    interventionsPrivate: session.interventions.filter(
      (item) => item.audience === "private",
    ).length,
    windowsEvaluated: windows.length,
    windowsNudged: windows.filter((w) => w.outcome === "nudged").length,
    windowsNoTarget: windows.filter((w) => w.outcome === "no-target").length,
    windowsGraceSuppressed: windows.filter(
      (w) => w.outcome === "grace-suppressed",
    ).length,
    windowsBaselineSuppressed: windows.filter(
      (w) => w.outcome === "baseline-suppressed",
    ).length,
    classificationCount: session.contributionClassifications.length,
    classificationFailureCount: (session.classificationFailures ?? []).length,
    entrySurveys: session.participants.filter((p) => p.entrySurvey).length,
    exitSurveys: exitSurveys.length,
    meanSatisfaction: roundOrNull(exitScale("satisfaction")),
    meanFairness: roundOrNull(exitScale("fairness")),
    meanFeltHeard: roundOrNull(exitScale("feltHeard")),
  };
}

function conditionSummary(
  conditionId: string,
  conditionName: string | undefined,
  sessions: Session[],
  condition?: Condition,
): ConditionReportSummary {
  const completed = sessions.filter((s) => s.status === "completed");
  const rows = completed.map(sessionRow);
  const participantRows = completed.flatMap((session) =>
    session.participants.map((participant) =>
      participantRow(session, participant),
    ),
  );
  const config = condition?.config ?? sessions[0]?.condition.config;
  const numeric = (values: Array<number | boolean | string | null>) =>
    meanOf(values.map((v) => (typeof v === "number" ? v : null)));

  return {
    conditionId,
    conditionName: conditionName ?? sessions[0]?.condition.name ?? conditionId,
    interventionMode:
      config?.interventionMode ?? DEFAULT_INTERVENTION_CONFIG.interventionMode,
    llmMode: config?.llmMode ?? "off",
    sessionsCompleted: completed.length,
    sessionsAborted: sessions.filter((s) => s.status === "aborted").length,
    sessionsRunning: sessions.filter((s) => s.status === "running").length,
    participants: sessions.reduce(
      (sum, session) => sum + session.participants.length,
      0,
    ),
    entrySurveys: sessions.reduce(
      (sum, session) =>
        sum + session.participants.filter((p) => p.entrySurvey).length,
      0,
    ),
    exitSurveys: sessions.reduce(
      (sum, session) =>
        sum + session.participants.filter((p) => p.exitSurvey).length,
      0,
    ),
    meanGroupRankingError: roundOrNull(
      meanOf(rows.map((row) => row.groupRankingError)),
    ),
    meanIndividualRankingError: roundOrNull(
      numeric(participantRows.map((row) => row.individualRankingError)),
    ),
    meanExitRankingError: roundOrNull(
      numeric(participantRows.map((row) => row.exitRankingError)),
    ),
    meanSatisfaction: roundOrNull(
      numeric(participantRows.map((row) => row.satisfaction)),
    ),
    meanFairness: roundOrNull(
      numeric(participantRows.map((row) => row.fairness)),
    ),
    meanFeltHeard: roundOrNull(
      numeric(participantRows.map((row) => row.feltHeard)),
    ),
    meanShareStdDev: roundOrNull(meanOf(rows.map((row) => row.shareStdDev))),
    meanShareGini: roundOrNull(meanOf(rows.map((row) => row.shareGini))),
    nudgesTotal: completed.reduce(
      (sum, session) => sum + session.interventions.length,
      0,
    ),
    nudgesPerSessionMean:
      completed.length > 0
        ? round(
            completed.reduce(
              (sum, session) => sum + session.interventions.length,
              0,
            ) / completed.length,
          )
        : null,
    windowsEvaluated: completed.reduce(
      (sum, session) => sum + (session.windowEvaluations?.length ?? 0),
      0,
    ),
    windowsNudged: completed.reduce(
      (sum, session) =>
        sum +
        (session.windowEvaluations ?? []).filter(
          (window) => window.outcome === "nudged",
        ).length,
      0,
    ),
  };
}

// ── formatting ─────────────────────────────────────────────────────

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : round(value);
}

/** CSV cell for a nullable scalar: empty when null/undefined. */
function cell(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

// ── codebook ───────────────────────────────────────────────────────

function codebook(generatedAt: string): string {
  const itemCount = MOON_SURVIVAL.items.length;
  const maximumError =
    rankingErrorScore(
      Object.entries(MOON_SURVIVAL_EXPERT_RANKING)
        .sort(([, a], [, b]) => b - a)
        .map(([id]) => id),
    ) ?? 0;
  const expertKey = MOON_SURVIVAL.items
    .map(
      (item) =>
        `| ${item.id} | ${item.label} | ${MOON_SURVIVAL_EXPERT_RANKING[item.id]} |`,
    )
    .join("\n");
  return `# GDM Study — Research Data Codebook

Generated: ${generatedAt}

## 1. Study design

Group decision-making sessions on the NASA "Survival on the Moon" ranking
task. A turn-taking bot evaluates contribution dominance at the end of every
contribution window and may nudge the most dominant member. Arms differ on
two axes:

- **Delivery** (\`intervention_mode\`): \`baseline\` (bot never posts),
  \`public\` (nudge visible to the whole group), \`private\` (nudge rendered
  only to the target).
- **Detection** (\`llm_mode\`): \`off\` (rule-based contribution share) or
  \`active\` (composite dominance = 0.90 × share + 0.10 × LLM-scored
  meaningfulness).

All exports accept \`?conditionIds=a,b,c\` to restrict to specific arms and
\`?roundIds=1,2\` to restrict to specific study rounds. Sessions from
\`e2e-…\` test conditions are always excluded.

### Study rounds

The study runs in numbered rounds; every session is stamped with the round
open at its creation (the \`round\` column in every file) and never changes
rounds. Session & Bot Parameters may differ between rounds — each session's
frozen condition snapshot carries the values that actually applied, and
windows.csv rows carry their own \`window_minutes\` and \`threshold\`, so
per-round parameter changes are fully reconstructable from the data.

## 2. Pseudonymization

Sessions are \`S-xxxxxxxx\`, participants \`P-xxxxxxxx\` — the first 8 hex
chars of SHA-256 over the internal UUID (never the Prolific token). The same
entity has the same pseudonym in every file and every re-download.
Pseudonyms are not ordered; sort by \`started_at\`. Bot senders appear as
\`BOT\` (or \`BOT-A\`/\`BOT-B\` in pilot comparison sessions).

The separate \`linkage.csv\` export (deliberately NOT in this bundle) maps
pseudonyms to Prolific tracking tokens and Matrix ids for compensation and
exclusions. Treat it as identifying data; keep it out of analysis folders.

## 3. Files

### participants.csv — one row per participant

| Column | Meaning |
| --- | --- |
| participant_pseudonym / session_pseudonym | Stable pseudonymous ids |
| condition_id / condition_name / intervention_mode / llm_mode | Arm, from the session's frozen condition snapshot |
| session_status | waiting / running / completed / aborted — filter on \`completed\` for analysis |
| group_size / started_at | Session context |
| entry_submitted / exit_submitted | \`true\` or empty (survey missing) |
| age, age_prefer_not_to_say | Participant age or \`true\` if they declined to answer |
| gender, gender_custom | Gender identity; gender_custom filled when "self-describe" selected |
| education, education_other | Highest education level; education_other filled when "other" selected |
| field_of_study | Legacy field (pre-v2 forms only, empty for newer submissions) |
| english_proficiency | English proficiency level (native_bilingual / fluent / intermediate) |
| gaais1–gaais10 | GAAIS AI attitude items (1=disagree strongly … 5=agree strongly) |
| tipi1–tipi10 | TIPI personality items (1=disagree strongly … 7=agree strongly) |
| teamwork_frequency | How often participant works in teams (never/rarely/sometimes/often/very_often) |
| chat_comfort | Text-chat comfort (1–5, legacy 1–7) |
| topic_familiarity | Legacy combined spaceflight/survival familiarity (1–7, older data only) |
| spaceflight_familiarity | Spaceflight topic familiarity (1–5) |
| survival_familiarity | Wilderness/survival topic familiarity (1–5) |
| individual_ranking_completed | \`false\` = the entry ranking timed out and was auto-completed in shown order |
| individual_ranking_seconds_used | Time spent on the individual ranking |
| individual_ranking_error | NASA error score of the entry ranking; empty unless completed = true |
| exit_ranking_error | NASA error score of the participant's final individual ranking (exit survey) |
| satisfaction, fairness, felt_heard | Exit 1–7 scales |
| message_count, word_count, character_count | This participant's chat activity (bot messages never count) |
| contribution_share | Share of the session's total contribution score (messages × ${DEFAULT_INTERVENTION_CONFIG.scoreWeights.messages} + words × ${DEFAULT_INTERVENTION_CONFIG.scoreWeights.words}, weights from the condition snapshot) |
| meaningfulness_score_mean / classified_message_count | LLM classifier aggregates (llm arms only) |
| nudges_received_total / _public / _private | Bot nudges targeting this participant |
| typing_duration_ms, tab_hidden_count, ranking_move_count | Behavioral telemetry aggregates |

### sessions_analysis.csv — one row per session

Includes aborted/running sessions with their \`status\`; compute descriptives
over \`status = completed\`. \`group_ranking_error\` is defined even with
zero edits (the shuffled starting order) — read with \`ranking_edit_count\`.
\`share_std_dev\` (SD of contribution shares; 0 = equal) and \`share_gini\`
(Gini of contribution scores; 0 = equal) are the participation-equality
outcomes. Window outcome counts (\`windows_*\`) summarize windows.csv.
\`classification_failure_count\` reports LLM coverage gaps (failed API
calls); messages that failed classification are absent from meaningfulness
means rather than counted as 0.

### windows.csv — one row per evaluated window × participant (long format)

Every contribution-window boundary produces exactly one evaluation per
engine (\`arm\` = \`primary\`, or \`a\`/\`b\` in pilot comparison sessions).
\`outcome\` glossary:

- \`nudged\` — a nudge fired (\`intervention_fired\` = true; \`was_nudged\`
  marks the targeted participant)
- \`no-target\` — nobody crossed the threshold
- \`grace-suppressed\` — only members inside the invite grace period crossed it
- \`baseline-suppressed\` — baseline arm: a member crossed the threshold but
  nothing was delivered (counterfactual)
- \`warm-up\` / \`wrap-up\` / \`too-few-participants\` — boundary not
  evaluated; participant columns empty

The contribution tracker resets after each fired nudge, so scores reflect
activity since the last nudge (or warm-up end), not cumulative history.
Windows exist only for sessions run after this instrumentation was deployed.

### rankings.csv — one row per ranking (raw orders)

The raw material behind every error score, for item-level analyses (which
items are systematically misplaced, convergence toward the expert
solution). \`type\`:

- \`entry\` — the participant's individual ranking before the discussion
  (\`ranking_completed\` = false means it timed out and was auto-completed
  in shown order; such rows carry no \`error\`)
- \`exit\` — the participant's fresh individual ranking after the discussion
- \`group-edit\` — one state of the shared group ranking; \`edit_index\`
  orders the history (0 = first recorded state) and
  \`participant_pseudonym\` is the member who produced it
- \`group-final\` — the group's final order at session end

The ${itemCount} item columns hold the rank (1..${itemCount}) assigned to that item in this
row's order; compare against the expert key below.

### messages.csv — one row per chat message

Pseudonymized senders; \`sender_is_bot\` = true for nudges;
\`recipient_pseudonym\` set only on private nudges. Message text is
participant-authored free text.

## 4. Ranking scoring

NASA error score = Σ over items of |assigned rank − expert rank|
(0 = perfect, ${maximumError} = fully reversed). Expert key:

| Item id | Label | Expert rank |
| --- | --- | --- |
${expertKey}

## 5. Known caveats

- Bot messages appear in messages.csv (and in the legacy overview
  message_count) but never count toward contribution scores or shares.
- Emoji reactions were removed from the chat UI per study protocol; reaction
  counts are always 0.
- Historical sessions run before window instrumentation have no windows.csv
  rows and no classification-failure accounting.
- Entry rankings that timed out (\`individual_ranking_completed\` = false)
  are auto-completed permutations; they are not scored.
`;
}
