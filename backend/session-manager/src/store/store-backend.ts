import type { PrismaService } from "../prisma/prisma.service";

/**
 * What a store area delegated from StoreService needs from it: the
 * database switch (re-evaluated per call, like StoreService itself), the
 * Prisma client and the one-time seeding of the database.
 */
export interface StoreBackend {
  dbEnabled(): boolean;
  db(): PrismaService;
  ensureSeeded(): Promise<void>;
}
