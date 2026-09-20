import { CanActivate, ConflictException, ExecutionContext, Injectable } from "@nestjs/common";
import { EtherpadService } from "./etherpad.service";

@Injectable()
export class WorkspaceMutationGuard implements CanActivate {
  constructor(private readonly etherpad: EtherpadService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ method: string; url: string }>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    if (/\/api\/(conditions|rounds|settings|admin)(\/|\?|$)/.test(request.url) && await this.etherpad.busy()) {
      throw new ConflictException("Etherpad is starting or stopping. Wait before changing study settings.");
    }
    return true;
  }
}
