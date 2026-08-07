import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { StoreService } from "../store/store.service";
import { bearerToken } from "./bearer-token";

interface ParticipantRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
}

/**
 * Authorizes participant REST calls with the tracking token that created the
 * seat. The token already exists in every generic, individual-link and
 * Prolific flow, so this adds object-level authorization without another
 * credential or a schema migration.
 */
@Injectable()
export class ParticipantGuard implements CanActivate {
  constructor(private readonly store: StoreService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ParticipantRequest>();
    const token = bearerToken(request.headers.authorization);
    const sessionId =
      request.params?.sessionId ??
      request.params?.id ??
      stringField(request.body, "sessionId");
    const participantId =
      request.params?.participantId ?? stringField(request.body, "participantId");

    if (
      !token ||
      token.length > 256 ||
      !sessionId ||
      !(await this.store.hasParticipantAccess(sessionId, token, participantId))
    ) {
      // Use one response for absent and mismatched credentials so this endpoint
      // cannot be used to discover participant or session identifiers.
      throw new UnauthorizedException("Participant authorization required");
    }
    return true;
  }
}

function stringField(
  body: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = body?.[key];
  return typeof value === "string" ? value : undefined;
}
