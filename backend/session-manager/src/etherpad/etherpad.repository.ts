import { Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class EtherpadRepository {
  private readonly memory = new Map<string, unknown>();
  constructor(@Optional() private readonly prisma?: PrismaService) {}
  async get<T>(key: string): Promise<T | undefined> {
    if (!process.env.DATABASE_URL || !this.prisma) return structuredClone(this.memory.get(key)) as T | undefined;
    const row = await this.prisma.etherpadRecord.findUnique({ where: { key } });
    return row?.value as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    if (!process.env.DATABASE_URL || !this.prisma) { this.memory.set(key, structuredClone(value)); return; }
    const json = JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    await this.prisma.etherpadRecord.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
  }
  async list<T>(prefix: string): Promise<T[]> {
    if (!process.env.DATABASE_URL || !this.prisma) return [...this.memory].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value) as T);
    return (await this.prisma.etherpadRecord.findMany({ where: { key: { startsWith: prefix } } })).map(row => row.value as T);
  }
}
