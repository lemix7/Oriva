import { db } from "../db/index.ts";
import {
  lockAuthUser,
  insertRefreshSession,
  findRefreshSessionByHash,
  lockRefreshSession,
  markRefreshSessionRotated,
  revokeRefreshFamily,
} from "../repositories/refresh-session.repository.ts";
import {
  generateRefreshToken,
  hashRefreshToken,
} from "../shared/refresh-token.ts";
import { createAccessToken } from "../auth/access-token.ts";
import { AppError } from "../shared/app-error.ts";

const REFRESH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export async function createLoginSession(
  userId: number,
  expectedPasswordHash: string,
) {
  return db.transaction(async (tx) => {
    const user = await lockAuthUser(tx, userId);

    if (!user || user.password !== expectedPasswordHash) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    }

    const { token, tokenHash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_LIFETIME_MS);

    const session = await insertRefreshSession(tx, {
      userId,
      tokenHash,
      expiresAt,
    });

    if (!session) {
      throw new Error("Refresh session insert returned no row");
    }

    return {
      accessToken: createAccessToken(user.id),
      refreshToken: token,
      refreshExpiresAt: session.expiresAt,
    };
  });
}

export async function rotateRefreshSession(token: string) {
  const tokenHash = hashRefreshToken(token);
  const candidate = await findRefreshSessionByHash(tokenHash);

  if (!candidate) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Please sign in again");
  }

  const result = await db.transaction(async (tx) => {
    const invalid = {
      ok: false as const,
      code: "INVALID_REFRESH_TOKEN",
    };

    const user = await lockAuthUser(tx, candidate.userId);

    if (!user) return invalid;

    const session = await lockRefreshSession(tx, tokenHash);

    if (!session || session.userId !== user.id) return invalid;

    const now = new Date();

    if (session.rotatedAt) {
      await revokeRefreshFamily(tx, user.id, session.familyId, now);

      return {
        ok: false as const,
        code: "REFRESH_TOKEN_REUSED",
      };
    }

    if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) {
      return invalid;
    }

    const rotated = await markRefreshSessionRotated(tx, session.id, now);

    if (!rotated) return invalid;

    const replacement = generateRefreshToken();

    const successor = await insertRefreshSession(tx, {
      userId: user.id,
      familyId: session.familyId,
      tokenHash: replacement.tokenHash,
      expiresAt: session.expiresAt,
    });

    if (!successor) {
      throw new Error("Refresh session insert returned no row");
    }

    return {
      ok: true as const,
      tokens: {
        accessToken: createAccessToken(user.id),
        refreshToken: replacement.token,
        refreshExpiresAt: successor.expiresAt,
      },
    };
  });

  // Throw after the transaction commits so reuse revocation is saved.
  if (!result.ok) {
    throw new AppError(401, result.code, "Please sign in again");
  }

  return result.tokens;
}

export async function logoutSession(token?: string) {
  if (!token) return;

  const tokenHash = hashRefreshToken(token);
  const candidate = await findRefreshSessionByHash(tokenHash);

  if (!candidate) return;

  await db.transaction(async (tx) => {
    const user = await lockAuthUser(tx, candidate.userId);

    if (!user) return;

    const session = await lockRefreshSession(tx, tokenHash);

    if (!session || session.userId !== user.id) return;

    await revokeRefreshFamily(tx, user.id, session.familyId, new Date());
  });
}
