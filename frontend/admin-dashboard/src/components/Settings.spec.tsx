import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Settings, { RecruitingTable } from "./Settings";
import { calledPaths, mockApi, progress } from "../test-utils";

afterEach(() => vi.unstubAllGlobals());

const rounds = {
  currentRound: 1,
  rounds: [
    { number: 1, label: "pilot", startedAt: "2026-09-01T00:00:00Z", sessionCount: 2, completedCount: 1 },
  ],
};

/** Wait for the compensation card's GET /settings so no state update lands after the test. */
async function settingsLoaded() {
  await waitFor(() =>
    expect(screen.getByLabelText(/Full completion/)).toBeEnabled(),
  );
}

/** Routes every card on the Settings view touches on mount. */
function settingsApi(extra: Record<string, unknown> = {}) {
  return mockApi({
    "/settings": {
      compensationUrl: "https://app.prolific.com/submissions/complete?cc=DONE",
      noConsentUrl: "",
      ineligibleUrl: "",
      withdrawalUrl: "",
      unmatchedUrl: "",
      technicalFailureUrl: "",
    },
    ...extra,
  });
}

describe("Settings", () => {
  it("hides e2e residue from the recruiting table and renders the current round", async () => {
    settingsApi();
    render(
      <Settings
        etherpad={null}
        onToggleEtherpad={vi.fn()}
        rows={[progress({}, 1), progress({ id: "e2e-1", name: "E2E" })]}
        onSaved={vi.fn()}
        rounds={rounds}
        lobbyCount={0}
      />,
    );
    expect(screen.getByRole("heading", { name: "Study Rounds" })).toBeInTheDocument();
    expect(screen.getByText("Round 1 (pilot)")).toBeInTheDocument();
    const recruiting = screen.getByLabelText("Recruiting");
    expect(within(recruiting).getByText("Baseline")).toBeInTheDocument();
    expect(within(recruiting).queryByText("E2E")).toBeNull();
    expect(within(recruiting).getByText("No nudges")).toBeInTheDocument();
    expect(within(recruiting).getByText("1 / 5 · 4 remaining")).toBeInTheDocument();
    await settingsLoaded();
  });

  it("starts the next round after an explicit confirmation", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const fetchMock = settingsApi({ "/rounds": (init: RequestInit | undefined) => ({ round: { number: 2 }, abortedWaitingSessions: init ? 2 : 0 }) });
    render(<Settings etherpad={null} onToggleEtherpad={vi.fn()} rows={[progress({})]} onSaved={onSaved} rounds={rounds} lobbyCount={2} />);

    await user.type(screen.getByLabelText("Label for Round 2"), "  threshold 35%  ");
    await user.click(screen.getByRole("button", { name: "Start Round 2" }));
    expect(screen.getByText("Start Round 2 and abort 2 waiting lobbies?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/abort 2 waiting/)).toBeNull();
    expect(calledPaths(fetchMock)).not.toContain("/rounds");

    await user.click(screen.getByRole("button", { name: "Start Round 2" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/rounds"))!;
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ label: "threshold 35%" });
    expect(await screen.findByText("Round started ✓")).toBeInTheDocument();
    expect(screen.getByLabelText("Label for Round 2")).toHaveValue("");
  });

  it("reports a failed round start", async () => {
    const user = userEvent.setup();
    settingsApi({ "/rounds": { status: 500 } });
    render(<Settings etherpad={null} onToggleEtherpad={vi.fn()} rows={[progress({})]} onSaved={vi.fn()} rounds={rounds} lobbyCount={0} />);
    await user.click(screen.getByRole("button", { name: "Start Round 2" }));
    expect(screen.getByText("Start Round 2?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Could not start the round.")).toBeInTheDocument();
  });

  it("renders nothing for the rounds card until rounds are loaded", async () => {
    settingsApi();
    render(<Settings etherpad={null} onToggleEtherpad={vi.fn()} rows={[]} onSaved={vi.fn()} rounds={null} lobbyCount={0} />);
    expect(screen.queryByRole("heading", { name: "Study Rounds" })).toBeNull();
    await settingsLoaded();
  });
});

describe("SharedParamsCard", () => {
  it("shows the majority values, flags drifted arms and aligns them", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const puts: Array<{ id: string; durationMinutes: number; config: Record<string, unknown> }> = [];
    settingsApi({
      "/conditions/baseline": (init: RequestInit | undefined) => {
        const { condition } = JSON.parse(String(init?.body));
        puts.push(condition);
        return condition;
      },
      "/conditions/public-llm": (init: RequestInit | undefined) => {
        const { condition } = JSON.parse(String(init?.body));
        puts.push(condition);
        return condition;
      },
      "/conditions/private-llm": (init: RequestInit | undefined) => {
        const { condition } = JSON.parse(String(init?.body));
        puts.push(condition);
        return condition;
      },
    });
    const rows = [
      progress({}),
      progress({ id: "public-llm", name: "Public" }),
      progress({
        id: "private-llm",
        name: "Private",
        durationMinutes: 15,
        config: { ...progress({}).condition.config, contributionThreshold: 0.35 },
      }),
    ];
    render(<Settings etherpad={null} onToggleEtherpad={vi.fn()} rows={rows} onSaved={onSaved} rounds={null} lobbyCount={0} />);

    expect(screen.getByLabelText(/Discussion time/)).toHaveValue(10);
    expect(screen.getByLabelText(/Trigger at/)).toHaveValue(40);
    expect(screen.getByLabelText(/Wrap-up/)).toHaveValue(30);
    // Warm-up is edited in seconds, like wrap-up (fixture: 1 minute).
    expect(screen.getByLabelText(/Warm-up/)).toHaveValue(60);
    const drift = screen
      .getByText(/differs: Discussion time is 15 min there, shared value is 10 min; Trigger at is 35% there, shared value is 40%/)
      .closest(".drift")!;
    expect(drift).toHaveTextContent(/⚠ Private differs/);

    await user.click(screen.getByRole("button", { name: "Align to shared" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      id: "private-llm",
      durationMinutes: 10,
      config: expect.objectContaining({ contributionThreshold: 0.4 }),
    });
    expect(screen.getByText("Saved. Applies to newly formed sessions")).toBeInTheDocument();
  });

  it("applies edited values to every study arm in the units the backend stores", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const puts: Array<Record<string, unknown>> = [];
    settingsApi({
      "/conditions/baseline": (init: RequestInit | undefined) => {
        const { condition } = JSON.parse(String(init?.body));
        puts.push(condition);
        return condition;
      },
      "/conditions/public-llm": (init: RequestInit | undefined) => {
        const { condition } = JSON.parse(String(init?.body));
        puts.push(condition);
        return condition;
      },
    });
    const rows = [progress({}), progress({ id: "public-llm", name: "Public" })];
    render(<Settings etherpad={null} onToggleEtherpad={vi.fn()} rows={rows} onSaved={onSaved} rounds={null} lobbyCount={0} />);
    expect(screen.getByText("✓ All 2 arms share these values.")).toBeInTheDocument();
    const params = screen.getByRole("heading", { name: "Session & Bot Parameters" }).closest("section")!;
    const apply = within(params).getByRole("button", { name: "Apply to all study arms" });
    expect(apply).toBeDisabled();
    expect(screen.getByText("Edit a value to enable saving.")).toBeInTheDocument();

    const window = screen.getByLabelText(/Contribution window/);
    await user.clear(window);
    await user.type(window, "90");
    const wrapup = screen.getByLabelText(/Wrap-up/);
    await user.clear(wrapup);
    await user.type(wrapup, "45");
    const warmup = screen.getByLabelText(/Warm-up/);
    await user.clear(warmup);
    await user.type(warmup, "90");
    expect(apply).toBeEnabled();
    await user.click(apply);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(puts.map((c) => c.id)).toEqual(["baseline", "public-llm"]);
    expect(puts[0].config).toMatchObject({
      contributionWindowMinutes: 1.5,
      protectedEndMinutes: 0.75,
      protectedStartMinutes: 1.5,
    });
  });

  it("reports a partial failure and keeps the draft dirty", async () => {
    const user = userEvent.setup();
    settingsApi({ "/conditions/baseline": { status: 500 } });
    render(<Settings etherpad={null} onToggleEtherpad={vi.fn()} rows={[progress({})]} onSaved={vi.fn()} rounds={null} lobbyCount={0} />);
    const groupSize = screen.getByLabelText(/Group size/);
    await user.clear(groupSize);
    await user.type(groupSize, "4");
    const params = screen.getByRole("heading", { name: "Session & Bot Parameters" }).closest("section")!;
    const apply = within(params).getByRole("button", { name: "Apply to all study arms" });
    await user.click(apply);
    expect(await screen.findByText("Error: not all arms saved")).toBeInTheDocument();
    expect(apply).toBeEnabled();
  });
});

describe("WorkspaceCard", () => {
  it("toggles the global writing mode and describes draining participants", async () => {
    const user = userEvent.setup();
    settingsApi();
    const onToggle = vi.fn();
    const props = { rows: [progress({})], onSaved: vi.fn(), rounds: null, lobbyCount: 0, onToggleEtherpad: onToggle };
    const { rerender } = render(<Settings {...props} etherpad={{ enabled: false, state: "stopped", activeParticipants: 0 }} />);
    await user.click(screen.getByRole("switch", { name: "Enable Etherpad" }));
    expect(onToggle).toHaveBeenCalledWith(true);
    rerender(<Settings {...props} etherpad={{ enabled: true, state: "ready", activeParticipants: 2 }} />);
    expect(screen.getByRole("switch")).toBeChecked();
    await user.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenLastCalledWith(false);
    rerender(<Settings {...props} etherpad={{ enabled: false, state: "draining", activeParticipants: 2 }} />);
    expect(screen.getByText(/2 existing writing participant/)).toBeInTheDocument();
  });

  it("disables an unloaded switch and retries a failed startup", async () => {
    const user = userEvent.setup();
    settingsApi();
    const onToggle = vi.fn();
    const props = { rows: [], onSaved: vi.fn(), rounds: null, lobbyCount: 0, onToggleEtherpad: onToggle };
    const { rerender } = render(<Settings {...props} etherpad={null} />);
    expect(screen.getByRole("switch")).toBeDisabled();
    rerender(<Settings {...props} etherpad={{ enabled: true, state: "error", activeParticipants: 0, error: "Startup failed" }} />);
    expect(screen.getByText("Startup failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe("CompensationCard", () => {
  it("loads the Prolific paths, saves trimmed edits and reports failures", async () => {
    const user = userEvent.setup();
    let putBody: unknown;
    const fetchMock = settingsApi({
      "/settings": (init: RequestInit | undefined) => {
        if (init?.method === "PUT") {
          putBody = JSON.parse(String(init.body));
          return (putBody as { settings: unknown }).settings;
        }
        return {
          compensationUrl: "https://app.prolific.com/submissions/complete?cc=DONE",
          noConsentUrl: "",
          ineligibleUrl: "",
          withdrawalUrl: "",
          unmatchedUrl: "",
          technicalFailureUrl: "",
        };
      },
    });
    render(<Settings etherpad={null} onToggleEtherpad={vi.fn()} rows={[]} onSaved={vi.fn()} rounds={null} lobbyCount={0} />);
    const card = screen.getByRole("heading", { name: "Prolific completion and exit paths" }).closest("section")!;
    const save = within(card).getByRole("button", { name: "Save" });
    const inputs = within(card).getAllByRole("textbox");
    await waitFor(() => expect(inputs[0]).toBeEnabled());
    expect(inputs[0]).toHaveValue("https://app.prolific.com/submissions/complete?cc=DONE");
    expect(save).toBeDisabled();

    await user.type(inputs[1], "  https://app.prolific.com/submissions/complete?cc=NOCONSENT ");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await within(card).findByText("Saved")).toBeInTheDocument();
    expect(putBody).toMatchObject({
      settings: expect.objectContaining({
        noConsentUrl: "https://app.prolific.com/submissions/complete?cc=NOCONSENT",
      }),
    });
    expect(save).toBeDisabled();

    fetchMock.mockImplementation(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "", blob: async () => new Blob() }));
    await user.type(inputs[2], "https://example.org/x");
    await user.click(save);
    expect(await within(card).findByText("Error")).toBeInTheDocument();
  });
});

describe("RecruitingTable", () => {
  it("renders nothing without rows", () => {
    const { container } = render(<RecruitingTable rows={[]} onSaved={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("toggles recruiting and saves a changed goal through PUT /conditions/:id", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const fetchMock = mockApi({
      "/conditions/baseline": (init: RequestInit | undefined) => JSON.parse(String(init?.body)).condition,
    });
    render(<RecruitingTable rows={[progress({}, 5)]} onSaved={onSaved} />);
    expect(screen.getByText("goal reached")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Baseline recruiting" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const toggle = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(toggle[1].method).toBe("PUT");
    expect(JSON.parse(String(toggle[1].body)).condition).toMatchObject({ id: "baseline", active: false });
    expect(screen.getByText("Saved")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const goal = screen.getByRole("spinbutton", { name: "Baseline goal" });
    await user.clear(goal);
    await user.type(goal, "8");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    const goalCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(goalCall[1].body)).condition).toMatchObject({ goal: 8 });
  });

  it("keeps an unsaved goal edit across dashboard polls but adopts server changes when clean", async () => {
    const user = userEvent.setup();
    mockApi({});
    const { rerender } = render(<RecruitingTable rows={[progress({ active: false })]} onSaved={vi.fn()} />);
    expect(screen.getByText("off")).toBeInTheDocument();
    const goal = screen.getByRole("spinbutton", { name: "Baseline goal" });

    await user.clear(goal);
    await user.type(goal, "9");
    rerender(<RecruitingTable rows={[progress({ active: false, goal: 6 })]} onSaved={vi.fn()} />);
    expect(goal).toHaveValue(9);

    await user.clear(goal);
    await user.type(goal, "6");
    rerender(<RecruitingTable rows={[progress({ active: false, goal: 7 })]} onSaved={vi.fn()} />);
    expect(goal).toHaveValue(7);
  });

  it("shows an error when the save is rejected", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mockApi({ "/conditions/baseline": { status: 400 } });
    render(<RecruitingTable rows={[progress({})]} onSaved={onSaved} />);
    await user.click(screen.getByRole("checkbox", { name: "Baseline recruiting" }));
    expect(await screen.findByText("Error")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
