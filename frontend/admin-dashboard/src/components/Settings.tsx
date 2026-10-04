import { isTestCondition } from "@gdm/shared";
import type { RoundsResponse, EtherpadStatus } from "@gdm/shared";
import CompensationCard from "./settings/CompensationCard";
import RecruitingTable from "./settings/RecruitingTable";
import SharedParamsCard from "./settings/SharedParamsCard";
import StudyRoundsCard from "./settings/StudyRoundsCard";
import WorkspaceCard from "./settings/WorkspaceCard";
import type { ArmRowsProps } from "./settings/types";

interface SettingsProps extends ArmRowsProps {
  rounds: RoundsResponse | null;
  /** Current waiting-room lobbies (shown in the start-round confirm step). */
  lobbyCount: number;
  etherpad: EtherpadStatus | null;
  onToggleEtherpad: (enabled: boolean) => void;
}

/**
 * Settings view, split by how often a researcher touches things:
 *
 *  1. Recruiting — the daily controls (arm on/off, goal, progress). The
 *     arm's delivery (baseline / public / private) is a read-only badge.
 *  2. Session & Bot Parameters — ONE shared form applied to all study arms.
 *     A between-subjects design needs identical parameters everywhere, so
 *     arms deviating from the shared values surface as a drift warning
 *     instead of being silently editable per row.
 *  3. Prolific completion and early-exit paths.
 */
export default function Settings({
  rows,
  onSaved,
  rounds,
  lobbyCount,
  etherpad,
  onToggleEtherpad,
}: SettingsProps) {
  const studyRows = rows.filter((row) => !isTestCondition(row.condition.id));

  return (
    <>
      <StudyRoundsCard rounds={rounds} lobbyCount={lobbyCount} onSaved={onSaved} />
      <section className="section">
        <h2>Recruiting</h2>
        <p className="hint">
          Which arms accept participants, and how many groups each still
          needs. A condition stops recruiting automatically at its goal.
          Everything else about an arm is fixed study design and is shown, not
          editable.
        </p>
        <RecruitingTable rows={studyRows} onSaved={onSaved} />
      </section>
      <SharedParamsCard rows={studyRows} onSaved={onSaved} />
      <WorkspaceCard status={etherpad} onToggle={onToggleEtherpad} />
      <CompensationCard />
    </>
  );
}
