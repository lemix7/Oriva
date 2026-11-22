import { db } from "../db/index.ts";
import { passwordResetTokens } from "../db/schema.ts";
import { and, eq, isNull } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function savePasswordResetToken(
  tx: Transaction,
  input: {
    userId: number;
    tokenHash: string;
    expiresAt: Date;
  },
) {
  await tx
    .insert(passwordResetTokens)
    .values(input)
    .onConflictDoUpdate({
      target: passwordResetTokens.userId,
      set: {
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        usedAt: null,
        createdAt: new Date(),
      },
    });
}

export async function findPasswordResetTokenByHash(tokenHash: string) {
  const [token] = await db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  return token ?? null;
}

export async function lockPasswordResetToken(
  tx: Transaction,
  tokenHash: string,
) {
  const [token] = await tx
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1)
    .for("update");

  return token ?? null;
}

export async function invalidatePasswordResetToken(
  tx: Transaction,
  userId: number,
  now: Date,
) {
  await tx
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.userId, userId),
        isNull(passwordResetTokens.usedAt),
      ),
    );
}
