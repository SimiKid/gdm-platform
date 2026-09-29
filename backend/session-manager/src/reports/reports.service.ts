import { Injectable, Optional } from "@nestjs/common";
import { EtherpadService } from "../etherpad/etherpad.service";
import type { Session } from "@gdm/shared";
import { StoreService } from "../store/store.service";
import { codebook, ETHERPAD_CODEBOOK } from "./codebook";
import { etherpadCsv, researchPad } from "./etherpad-rows";
import {
  filterResearchPads,
  filterResearchSessions,
  type ResearchFilter,
} from "./filter";
import { linkageCsv } from "./linkage";
import { messagesFlatCsv, researchMessagesCsv } from "./message-rows";
import { participantRow, participantsCsv } from "./participant-rows";
import { rankingRows, rankingsCsv } from "./ranking-rows";
import { resultsCsv } from "./results-rows";
import { sessionRow, sessionsAnalysisCsv } from "./session-rows";
import { windowRows, windowsCsv } from "./window-rows";
import { zipFiles, type ZipEntry } from "./zip";

/**
 * Analysis-ready research exports and the Overview tab's research-data zip.
 *
 * Everything here is derived on read from the sessions the StoreService
 * returns — no separate report state. All research files use pseudonymous
 * ids only; the linkage export (never part of the bundle) maps them back to
 * Prolific tokens for compensation and exclusions.
 *
 * This service loads and filters sessions and assembles the bundles; the
 * per-file row builders and the codebook live in sibling modules.
 */
@Injectable()
export class ReportsService {
  private readonly bundleInFlight = new Map<string, Promise<Buffer>>();
  private bundleQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: StoreService, @Optional() private readonly etherpad?: EtherpadService) {}

  async exportEtherpad(filter: ResearchFilter = {}, snapshot?: Session[]) {
    const sessions = snapshot ?? await this.sessions(filter);
    const pads = filterResearchPads(await this.etherpad?.documents() ?? [], sessions, filter)
      .map(researchPad);
    return { generatedAt: new Date().toISOString(), pads };
  }

  async exportEtherpadCsv(filter: ResearchFilter = {}, snapshot?: Session[]): Promise<string> {
    return etherpadCsv((await this.exportEtherpad(filter, snapshot)).pads);
  }

  private async sessions(filter: ResearchFilter): Promise<Session[]> {
    return filterResearchSessions(await this.store.allSessions(), filter);
  }

  // ── participants ─────────────────────────────────────────────────

  async exportParticipants(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ) {
    return {
      generatedAt: new Date().toISOString(),
      participants: (snapshot ?? (await this.sessions(filter))).flatMap((session) =>
        session.participants.map((participant) =>
          participantRow(session, participant),
        ),
      ),
    };
  }

  async exportParticipantsCsv(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ): Promise<string> {
    const { participants } = await this.exportParticipants(filter, snapshot);
    return participantsCsv(participants);
  }

  // ── sessions (analysis) ──────────────────────────────────────────

  async exportSessionsAnalysis(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ) {
    return {
      generatedAt: new Date().toISOString(),
      sessions: (snapshot ?? (await this.sessions(filter))).map(sessionRow),
    };
  }

  async exportSessionsAnalysisCsv(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ): Promise<string> {
    const { sessions } = await this.exportSessionsAnalysis(filter, snapshot);
    return sessionsAnalysisCsv(sessions);
  }

  // ── windows ──────────────────────────────────────────────────────

  async exportWindows(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      windows: windowRows(await this.sessions(filter)),
    };
  }

  /** Long format: one row per window × participant (see windowsCsv). */
  async exportWindowsCsv(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ): Promise<string> {
    return windowsCsv(snapshot ?? (await this.sessions(filter)));
  }

  // ── messages (pseudonymized research variant, bundle only) ──────

  async exportResearchMessagesCsv(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ): Promise<string> {
    return researchMessagesCsv(snapshot ?? (await this.sessions(filter)));
  }

  // ── rankings (raw orders + group edit history) ──────────────────

  /**
   * One row per ranking: each participant's entry and exit ranking, every
   * shared-ranking edit, and the group's final order. Enables item-level
   * analyses (which items are systematically misplaced, convergence toward
   * the expert solution) that the error scores alone cannot support.
   */
  async exportRankings(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ) {
    return {
      generatedAt: new Date().toISOString(),
      rankings: (snapshot ?? (await this.sessions(filter))).flatMap(rankingRows),
    };
  }

  async exportRankingsCsv(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ): Promise<string> {
    const { rankings } = await this.exportRankings(filter, snapshot);
    return rankingsCsv(rankings);
  }

  // ── linkage (identifying — never in the bundle) ─────────────────

  async exportLinkageCsv(filter: ResearchFilter = {}): Promise<string> {
    return linkageCsv(await this.sessions(filter));
  }

  // ── research-data exports (Overview tab) ──────────────────────────

  async exportResultsCsv(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ): Promise<string> {
    return resultsCsv(snapshot ?? (await this.sessions(filter)));
  }

  /** One row per chat message (see messagesFlatCsv). */
  async exportMessagesFlatCsv(
    filter: ResearchFilter = {},
    snapshot?: Session[],
  ): Promise<string> {
    return messagesFlatCsv(snapshot ?? (await this.sessions(filter)));
  }

  async bundleResearchDataZip(filter: ResearchFilter = {}): Promise<Buffer> {
    const snapshot = await this.sessions(filter);
    const [results, messages, { pads }] = await Promise.all([
      this.exportResultsCsv(filter, snapshot),
      this.exportMessagesFlatCsv(filter, snapshot),
      this.exportEtherpad(filter, snapshot),
    ]);
    return zipFiles([
      ["results.csv", results],
      ["messages.csv", messages],
      ...(pads.length ? [["etherpad.csv", etherpadCsv(pads)] as ZipEntry] : []),
    ]);
  }

  bundleZip(filter: ResearchFilter = {}): Promise<Buffer> {
    const key = bundleFilterKey(filter);
    const current = this.bundleInFlight.get(key);
    if (current) return current;

    const queued = this.enqueueBundle(filter);
    this.bundleInFlight.set(key, queued);
    void queued
      .finally(() => {
        if (this.bundleInFlight.get(key) === queued) {
          this.bundleInFlight.delete(key);
        }
      })
      .catch(() => undefined);
    return queued;
  }

  private enqueueBundle(filter: ResearchFilter): Promise<Buffer> {
    const previous = this.bundleQueue;
    let release!: () => void;
    this.bundleQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .then(() => this.buildBundle(filter))
      .finally(() => release());
  }

  private async buildBundle(filter: ResearchFilter): Promise<Buffer> {
    // Hydrating a session includes all related research records. Reuse one
    // filtered snapshot instead of issuing five large relation queries at
    // once, which can exhaust Prisma's connection pool on real study data.
    const snapshot = await this.sessions(filter);
    const [participants, sessionsAnalysis, windows, rankings, messages, { pads }] =
      await Promise.all([
        this.exportParticipantsCsv(filter, snapshot),
        this.exportSessionsAnalysisCsv(filter, snapshot),
        this.exportWindowsCsv(filter, snapshot),
        this.exportRankingsCsv(filter, snapshot),
        this.exportResearchMessagesCsv(filter, snapshot),
        this.exportEtherpad(filter, snapshot),
      ]);
    const hasPads = pads.length > 0;
    return zipFiles([
      ["participants.csv", participants],
      ["sessions_analysis.csv", sessionsAnalysis],
      ["windows.csv", windows],
      ["rankings.csv", rankings],
      ["messages.csv", messages],
      ["codebook.md", codebook(new Date().toISOString()) + (hasPads ? ETHERPAD_CODEBOOK : "")],
      ...(hasPads ? [["etherpad.csv", etherpadCsv(pads)] as ZipEntry] : []),
    ]);
  }
}

function bundleFilterKey(filter: ResearchFilter): string {
  return JSON.stringify({
    conditionIds: [...(filter.conditionIds ?? [])].sort(),
    roundIds: [...(filter.roundIds ?? [])].sort((a, b) => a - b),
  });
}
