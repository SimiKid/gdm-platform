import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  Condition,
  OpenSessionRequest,
  OpenSessionResponse,
  Participant,
  Session,
  SubmitSurveyRequest,
} from "@gdm/shared";
import { MatrixService } from "../matrix/matrix.service";
import { StoreService } from "../store/store.service";

@Injectable()
export class SessionsService {
  private readonly log = new Logger(SessionsService.name);
  /** URL the browser uses to reach Synapse (returned to the client). */
  private readonly publicUrl =
    process.env.MATRIX_PUBLIC_URL ?? "http://localhost:8008";

  constructor(
    private readonly store: StoreService,
    private readonly matrix: MatrixService,
  ) {}

  /**
   * Waiting-Room entry: place the participant into a forming group, register
   * their Matrix user, and — once the group is full — provision the room and
   * flip the session to "running".
   */
  async openSession(req: OpenSessionRequest): Promise<OpenSessionResponse> {
    let session = this.store.findForming() ?? this.store.createForming(this.assignCondition());

    const creds = await this.matrix.registerUser("gdm");
    const participant: Participant = {
      id: randomUUID(),
      name: req.participantName,
      trackingToken: req.trackingToken,
    };
    session.participants.push(participant);
    this.store.creds.set(participant.id, creds);

    if (session.participants.length >= session.condition.groupSize) {
      await this.provision(session);
    }
    this.store.saveSession(session);

    this.log.log(
      `openSession: ${participant.name} -> ${session.condition.name} ` +
        `(${session.participants.length}/${session.condition.groupSize}) ${session.status}`,
    );

    return {
      session,
      participantId: participant.id,
      matrix: {
        homeserverUrl: this.publicUrl,
        userId: creds.userId,
        accessToken: creds.accessToken,
        roomId: session.roomId ?? "",
      },
    };
  }

  getSession(id: string): Session {
    const session = this.store.getSession(id);
    if (!session) throw new NotFoundException(`Unknown session ${id}`);
    return session;
  }

  submitSurvey(req: SubmitSurveyRequest): void {
    const session = this.getSession(req.sessionId);
    const participant = session.participants.find((p) => p.id === req.participantId);
    if (!participant) throw new NotFoundException(`Unknown participant ${req.participantId}`);
    if (req.kind === "entry") participant.entrySurvey = req.survey;
    else participant.exitSurvey = req.survey;
    this.store.saveSession(session);
  }

  /** Least-completed active condition that hasn't reached its goal. */
  private assignCondition(): Condition {
    const candidate = this.store
      .listConditions()
      .filter((c) => c.active && this.store.claimedCount(c.id) < c.goal)
      .sort((a, b) => this.store.claimedCount(a.id) - this.store.claimedCount(b.id))[0];
    if (!candidate) throw new ConflictException("Study is full — no active condition needs participants");
    return candidate;
  }

  private async provision(session: Session): Promise<void> {
    const roomId = await this.matrix.createRoom(
      `GDM ${session.condition.name} · ${session.id.slice(0, 8)}`,
    );
    for (const p of session.participants) {
      const creds = this.store.creds.get(p.id);
      if (creds) await this.matrix.joinRoom(creds.accessToken, roomId);
    }
    session.roomId = roomId;
    session.status = "running";
    session.startedAt = new Date().toISOString();
    this.log.log(`provisioned room ${roomId} for session ${session.id}`);
  }
}
