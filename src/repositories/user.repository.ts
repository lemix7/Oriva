import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";

const userFields = {
  id: users.id,
  name: users.name,
  email: users.email,
  password: users.password,
  role: users.role,
  profile_pic_key: users.profilePicKey,
};

export async function findUserByEmail(
  email: string,
): Promise<{ id: number; password: string } | null> {
  const [user] = await db
    .select({
      id: users.id,
      password: users.password,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return user ?? null;
}

export async function insertUser(
  name: string,
  email: string,
  pass: string,
  key: string | null,
) {
  const [user] = await db
    .insert(users)
    .values({ name, email, password: pass, profilePicKey: key })
    .returning(userFields);
  return user;
}

export async function findUserProfileById(userId: number) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user;
}

export async function updateUserProfile(
  userId: number,
  changes: {
    name?: string;
    email?: string;
  },
) {
  const [user] = await db
    .update(users)
    .set({
      name: changes.name,
      email: changes.email,
    })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
    });

  return user;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function updateUserPassword(
  tx: Transaction,
  userId: number,
  passwordHash: string,
) {
  const [user] = await tx
    .update(users)
    .set({ password: passwordHash })
    .where(eq(users.id, userId))
    .returning({ id: users.id });

  return user ?? null;
}
