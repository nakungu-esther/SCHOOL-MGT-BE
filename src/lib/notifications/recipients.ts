import type { AnnouncementAudience, Role } from "@prisma/client";
import { prisma } from "../prisma";

export async function userIdsByRole(
  schoolId: string,
  roles: Role[],
): Promise<string[]> {
  const rows = await prisma.membership.findMany({
    where: { schoolId, role: { in: roles } },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

export async function parentUserIdsForStudent(
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  const links = await prisma.studentPortalLink.findMany({
    where: { schoolId, studentId, linkType: "PARENT" },
    select: { userId: true },
  });
  return links.map((l) => l.userId);
}

export async function studentUserIdsForStudent(
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  const links = await prisma.studentPortalLink.findMany({
    where: { schoolId, studentId, linkType: "STUDENT" },
    select: { userId: true },
  });
  return links.map((l) => l.userId);
}

export async function familyUserIdsForStudent(
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  const [parents, students] = await Promise.all([
    parentUserIdsForStudent(schoolId, studentId),
    studentUserIdsForStudent(schoolId, studentId),
  ]);
  return [...new Set([...parents, ...students])];
}

export async function userIdsForAnnouncementAudience(
  schoolId: string,
  audience: AnnouncementAudience,
): Promise<string[]> {
  if (audience === "ALL") {
    const rows = await prisma.membership.findMany({
      where: {
        schoolId,
        role: { in: ["PARENT", "STUDENT", "SCHOOL_ADMIN", "TEACHER", "BURSAR"] },
      },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }
  const role = audience === "PARENT" ? "PARENT" : "STUDENT";
  return userIdsByRole(schoolId, [role]);
}
