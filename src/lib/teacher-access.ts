import { prisma } from "./prisma";
import type { AuthedRequest } from "../middleware/auth";

export async function staffIdForUser(
  userId: string,
  schoolId: string,
): Promise<string | null> {
  const staff = await prisma.staff.findFirst({
    where: { userId, schoolId, active: true },
    select: { id: true },
  });
  return staff?.id ?? null;
}

export async function teacherCanManageClass(
  req: AuthedRequest,
  classId: string,
  academicYearId?: string,
): Promise<boolean> {
  if (!req.auth) return false;
  if (req.auth.role === "SCHOOL_ADMIN") return true;
  if (req.auth.role !== "TEACHER") return false;

  const staffId = await staffIdForUser(req.auth.user.id, req.auth.schoolId);
  if (!staffId) return false;

  const assignment = await prisma.teachingAssignment.findFirst({
    where: {
      schoolId: req.auth.schoolId,
      staffId,
      classId,
      ...(academicYearId ? { academicYearId } : {}),
    },
  });
  return Boolean(assignment);
}

export async function teacherCanManageSubjectOnClass(
  req: AuthedRequest,
  classId: string,
  subjectId: string,
  academicYearId: string,
): Promise<boolean> {
  if (!req.auth) return false;
  if (req.auth.role === "SCHOOL_ADMIN") return true;
  if (req.auth.role !== "TEACHER") return false;

  const staffId = await staffIdForUser(req.auth.user.id, req.auth.schoolId);
  if (!staffId) return false;

  const assignment = await prisma.teachingAssignment.findFirst({
    where: {
      schoolId: req.auth.schoolId,
      staffId,
      classId,
      subjectId,
      academicYearId,
    },
  });
  return Boolean(assignment);
}
