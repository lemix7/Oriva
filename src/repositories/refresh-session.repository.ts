import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { refreshSessions, users } from "../db/schema.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lockAuthUser(tx: Transaction, userId: number) {
  const [user] = await tx
    .select({ id: users.id, password: users.password })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");

  return user ?? null;
}

export async function findRefreshSessionByHash(tokenHash: string) {
  const [session] = await db
    .select()
    .from(refreshSessions)
    .where(eq(refreshSessions.tokenHash, tokenHash))
    .limit(1);

  return session ?? null;
}

export async function lockRefreshSession(tx: Transaction, tokenHash: string) {
  const [session] = await tx
    .select()
    .from(refreshSessions)
    .where(eq(refreshSessions.tokenHash, tokenHash))
    .limit(1)
    .for("update");

  return session ?? null;
}

export async function insertRefreshSession(
  tx: Transaction,
  input: {
    userId: number;
    familyId?: string;
    tokenHash: string;
    expiresAt: Date;
  },
) {
  const [session] = await tx
    .insert(refreshSessions)
    .values({
      userId: input.userId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    })
    .returning();

  return session;
}

export async function markRefreshSessionRotated(
  tx: Transaction,
  sessionId: number,
  now: Date,
) {
  const [session] = await tx
    .update(refreshSessions)
    .set({ rotatedAt: now, updatedAt: now })
    .where(
      and(
        eq(refreshSessions.id, sessionId),
        isNull(refreshSessions.rotatedAt),
        isNull(refreshSessions.revokedAt),
      ),
    )
    .returning({ id: refreshSessions.id });

  return session ?? null;
}

export async function revokeRefreshFamily(
  tx: Transaction,
  userId: number,
  familyId: string,
  now: Date,
) {
  await tx
    .update(refreshSessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(refreshSessions.userId, userId),
        eq(refreshSessions.familyId, familyId),
        isNull(refreshSessions.revokedAt),
      ),
    );
}

export async function revokeAllRefreshSessions(
  tx: Transaction,
  userId: number,
  now: Date,
) {
  await tx
    .update(refreshSessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(refreshSessions.userId, userId),
        isNull(refreshSessions.revokedAt),
      ),
    );
}
