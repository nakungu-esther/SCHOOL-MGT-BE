import { prisma } from "./prisma";

/** Works even when the generated Prisma client is out of date (raw SQL). */
export async function fetchOnboardingCompletedAt(
  schoolId: string,
): Promise<Date | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<
      { onboarding_completed_at: Date | null }[]
    >(
      `SELECT onboarding_completed_at FROM schools WHERE id = $1::uuid`,
      schoolId,
    );
    return rows[0]?.onboarding_completed_at ?? null;
  } catch {
    return null;
  }
}

export async function markOnboardingCompleted(schoolId: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE schools SET onboarding_completed_at = NOW() WHERE id = $1::uuid`,
      schoolId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("onboarding_completed_at")) {
      throw new Error(
        "Database migration required: run npm run db:migrate in the backend project.",
      );
    }
    throw err;
  }
}
