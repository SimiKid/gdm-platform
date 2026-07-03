import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Dev: the Vite frontend runs on a different origin.
  app.enableCors();
  app.setGlobalPrefix("api");
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  new Logger("Bootstrap").log(`Session Manager listening on :${port}/api`);
}

void bootstrap();
