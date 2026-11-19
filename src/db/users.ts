import { pgDb } from './index.ts';
import { users } from './schema.ts';

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName?: string | null
) {
  try {
    const safeEmail = email || `${uid}@centraltv.local`;
    const result = await pgDb
      .insert(users)
      .values({
        uid,
        email: safeEmail,
        displayName: displayName || null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: safeEmail,
          ...(displayName ? { displayName } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Failed to sync authenticated user to database:', error);
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}
