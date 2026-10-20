import type { AnnouncementAudience, Role } from "@prisma/client";
import { prisma } from "./prisma";

export function announcementVisibleToRole(
  audience: AnnouncementAudience,
  role: Role,
): boolean {
  if (role === "SCHOOL_ADMIN") return true;
  if (audience === "ALL") return role === "PARENT" || role === "STUDENT";
  if (audience === "PARENT") return role === "PARENT";
  if (audience === "STUDENT") return role === "STUDENT";
  return false;
}

export function hasExplicitStudentLink(
  links: { studentId: string; userId: string }[],
  userId: string,
  studentId: string,
): boolean {
  return links.some((l) => l.userId === userId && l.studentId === studentId);
}

export async function userCanAccessStudentRecord(input: {
  schoolId: string;
  userId: string;
  membershipRole: Role;
  studentId: string;
}): Promise<boolean> {
  if (input.membershipRole !== "PARENT" && input.membershipRole !== "STUDENT") {
    return false;
  }

  const link = await prisma.studentPortalLink.findFirst({
    where: {
      schoolId: input.schoolId,
      userId: input.userId,
      studentId: input.studentId,
    },
  });
  return Boolean(link);
}
