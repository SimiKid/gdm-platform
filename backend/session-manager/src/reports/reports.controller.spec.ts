import { describe, expect, it, vi } from "vitest";
import { StreamableFile } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import type { ReportsService } from "./reports.service";

function build() {
  const reports = {
    summary: vi.fn(async () => ({ generatedAt: "now", conditions: [] })),
    exportParticipants: vi.fn(async () => ({ generatedAt: "now", participants: [] })),
    exportParticipantsCsv: vi.fn(async () => "participant_id\n"),
    exportSessionsAnalysis: vi.fn(async () => ({ generatedAt: "now", sessions: [] })),
    exportSessionsAnalysisCsv: vi.fn(async () => "session_id\n"),
    exportWindows: vi.fn(async () => ({ generatedAt: "now", windows: [] })),
    exportWindowsCsv: vi.fn(async () => "window_id\n"),
    exportRankings: vi.fn(async () => ({ generatedAt: "now", rankings: [] })),
    exportRankingsCsv: vi.fn(async () => "ranking_id\n"),
    exportLinkageCsv: vi.fn(async () => "pseudonym\n"),
    bundleZip: vi.fn(async () => Buffer.from("PK-research")),
    bundleResearchDataZip: vi.fn(async () => Buffer.from("PK-data")),
  };
  const ctrl = new ReportsController(reports as unknown as ReportsService);
  return { ctrl, reports };
}

const EVERYTHING = { conditionIds: [], roundIds: [] };

describe("ReportsController", () => {
  it("parses the condition and round query axes into one research filter", async () => {
    const { ctrl, reports } = build();
    await ctrl.summary(" baseline, public-llm ,,", "1, x, 0, -3, 2.5, 2");
    expect(reports.summary).toHaveBeenCalledWith({
      conditionIds: ["baseline", "public-llm"],
      roundIds: [1, 2],
    });
  });

  it("treats absent query axes as 'everything'", async () => {
    const { ctrl, reports } = build();
    await ctrl.summary();
    expect(reports.summary).toHaveBeenCalledWith(EVERYTHING);
  });

  const delegations: Array<
    [keyof ReportsController, keyof ReturnType<typeof build>["reports"]]
  > = [
    ["exportParticipants", "exportParticipants"],
    ["exportParticipantsCsv", "exportParticipantsCsv"],
    ["exportSessionsAnalysis", "exportSessionsAnalysis"],
    ["exportSessionsAnalysisCsv", "exportSessionsAnalysisCsv"],
    ["exportWindows", "exportWindows"],
    ["exportWindowsCsv", "exportWindowsCsv"],
    ["exportRankings", "exportRankings"],
    ["exportRankingsCsv", "exportRankingsCsv"],
    ["exportLinkageCsv", "exportLinkageCsv"],
  ];

  it.each(delegations)(
    "%s forwards the filter to the reports service and returns its payload",
    async (method, serviceMethod) => {
      const { ctrl, reports } = build();
      const handler = ctrl[method] as (
        conditionIds?: string,
        roundIds?: string,
      ) => Promise<unknown>;
      const result = await handler.call(ctrl, "e2e-x,baseline", "2");
      expect(reports[serviceMethod]).toHaveBeenCalledWith({
        conditionIds: ["e2e-x", "baseline"],
        roundIds: [2],
      });
      expect(result).toEqual(await reports[serviceMethod].mock.results[0].value);
    },
  );

  it("streams the research bundle zip", async () => {
    const { ctrl, reports } = build();
    const file = await ctrl.exportResearchZip("baseline", undefined);
    expect(file).toBeInstanceOf(StreamableFile);
    expect(reports.bundleZip).toHaveBeenCalledWith({
      conditionIds: ["baseline"],
      roundIds: [],
    });
    expect(await collect(file)).toBe("PK-research");
  });

  it("streams the overview research-data zip", async () => {
    const { ctrl, reports } = build();
    const file = await ctrl.exportResearchDataZip(undefined, "3");
    expect(file).toBeInstanceOf(StreamableFile);
    expect(reports.bundleResearchDataZip).toHaveBeenCalledWith({
      conditionIds: [],
      roundIds: [3],
    });
    expect(await collect(file)).toBe("PK-data");
  });
});

async function collect(file: StreamableFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
