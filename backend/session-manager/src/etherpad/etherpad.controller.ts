import { Body, Controller, Get, Headers, Param, Post, Put, UseGuards, BadRequestException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { PadPhase } from "@gdm/shared";
import { EtherpadService } from "./etherpad.service";
import { AdminGuard } from "../auth/admin.guard";
import { bearerToken } from "../auth/bearer-token";

@Controller()
export class EtherpadController {
  constructor(private readonly etherpad: EtherpadService) {}
  @Get("admin/etherpad") @UseGuards(AdminGuard)
  status() { return this.etherpad.status(); }
  @Put("admin/etherpad") @UseGuards(AdminGuard)
  toggle(@Body() body: { enabled?: boolean }) {
    if (typeof body?.enabled !== "boolean") throw new BadRequestException("enabled must be a boolean");
    return this.etherpad.setEnabled(body.enabled);
  }
  @Post("workspace/prepare") @Throttle({ default: { limit: 60, ttl: 60_000 } })
  prepare(@Headers("authorization") authorization: string) {
    return this.etherpad.prepare(bearerToken(authorization) ?? "");
  }
  @Post("workspace/pads/:phase") @Throttle({ default: { limit: 120, ttl: 60_000 } })
  pad(@Headers("authorization") authorization: string, @Param("phase") phase: PadPhase, @Body() body: { sessionId?: string }) {
    if (!["entry", "group", "exit"].includes(phase)) throw new BadRequestException("Invalid phase");
    return this.etherpad.pad(bearerToken(authorization) ?? "", phase, body?.sessionId);
  }
  @Post("workspace/finish/:id")
  finish(@Headers("authorization") authorization: string, @Param("id") id: string) {
    return this.etherpad.finish(bearerToken(authorization) ?? "", id);
  }
  @Post("workspace/leave")
  async leave(@Headers("authorization") authorization: string) {
    await this.etherpad.leave(bearerToken(authorization) ?? "");
    return { ok: true };
  }
}
