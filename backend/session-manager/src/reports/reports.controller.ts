import {
  Controller,
  Get,
  Header,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { ReportsSummaryResponse } from "@gdm/shared";
import { AdminGuard } from "../auth/admin.guard";
import { ReportsService } from "./reports.service";
import { parseConditionIds, parseRoundIds } from "./filter";

/**
 * Analysis-ready research exports (pseudonymized) and the dashboard Results
 * summary. The legacy raw exports stay on the sessions controller; these are
 * the files a researcher loads into R/SPSS directly.
 */
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Per-condition descriptives for the dashboard Results tab. */
  @Get("reports/summary")
  @UseGuards(AdminGuard)
  summary(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<ReportsSummaryResponse> {
    return this.reports.summary(researchFilter(conditionIds, roundIds));
  }

  /** One row per participant, surveys + activity joined, pseudonymized. */
  @Get("export/participants")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="participants.json"')
  exportParticipants(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.reports.exportParticipants(researchFilter(conditionIds, roundIds));
  }

  @Get("export/participants.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="participants.csv"')
  exportParticipantsCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.reports.exportParticipantsCsv(researchFilter(conditionIds, roundIds));
  }

  /** One row per session with derived analysis measures. */
  @Get("export/sessions-analysis")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="sessions_analysis.json"')
  exportSessionsAnalysis(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.reports.exportSessionsAnalysis(researchFilter(conditionIds, roundIds));
  }

  @Get("export/sessions-analysis.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="sessions_analysis.csv"')
  exportSessionsAnalysisCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.reports.exportSessionsAnalysisCsv(
      researchFilter(conditionIds, roundIds),
    );
  }

  /** Every evaluated contribution window (fired or not). */
  @Get("export/windows")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="windows.json"')
  exportWindows(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.reports.exportWindows(researchFilter(conditionIds, roundIds));
  }

  @Get("export/windows.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="windows.csv"')
  exportWindowsCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.reports.exportWindowsCsv(researchFilter(conditionIds, roundIds));
  }

  /** Raw ranking orders: entry/exit individual + group edit history. */
  @Get("export/rankings")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="rankings.json"')
  exportRankings(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.reports.exportRankings(researchFilter(conditionIds, roundIds));
  }

  @Get("export/rankings.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="rankings.csv"')
  exportRankingsCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.reports.exportRankingsCsv(researchFilter(conditionIds, roundIds));
  }

  /**
   * Identifying pseudonym → Prolific/Matrix mapping. Deliberately CSV-only
   * and never part of the research bundle.
   */
  @Get("export/linkage.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="linkage.csv"')
  exportLinkageCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.reports.exportLinkageCsv(researchFilter(conditionIds, roundIds));
  }

  /** All research CSVs + codebook.md in one zip (linkage excluded). */
  @Get("export/research.zip")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "application/zip")
  @Header("Content-Disposition", 'attachment; filename="research_bundle.zip"')
  async exportResearchZip(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<StreamableFile> {
    const zip = await this.reports.bundleZip(researchFilter(conditionIds, roundIds));
    return new StreamableFile(zip);
  }
}

function researchFilter(conditionIds?: string, roundIds?: string) {
  return {
    conditionIds: parseConditionIds(conditionIds),
    roundIds: parseRoundIds(roundIds),
  };
}
