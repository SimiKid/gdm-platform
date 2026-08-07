import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { safeTokenEqual } from "./bearer-token";

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Protects service-to-service endpoints (Chat Service → Session Manager
 * finalize). Both services share INTERNAL_API_TOKEN and send it as an
 * `x-internal-token` header. Unset = open (local dev).
 */
@Injectable()
export class InternalGuard implements CanActivate {
  private static warned = false;
  private readonly log = new Logger(InternalGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) {
      if (!InternalGuard.warned) {
        InternalGuard.warned = true;
        this.log.warn(
          "INTERNAL_API_TOKEN is not set — internal endpoints are unprotected",
        );
      }
      return true;
    }
    const req = context.switchToHttp().getRequest<IncomingRequest>();
    const provided = req.headers["x-internal-token"];
    if (typeof provided === "string" && safeTokenEqual(provided, expected)) {
      return true;
    }
    throw new UnauthorizedException("Internal token required");
  }
}
