import { Body, Controller, Post } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { configureRequestBodyLimit } from "./request-body";

@Controller("payload")
class PayloadController {
  @Post()
  accept(@Body() body: { value: string }): { length: number } {
    return { length: body.value.length };
  }
}

describe("configureRequestBodyLimit", () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("accepts JSON larger than Express's 100 KB default", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PayloadController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureRequestBodyLimit(app);
    await app.init();

    const value = "x".repeat(150_000);
    const response = await request(app.getHttpServer())
      .post("/payload")
      .send({ value })
      .expect(201);

    expect(response.body).toEqual({ length: value.length });
  });
});
