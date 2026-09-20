import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTERVENTION_CONFIG } from "@gdm/shared";
import { EtherpadService } from "./etherpad.service";
import { EtherpadRepository } from "./etherpad.repository";
import { StoreService } from "../store/store.service";
import { ReportsService } from "../reports/reports.service";

describe("Etherpad study lifecycle", () => {
  let store: StoreService;
  let repo: EtherpadRepository;
  let service: EtherpadService;
  let ready: boolean;
  let running: boolean;
  let failCapture: boolean;
  let fetcher: ReturnType<typeof vi.fn>;
  const content = new Map<string, string>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("ETHERPAD_CONTROL_URL", "http://control");
    vi.stubEnv("ETHERPAD_INTERNAL_URL", "http://editor");
    vi.stubEnv("ETHERPAD_CONTROL_TOKEN", "test-control-secret");
    store = new StoreService(); repo = new EtherpadRepository(); service = new EtherpadService(repo, store);
    ready = true; running = false; failCapture = false; content.clear();
    fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/start")) { running = true; return Response.json({ ready, running }); }
      if (url.endsWith("/stop")) { running = false; return Response.json({ running }); }
      if (url.endsWith("/gdm/close") && failCapture) return new Response("offline", { status: 503 });
      if (url.endsWith("/gdm/create") && !content.has(body.padId)) content.set(body.padId, "");
      return Response.json({ text: content.get(body.padId) ?? "", revision: 7 });
    });
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => { service.onModuleDestroy(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  async function enable() { await service.setEnabled(true); await service.reconcile(); }
  async function entry(token: string) {
    await service.prepare(token);
    const pad = await service.pad(token, "entry");
    content.set(pad.id, `Private response ${token}`);
    await service.finish(token, pad.id);
    return pad;
  }
  async function session(tokens: string[]) {
    const s = await store.createForming({ id: "etherpad-test", name: "Writing", active: true, goal: 10, groupSize: tokens.length, durationMinutes: 1,
      config: { ...DEFAULT_INTERVENTION_CONFIG, workspaceMode: "etherpad" } });
    for (const token of tokens) {
      s.participants.push({ id: `id-${token}`, name: token, trackingToken: token });
      await service.attach(token, s, `id-${token}`);
    }
    s.status = "running"; s.startedAt = new Date().toISOString();
    return s;
  }

  it("keeps the default ranking path independent of an Etherpad connection", async () => {
    expect(await service.prepare("old")).toEqual({ mode: "ranking" });
    expect(await service.modeFor("legacy-short-token")).toBe("ranking");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(service.pad("old", "entry")).rejects.toThrow("Writing study access required");
  });
  it("freezes both modes, serializes switches and rejects new arrivals while starting", async () => {
    await service.prepare("old");
    ready = false;
    expect(await service.setEnabled(true)).toMatchObject({ enabled: true, state: "starting" });
    await expect(service.setEnabled(false)).rejects.toThrow("changing state");
    await expect(service.prepare("new")).rejects.toThrow("starting");
    await service.reconcile(); ready = true; await service.reconcile();
    expect(await service.prepare("old")).toEqual({ mode: "ranking" });
    expect(await service.prepare("new")).toEqual({ mode: "etherpad" });
    await service.setEnabled(false); await service.reconcile();
    expect(await service.prepare("new")).toEqual({ mode: "etherpad" });
    expect(await service.prepare("later")).toEqual({ mode: "ranking" });
    expect(await service.status()).toMatchObject({ enabled: false, state: "draining", activeParticipants: 1 });
    expect(running).toBe(true);
  });
  it("creates separate private pads, an empty shared pad, and stable deadlines on reload", async () => {
    await enable();
    const first = await entry("alice"); await entry("bob");
    const s = await session(["alice", "bob"]);
    const group = await service.pad("alice", "group", s.id);
    expect((await service.pad("bob", "group", s.id)).id).toBe(group.id);
    expect(group.id).not.toBe(first.id); expect(content.get(group.id)).toBe("");
    expect(group).not.toHaveProperty("owner");
    expect(group).not.toHaveProperty("participantId");
    expect(s.ranking.order).toEqual([]);
    await expect(service.finish("bob", first.id)).rejects.toThrow();
    await expect(service.finish("bob", group.id)).rejects.toThrow("still running");
    s.status = "completed";
    const exit = await service.pad("alice", "exit", s.id);
    expect(content.get(exit.id)).toBe("");
    vi.setSystemTime(Date.now() + 20_000);
    expect((await service.pad("alice", "exit", s.id)).deadline).toBe(exit.deadline);
    expect(Date.parse(exit.deadline) - Date.parse(first.deadline)).toBe(-3 * 60_000);
    await expect(service.pad("bob", "group", "another-session")).rejects.toThrow();
  });
  it("requires a captured entry before matchmaking and authoritative saved pad IDs", async () => {
    await enable(); await service.prepare("alice");
    await expect(service.modeFor("alice")).rejects.toThrow("finish your entry");
    const pad = await entry("alice"); const s = await session(["alice"]);
    expect(await service.modeFor("alice")).toBe("etherpad");
    expect(await service.surveyPadId(s.id, "id-alice", "entry")).toBe(pad.id);
    await expect(service.surveyPadId(s.id, "id-bob", "entry")).rejects.toThrow();
  });
  it("captures expired and abandoned text before stopping, including after a manager restart", async () => {
    await enable(); await service.prepare("alice");
    const pad = await service.pad("alice", "entry"); content.set(pad.id, "Draft 🌕\nLine two");
    await service.setEnabled(false);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    service = new EtherpadService(repo, store);
    await service.reconcile();
    expect(await service.status()).toMatchObject({ enabled: false, state: "stopped", activeParticipants: 0 });
    expect(running).toBe(false);
    expect((await service.documents())[0]).toMatchObject({ state: "captured", text: "Draft 🌕\nLine two", revision: 7 });
    expect(await service.finish("alice", pad.id)).not.toHaveProperty("embedUrl");
  });
  it("does not stop or report success when capture fails, and retries without losing identity", async () => {
    await enable(); await service.prepare("alice");
    const pad = await service.pad("alice", "entry"); content.set(pad.id, "Keep me");
    await service.setEnabled(false); failCapture = true; vi.setSystemTime(Date.now() + 31 * 60_000);
    await service.reconcile();
    expect(await service.status()).toMatchObject({ state: "error" }); expect(running).toBe(true);
    expect((await service.documents())[0]).toMatchObject({ id: pad.id, state: "error", text: null });
    failCapture = false; await service.reconcile();
    expect(await service.status()).toMatchObject({ state: "stopped" });
    expect((await service.documents())[0]).toMatchObject({ id: pad.id, text: "Keep me" });
  });
  it("bounds startup time and rejects oversized snapshots without truncating them", async () => {
    ready = false; await service.setEnabled(true); vi.setSystemTime(Date.now() + 91_000); await service.reconcile();
    expect(await service.status()).toMatchObject({ state: "error" });
    ready = true; await enable(); await service.prepare("alice");
    const pad = await service.pad("alice", "entry");
    content.set(pad.id, "🌕".repeat(1000));
    expect((await service.finish("alice", pad.id)).text).toHaveLength(2000);
    await service.prepare("bob"); const other = await service.pad("bob", "entry"); content.set(other.id, "x".repeat(1001));
    await expect(service.finish("bob", other.id)).rejects.toThrow("Invalid Etherpad snapshot");
  });
  it("creates and captures a blank group pad even if nobody loads the editor", async () => {
    await enable(); await entry("alice"); const s = await session(["alice"]);
    await service.reconcile(); vi.setSystemTime(Date.now() + 61_000); s.status = "completed"; await service.reconcile();
    expect((await service.documents()).find(d => d.phase === "group")).toMatchObject({ state: "captured", text: "", sessionId: s.id });
  });
  it("keeps ranking and writing waiting rooms separate without changing live conditions", async () => {
    const condition = (await store.listConditions())[0];
    const rank = await store.createForming(condition);
    const writing = await store.createForming({ ...condition, config: { ...condition.config, workspaceMode: "etherpad" } });
    expect((await store.findForming(condition.id, "ranking"))?.id).toBe(rank.id);
    expect((await store.findForming(condition.id, "etherpad"))?.id).toBe(writing.id);
    expect((await store.getCondition(condition.id))?.config.workspaceMode).not.toBe("etherpad");
  });
  it("exports raw text with pseudonyms and no credentials, and applies study filters", async () => {
    await enable(); const pad = await entry("alice"); const s = await session(["alice"]);
    const reports = new ReportsService(store, service);
    const json = await reports.exportEtherpad();
    expect(json.pads).toHaveLength(1); expect(json.pads[0].text).toBe("Private response alice");
    expect(JSON.stringify(json)).not.toContain("authorToken"); expect(JSON.stringify(json)).not.toContain(pad.id);
    expect((await reports.exportEtherpad({ conditionIds: ["missing"] })).pads).toEqual([]);
    expect((await reports.exportEtherpad({ roundIds: [s.roundId + 1] })).pads).toEqual([]);
    expect(await reports.exportEtherpadCsv()).toContain("Private response alice");
  });
});
