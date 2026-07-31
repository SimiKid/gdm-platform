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
import { parseConditionIds } from "./filter";

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
  ): Promise<ReportsSummaryResponse> {
    return this.reports.summary(parseConditionIds(conditionIds));
  }

  /** One row per participant, surveys + activity joined, pseudonymized. */
  @Get("export/participants")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="participants.json"')
  exportParticipants(@Query("conditionIds") conditionIds?: string) {
    return this.reports.exportParticipants(parseConditionIds(conditionIds));
  }

  @Get("export/participants.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="participants.csv"')
  exportParticipantsCsv(
    @Query("conditionIds") conditionIds?: string,
  ): Promise<string> {
    return this.reports.exportParticipantsCsv(parseConditionIds(conditionIds));
  }

  /** One row per session with derived analysis measures. */
  @Get("export/sessions-analysis")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="sessions_analysis.json"')
  exportSessionsAnalysis(@Query("conditionIds") conditionIds?: string) {
    return this.reports.exportSessionsAnalysis(parseConditionIds(conditionIds));
  }

  @Get("export/sessions-analysis.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="sessions_analysis.csv"')
  exportSessionsAnalysisCsv(
    @Query("conditionIds") conditionIds?: string,
  ): Promise<string> {
    return this.reports.exportSessionsAnalysisCsv(
      parseConditionIds(conditionIds),
    );
  }

  /** Every evaluated contribution window (fired or not). */
  @Get("export/windows")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="windows.json"')
  exportWindows(@Query("conditionIds") conditionIds?: string) {
    return this.reports.exportWindows(parseConditionIds(conditionIds));
  }

  @Get("export/windows.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="windows.csv"')
  exportWindowsCsv(
    @Query("conditionIds") conditionIds?: string,
  ): Promise<string> {
    return this.reports.exportWindowsCsv(parseConditionIds(conditionIds));
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
  ): Promise<string> {
    return this.reports.exportLinkageCsv(parseConditionIds(conditionIds));
  }

  /** All research CSVs + codebook.md in one zip (linkage excluded). */
  @Get("export/research.zip")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "application/zip")
  @Header("Content-Disposition", 'attachment; filename="research_bundle.zip"')
  async exportResearchZip(
    @Query("conditionIds") conditionIds?: string,
  ): Promise<StreamableFile> {
    const zip = await this.reports.bundleZip(parseConditionIds(conditionIds));
    return new StreamableFile(zip);
  }
}
