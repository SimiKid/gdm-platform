import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}

/**
 * Protects researcher-only endpoints (condition/settings mutations, session
 * listings, data exports). The token is set via ADMIN_API_TOKEN and sent as an
 * `x-admin-token` header, or — for plain download links — a `token` query
 * parameter. When ADMIN_API_TOKEN is unset the guard is open (local dev);
 * a real study run must set it.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private static warned = false;
  private readonly log = new Logger(AdminGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected) {
      if (!AdminGuard.warned) {
        AdminGuard.warned = true;
        this.log.warn(
          "ADMIN_API_TOKEN is not set — admin endpoints are unprotected",
        );
      }
      return true;
    }
    const req = context.switchToHttp().getRequest<IncomingRequest>();
    const provided =
      req.headers["x-admin-token"] ??
      (typeof req.query.token === "string" ? req.query.token : undefined);
    if (provided === expected) return true;
    throw new UnauthorizedException("Admin token required");
  }
}
