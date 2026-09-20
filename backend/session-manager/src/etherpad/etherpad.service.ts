import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit, UnauthorizedException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { EtherpadStatus, PadPhase, StudyAdmission, StudyPad, StudyTaskMode, Session } from "@gdm/shared";
import { EtherpadRepository } from "./etherpad.repository";
import { StoreService } from "../store/store.service";

interface Admission { owner: string; mode: StudyTaskMode; expiresAt: number; sessionId?: string; participantId?: string; done?: boolean }
export interface PadRecord extends StudyPad { owner?: string; sessionId?: string; participantId?: string; conditionId?: string; roundId?: number }
type Control = Omit<EtherpadStatus, "activeParticipants"> & { transitionAt?: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class EtherpadService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly log = new Logger(EtherpadService.name);
  constructor(private readonly repo: EtherpadRepository, private readonly store: StoreService) {}
  onModuleInit() {
    if (!process.env.ETHERPAD_CONTROL_URL) return;
    this.timer = setInterval(() => void this.serial(() => this.reconcile()).catch(e => this.log.warn(String(e))), 5000);
    this.timer.unref();
    void this.serial(() => this.reconcile()).catch(e => this.log.warn(String(e)));
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.catch(() => undefined).then(fn);
    this.chain = result.catch(() => undefined);
    return result;
  }
  private control(): Promise<Control> {
    return this.repo.get<Control>("control").then(c => c ?? { enabled: false, state: "stopped" });
  }
  private async request(path: string, body?: unknown, supervisor = false) {
    const base = supervisor ? process.env.ETHERPAD_CONTROL_URL : process.env.ETHERPAD_INTERNAL_URL;
    if (!base || !process.env.ETHERPAD_CONTROL_TOKEN) throw new ServiceUnavailableException("Etherpad is not configured");
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${process.env.ETHERPAD_CONTROL_TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new ServiceUnavailableException(`Etherpad ${path} failed (${response.status})`);
    return response.json();
  }
  async status(): Promise<EtherpadStatus> {
    const { enabled, state, error } = await this.control();
    return { enabled, state, ...(error ? { error } : {}), activeParticipants: (await this.activeAdmissions()).length };
  }
  async busy(): Promise<boolean> { return ["starting", "stopping"].includes((await this.control()).state); }
  setEnabled(enabled: boolean): Promise<EtherpadStatus> {
    return this.serial(async () => {
      const current = await this.control();
      if (["starting", "stopping"].includes(current.state)) throw new ConflictException("Etherpad is changing state; wait for it to finish");
      if (enabled && (!process.env.ETHERPAD_CONTROL_URL || !process.env.ETHERPAD_INTERNAL_URL || !process.env.ETHERPAD_CONTROL_TOKEN)) throw new ServiceUnavailableException("Etherpad is not configured");
      await this.repo.put<Control>("control", { enabled, state: enabled ? "starting" : "draining", transitionAt: Date.now() });
      // Work continues server-side even if the dashboard is closed.
      return this.status();
    });
  }
  private async activeAdmissions(): Promise<Admission[]> {
    return (await this.repo.list<Admission>("admission:")).filter(a => a.mode === "etherpad" && !a.done && a.expiresAt > Date.now());
  }
  async prepare(token: string): Promise<StudyAdmission> {
    return this.serial(async () => {
      const owner = this.owner(token);
      const prior = await this.repo.get<Admission>(`admission:${owner}`);
      if (prior) return { mode: prior.mode };
      const control = await this.control();
      if (control.enabled && control.state !== "ready") throw new ServiceUnavailableException("The writing workspace is starting. Please retry shortly.");
      const mode = control.enabled ? "etherpad" : "ranking";
      await this.repo.put<Admission>(`admission:${owner}`, { owner, mode, expiresAt: Date.now() + 30 * 60_000 });
      return { mode };
    });
  }
  async modeFor(token: string): Promise<StudyTaskMode> {
    const admission = await this.repo.get<Admission>(`admission:${this.owner(token)}`);
    if (!admission) {
      if ((await this.control()).enabled) throw new ConflictException("Please start at the study entry page");
      return "ranking"; // Legacy/direct API clients retain their existing flow.
    }
    if (admission.mode === "etherpad" && (admission.expiresAt < Date.now() || admission.done)) throw new ConflictException("This writing study has ended");
    if (admission.mode === "etherpad") {
      const id = await this.repo.get<string>(`index:entry:${admission.owner}`);
      const doc = id ? await this.repo.get<PadRecord>(`pad:${id}`) : undefined;
      if (doc?.state !== "captured") throw new ConflictException("Please finish your entry writing task first");
    }
    return admission.mode;
  }
  async attach(token: string, session: Session, participantId: string): Promise<void> {
    if (session.condition.config.workspaceMode !== "etherpad") return;
    return this.serial(async () => {
    const owner = this.owner(token);
    const admission = await this.repo.get<Admission>(`admission:${owner}`);
    if (!admission || admission.mode !== "etherpad") throw new ConflictException("Missing writing admission");
    admission.sessionId = session.id; admission.participantId = participantId;
    admission.expiresAt = Date.now() + (session.durationMinutes + 20) * 60_000;
    await this.repo.put(`admission:${owner}`, admission);
    for (const doc of await this.repo.list<PadRecord>("pad:")) {
      if (doc.owner !== owner) continue;
      Object.assign(doc, { sessionId: session.id, participantId, conditionId: session.condition.id, roundId: session.roundId });
      await this.repo.put(`pad:${doc.id}`, doc);
    }
    });
  }
  private owner(token: string): string {
    if (!token || token.length > 256) throw new UnauthorizedException("Participant token required");
    return hash(token);
  }
  async pad(token: string, phase: PadPhase, sessionId?: string): Promise<StudyPad> {
    return this.serial(async () => {
      const owner = this.owner(token);
      const admission = await this.repo.get<Admission>(`admission:${owner}`);
      if (!admission || admission.mode !== "etherpad") throw new UnauthorizedException("Writing study access required");
      let session: Session | undefined;
      if (phase !== "entry") {
        if (!sessionId || admission.sessionId !== sessionId || !await this.store.hasParticipantAccess(sessionId, token)) throw new UnauthorizedException();
        session = await this.store.getSession(sessionId);
        if (!session || session.condition.config.workspaceMode !== "etherpad") throw new ConflictException("Not a writing session");
        if (phase === "group" && !["running", "completed"].includes(session.status)) throw new ConflictException("Discussion has not started");
        const discussionEnded = session.status === "completed" || (session.status === "running" && session.startedAt && Date.now() >= Date.parse(session.startedAt) + session.durationMinutes * 60_000);
        if (phase === "exit" && !discussionEnded) throw new ConflictException("Discussion has not finished");
      }
      const key = `index:${phase}:${phase === "group" ? sessionId : owner}`;
      const existingId = await this.repo.get<string>(key);
      let doc = existingId ? await this.repo.get<PadRecord>(`pad:${existingId}`) : undefined;
      if (!doc) {
        if (admission.done || admission.expiresAt <= Date.now()) throw new ConflictException("Writing phase has ended");
        if (phase === "entry" && admission.sessionId) throw new ConflictException("Entry task already ended");
        const deadline = phase === "group"
          ? new Date(session!.startedAt!).getTime() + session!.durationMinutes * 60_000
          : Date.now() + (phase === "entry" ? 5 : 2) * 60_000;
        const id = `gdm-${randomUUID()}`;
        doc = { id, phase, deadline: new Date(deadline).toISOString(), state: "open", text: null, revision: null,
          ...(phase !== "group" ? { owner, participantId: admission.participantId } : {}),
          sessionId: session?.id ?? admission.sessionId, conditionId: session?.condition.id, roundId: session?.roundId };
        // Persist identity before calling Etherpad so a retry creates the same pad.
        await this.repo.put(`pad:${id}`, doc); await this.repo.put(key, id);
      }
      if (doc.state !== "captured") {
        await this.ensureServer();
        await this.request("/gdm/create", { padId: doc.id, deadline: Date.parse(doc.deadline) });
        if (Date.now() >= Date.parse(doc.deadline)) doc = await this.capture(doc);
      }
      const publicDoc: StudyPad = { id: doc.id, phase, deadline: doc.deadline, state: doc.state, text: doc.text, revision: doc.revision, capturedAt: doc.capturedAt, error: doc.error };
      if (doc.state !== "captured") {
        const payload = Buffer.from(JSON.stringify({ padId: doc.id, exp: Date.parse(doc.deadline) + 60_000,
          authorToken: `t.${hash(owner + doc.id)}` })).toString("base64url");
        const signature = createHmac("sha256", process.env.ETHERPAD_CONTROL_TOKEN!).update(payload).digest("base64url");
        publicDoc.embedUrl = `/etherpad/p/${doc.id}#gdm=${payload}.${signature}`;
      }
      return publicDoc;
    });
  }
  async finish(token: string, id: string): Promise<StudyPad> {
    return this.serial(async () => {
      const doc = await this.repo.get<PadRecord>(`pad:${id}`);
      const owner = this.owner(token);
      if (!doc || (doc.phase !== "group" && doc.owner !== owner) || (doc.phase === "group" && (!doc.sessionId || !await this.store.hasParticipantAccess(doc.sessionId, token)))) throw new UnauthorizedException();
      if (doc.phase === "group" && Date.now() < Date.parse(doc.deadline)) throw new ConflictException("Discussion is still running");
      const saved = await this.capture(doc);
      if (doc.phase === "exit") {
        const admission = await this.repo.get<Admission>(`admission:${owner}`);
        if (admission) { admission.done = true; await this.repo.put(`admission:${owner}`, admission); }
      }
      return { id: saved.id, phase: saved.phase, deadline: saved.deadline, state: saved.state, text: saved.text, revision: saved.revision, capturedAt: saved.capturedAt };
    });
  }
  private async capture(doc: PadRecord): Promise<PadRecord> {
    if (doc.state === "captured") return doc;
    try {
      const captured = await this.request("/gdm/close", { padId: doc.id }) as { text: string; revision: number };
      if (typeof captured.text !== "string" || [...captured.text].length > 1000) throw new Error("Invalid Etherpad snapshot");
      Object.assign(doc, { text: captured.text, revision: captured.revision, state: "captured", capturedAt: new Date().toISOString() });
      delete doc.error;
      await this.repo.put(`pad:${doc.id}`, doc);
      return doc;
    } catch (error) {
      doc.state = "error"; doc.error = "Content capture failed; retry required";
      await this.repo.put(`pad:${doc.id}`, doc);
      throw error;
    }
  }
  private async ensureServer(): Promise<boolean> {
    const status = await this.request("/start", {}, true) as { ready: boolean };
    if (!status.ready) throw new ServiceUnavailableException("Writing workspace is starting; please retry");
    return true;
  }
  async reconcile(): Promise<void> {
    const control = await this.control();
    const admissions = await this.activeAdmissions();
    try {
      // Active aborted/completed participants must not keep a draining server alive.
      for (const admission of admissions) {
        if (!admission.sessionId) continue;
        const session = await this.store.getSession(admission.sessionId);
        const participant = session?.participants.find(p => p.id === admission.participantId);
        if (session?.status === "aborted" || participant?.completedAt) {
          admission.done = true; await this.repo.put(`admission:${admission.owner}`, admission);
        }
      }
      const active = await this.activeAdmissions();
      // Create the group record even if nobody opens the iframe. A blank
      // response must be distinguishable from a failed/missing capture.
      for (const sessionId of new Set(active.map(a => a.sessionId).filter(Boolean))) {
        const session = await this.store.getSession(sessionId!);
        if (!session?.startedAt || !["running", "completed"].includes(session.status)) continue;
        if (await this.repo.get(`index:group:${sessionId}`)) continue;
        const id = `gdm-${randomUUID()}`;
        const doc: PadRecord = { id, phase: "group", sessionId, conditionId: session.condition.id, roundId: session.roundId,
          deadline: new Date(Date.parse(session.startedAt) + session.durationMinutes * 60_000).toISOString(), state: "open", text: null, revision: null };
        await this.repo.put(`pad:${id}`, doc); await this.repo.put(`index:group:${sessionId}`, id);
      }
      const uncaptured = (await this.documents()).filter(d => d.state !== "captured");
      if (control.enabled || active.length || uncaptured.length) {
        const server = await this.request("/start", {}, true) as { ready: boolean };
        if (!server.ready) {
          const transitionAt = control.transitionAt ?? Date.now();
          if (Date.now() - transitionAt > 90_000) throw new Error("Etherpad did not start within 90 seconds. Check the server logs and retry.");
          await this.repo.put("control", { ...control, state: "starting", transitionAt }); return;
        }
        for (const doc of uncaptured) {
          const abandoned = doc.owner && !active.some(a => a.owner === doc.owner);
          const ended = doc.sessionId && (await this.store.getSession(doc.sessionId))?.status === "aborted";
          if (Date.now() >= Date.parse(doc.deadline) || abandoned || ended) {
            await this.request("/gdm/create", { padId: doc.id, deadline: Date.parse(doc.deadline) });
            await this.capture(doc);
          }
        }
        await this.repo.put("control", { enabled: control.enabled, state: control.enabled ? "ready" : "draining" });
      }
      if (!control.enabled && !(await this.activeAdmissions()).length && !(await this.repo.list<PadRecord>("pad:")).some(d => d.state !== "captured")) {
        const server = await this.request("/stop", {}, true) as { running: boolean };
        await this.repo.put("control", { enabled: false, state: server.running ? "stopping" : "stopped" });
      }
    } catch (error) {
      await this.repo.put("control", { ...control, state: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  async documents(): Promise<PadRecord[]> { return this.repo.list<PadRecord>("pad:"); }

  async leave(token: string): Promise<void> {
    return this.serial(async () => {
      const owner = this.owner(token);
      const admission = await this.repo.get<Admission>(`admission:${owner}`);
      if (!admission || admission.mode !== "etherpad") return;
      admission.done = true;
      await this.repo.put(`admission:${owner}`, admission);
      // Reconciliation captures any unfinished draft before shutting down.
    });
  }

  async surveyPadId(sessionId: string, participantId: string, phase: "entry" | "exit"): Promise<string> {
    const doc = (await this.documents()).find(d => d.sessionId === sessionId && d.participantId === participantId && d.phase === phase);
    if (doc?.state !== "captured") throw new ConflictException("Please finish saving your writing task first");
    return doc.id;
  }
}
