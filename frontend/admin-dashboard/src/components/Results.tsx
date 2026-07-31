import { useCallback, useEffect, useState } from "react";
import type { ConditionReportSummary, ReportsSummaryResponse } from "@gdm/shared";
import { apiFetch, exportUrl, isTestCondition } from "../api";

const RESEARCH_EXPORTS = [
  { key: "participants", label: "Participants (surveys + activity joined)" },
  { key: "sessions-analysis", label: "Sessions (derived analysis measures)" },
  { key: "windows", label: "Contribution windows (fired or not)" },
] as const;

/**
 * Per-condition descriptives plus the analysis-ready research downloads.
 * Numbers here are for monitoring the study, not for inference — the CSVs
 * are the citable record.
 */
export default function Results() {
  const [summary, setSummary] = useState<ReportsSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/reports/summary");
      if (!res.ok) throw new Error(`Could not load results (${res.status})`);
      setSummary((await res.json()) as ReportsSummaryResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load results");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const conditions = (summary?.conditions ?? []).filter(
    (row) => !isTestCondition(row.conditionId),
  );

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>Results by Condition</h2>
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <p className="hint">
          Descriptive means over completed sessions only. Ranking error is the
          NASA score (0 = matches the expert ranking). Share SD and Gini
          measure participation inequality (0 = perfectly equal).
        </p>
        {error && <p className="error">{error}</p>}
        {conditions.length === 0 && !error ? (
          <p className="hint">No study sessions yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Completed</th>
                  <th>Participants</th>
                  <th>Surveys (entry/exit)</th>
                  <th>Group ranking error</th>
                  <th>Satisfaction</th>
                  <th>Fairness</th>
                  <th>Felt heard</th>
                  <th>Share SD</th>
                  <th>Gini</th>
                  <th>Nudges/session</th>
                  <th>Windows (nudged)</th>
                </tr>
              </thead>
              <tbody>
                {conditions.map((row) => (
                  <ResultsRow key={row.conditionId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <h2>Research Exports</h2>
        <p className="hint">
          Analysis-ready files with pseudonymous IDs (P-… / S-…) — no Prolific
          tokens, no Matrix IDs. The bundle includes every research CSV plus a
          codebook documenting each column.
        </p>
        <div className="download-primary">
          <a
            className="link-button"
            href={exportUrl("/export/research.zip", "")}
            download="research_bundle.zip"
          >
            Research Bundle (ZIP + codebook)
          </a>
        </div>
        <details className="export-advanced">
          <summary>Individual research datasets</summary>
          <table className="export-table">
            <tbody>
              {RESEARCH_EXPORTS.map(({ key, label }) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td>
                    <a
                      className="link-button"
                      href={exportUrl(`/export/${key}`, "")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      JSON
                    </a>
                    <a
                      className="link-button"
                      href={exportUrl(`/export/${key}.csv`, "")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      CSV
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className="section">
        <h2>Identifying Data</h2>
        <p className="hint">
          Maps pseudonyms to Prolific tokens and Matrix IDs — needed for
          compensation and exclusions only. Keep this file out of analysis
          folders and never share it; it is deliberately excluded from the
          research bundle.
        </p>
        <a
          className="link-button secondary"
          href={exportUrl("/export/linkage.csv", "")}
          download="linkage.csv"
        >
          Linkage (CSV, identifying)
        </a>
      </section>
    </>
  );
}

function ResultsRow({ row }: { row: ConditionReportSummary }) {
  return (
    <tr>
      <td>{row.conditionName}</td>
      <td>
        {row.sessionsCompleted}
        {row.sessionsRunning > 0 && (
          <span className="hint"> (+{row.sessionsRunning} live)</span>
        )}
      </td>
      <td>{row.participants}</td>
      <td>
        {row.entrySurveys}/{row.exitSurveys}
      </td>
      <td>{num(row.meanGroupRankingError)}</td>
      <td>{num(row.meanSatisfaction)}</td>
      <td>{num(row.meanFairness)}</td>
      <td>{num(row.meanFeltHeard)}</td>
      <td>{num(row.meanShareStdDev)}</td>
      <td>{num(row.meanShareGini)}</td>
      <td>{num(row.nudgesPerSessionMean)}</td>
      <td>
        {row.windowsEvaluated} ({row.windowsNudged})
      </td>
    </tr>
  );
}

function num(value: number | null): string {
  if (value === null) return "—";
  return String(Math.round(value * 100) / 100);
}
