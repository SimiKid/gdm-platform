import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  new Logger("Bootstrap").log(`Chat Service listening on :${port}`);
}

void bootstrap();
