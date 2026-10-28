import { asc, eq } from "drizzle-orm";
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

export async function findAllUsers() {
  return db.select(userFields).from(users).orderBy(asc(users.id));
}

export async function findUsersById(id: number) {
  return db.select(userFields).from(users).where(eq(users.id, id));
}

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

export async function insertUser(name: string, email: string, pass: string, key: string | null) {
  const [user] = await db.insert(users)
    .values({ name, email, password: pass, profilePicKey: key })
    .returning(userFields);
  return user;
}

export async function updateUser(name: string, email: string, id: number) {
  const rows = await db.update(users).set({ name: name ?? null, email: email ?? null })
    .where(eq(users.id, id)).returning({ id: users.id });
  return rows.length > 0;
}

export async function deleteUser(id: number) {
  const rows = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
  return rows.length > 0;
}
