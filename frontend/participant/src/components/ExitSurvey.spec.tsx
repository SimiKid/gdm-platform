import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EXPEDITION_MARS } from "@gdm/shared";
import type { MatrixClient } from "matrix-js-sdk";
import type { Session } from "@gdm/shared";
import ExitSurvey from "./ExitSurvey";

const session = {
  id: "s",
  roomId: "!r",
  rankingTask: EXPEDITION_MARS,
  ranking: {
    taskId: EXPEDITION_MARS.id,
    order: EXPEDITION_MARS.items.map((i) => i.id),
    updatedAt: "",
    updatedBy: "",
  },
} as unknown as Session;

// Fake client: room timeline has no ranking event → falls back to session.ranking.
const client = {
  getRoom: () => ({ getLiveTimeline: () => ({ getEvents: () => [] }) }),
} as unknown as MatrixClient;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});
afterEach(() => vi.unstubAllGlobals());

describe("ExitSurvey", () => {
  it("submits the exit survey and completes the session", async () => {
    const onDone = vi.fn();
    render(
      <ExitSurvey
        client={client}
        session={session}
        participantId="p"
        onDone={onDone}
      />,
    );
    expect(screen.getByText(/The discussion has ended/)).toBeInTheDocument();

    const [satisfaction, fairness, heard] = screen.getAllByRole("combobox");
    await userEvent.selectOptions(satisfaction, "5");
    await userEvent.selectOptions(fairness, "agree");
    await userEvent.selectOptions(heard, "yes");
    await userEvent.click(screen.getByText("Finish"));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/surveys"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/complete"),
      expect.any(Object),
    );
  });
});
