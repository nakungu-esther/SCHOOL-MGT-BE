import { prisma } from "./prisma";

export async function assertYearInSchool(
  schoolId: string,
  academicYearId: string,
): Promise<boolean> {
  const row = await prisma.academicYear.findFirst({
    where: { id: academicYearId, schoolId },
  });
  return Boolean(row);
}

export async function assertClassInSchool(
  schoolId: string,
  classId: string,
): Promise<boolean> {
  const row = await prisma.schoolClass.findFirst({
    where: { id: classId, schoolId },
  });
  return Boolean(row);
}

export async function assertStreamInSchool(
  schoolId: string,
  streamId: string,
): Promise<boolean> {
  const row = await prisma.stream.findFirst({
    where: { id: streamId, schoolId },
  });
  return Boolean(row);
}

export async function assertSubjectInSchool(
  schoolId: string,
  subjectId: string,
): Promise<boolean> {
  const row = await prisma.subject.findFirst({
    where: { id: subjectId, schoolId },
  });
  return Boolean(row);
}

export async function assertStaffInSchool(
  schoolId: string,
  staffId: string,
): Promise<boolean> {
  const row = await prisma.staff.findFirst({
    where: { id: staffId, schoolId },
  });
  return Boolean(row);
}

export function paramId(raw: string | string[]): string {
  return Array.isArray(raw) ? raw[0] : raw;
}
