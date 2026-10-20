import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

const uuid = z.uuid().optional();

export const analyticsQuerySchema = z.object({
  academicYearId: uuid,
  term: z.string().trim().max(64).optional(),
  from: z.string().min(4).max(40).optional(),
  to: z.string().min(4).max(40).optional(),
  classId: uuid,
  streamId: uuid,
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  status: z.enum(["ACTIVE", "GRADUATED", "TRANSFERRED", "INACTIVE"]).optional(),
  subjectId: uuid,
  teacherId: uuid,
});

export type AnalyticsFilters = z.infer<typeof analyticsQuerySchema>;

export function parseAnalyticsFilters(
  query: Record<string, unknown>,
): AnalyticsFilters {
  const raw = {
    academicYearId: query.academicYearId ? String(query.academicYearId) : undefined,
    term: query.term ? String(query.term) : undefined,
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    classId: query.classId ? String(query.classId) : undefined,
    streamId: query.streamId ? String(query.streamId) : undefined,
    gender: query.gender ? String(query.gender) : undefined,
    status: query.status ? String(query.status) : undefined,
    subjectId: query.subjectId ? String(query.subjectId) : undefined,
    teacherId: query.teacherId ? String(query.teacherId) : undefined,
  };
  return analyticsQuerySchema.parse(raw);
}

export type ResolvedPeriod = {
  from: Date | null;
  to: Date | null;
  previousFrom: Date | null;
  previousTo: Date | null;
};

export async function resolveAnalyticsPeriod(
  schoolId: string,
  filters: AnalyticsFilters,
): Promise<ResolvedPeriod> {
  let from: Date | null = null;
  let to: Date | null = null;
  if (filters.from) {
    from = new Date(
      filters.from.includes("T") ? filters.from : `${filters.from}T00:00:00.000Z`,
    );
  }
  if (filters.to) {
    to = new Date(
      filters.to.includes("T") ? filters.to : `${filters.to}T23:59:59.999Z`,
    );
  }

  if (filters.academicYearId && !from && !to) {
    const year = await prisma.academicYear.findFirst({
      where: { id: filters.academicYearId, schoolId },
    });
    if (year) {
      from = year.startDate;
      to = year.endDate;
    }
  }

  let previousFrom: Date | null = null;
  let previousTo: Date | null = null;

  if (from && to) {
    const spanMs = to.getTime() - from.getTime();
    if (spanMs > 0) {
      previousTo = new Date(from.getTime() - 1);
      previousFrom = new Date(previousTo.getTime() - spanMs);
    }
  } else if (filters.academicYearId) {
    const current = await prisma.academicYear.findFirst({
      where: { id: filters.academicYearId, schoolId },
    });
    if (current) {
      const prior = await prisma.academicYear.findFirst({
        where: {
          schoolId,
          endDate: { lt: current.startDate },
        },
        orderBy: { endDate: "desc" },
      });
      if (prior) {
        previousFrom = prior.startDate;
        previousTo = prior.endDate;
      }
    }
  }

  return { from, to, previousFrom, previousTo };
}

export type StudentScope = {
  studentIds: string[];
  studentWhere: Prisma.StudentWhereInput;
};

const EMPTY_STUDENT_ID = "00000000-0000-0000-0000-000000000000";

export async function buildStudentScope(
  schoolId: string,
  filters: AnalyticsFilters,
): Promise<StudentScope> {
  const studentWhere: Prisma.StudentWhereInput = { schoolId };

  if (filters.gender) studentWhere.gender = filters.gender;
  if (filters.status) studentWhere.status = filters.status;

  const enrollmentSome: Prisma.StudentEnrollmentWhereInput = { active: true };

  if (filters.academicYearId) enrollmentSome.academicYearId = filters.academicYearId;
  if (filters.classId) enrollmentSome.classId = filters.classId;
  if (filters.streamId) enrollmentSome.streamId = filters.streamId;

  let classIdsFromTeacher: string[] | null = null;
  if (filters.teacherId) {
    const assignments = await prisma.teachingAssignment.findMany({
      where: {
        schoolId,
        staffId: filters.teacherId,
        ...(filters.academicYearId
          ? { academicYearId: filters.academicYearId }
          : {}),
        ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
      },
      select: { classId: true },
    });
    classIdsFromTeacher = [...new Set(assignments.map((a) => a.classId))];
    if (classIdsFromTeacher.length === 0) {
      return {
        studentIds: [],
        studentWhere: { schoolId, id: { in: [] } },
      };
    }
    if (!filters.classId) {
      enrollmentSome.classId = { in: classIdsFromTeacher };
    }
  }

  const useEnrollment =
    filters.academicYearId ||
    filters.classId ||
    filters.streamId ||
    classIdsFromTeacher;

  if (useEnrollment) {
    if (classIdsFromTeacher && filters.classId) {
      if (!classIdsFromTeacher.includes(filters.classId)) {
        return {
          studentIds: [],
          studentWhere: { schoolId, id: { in: [] } },
        };
      }
    }
    studentWhere.enrollments = { some: enrollmentSome };
  } else if (filters.classId) {
    const cls = await prisma.schoolClass.findFirst({
      where: { id: filters.classId, schoolId },
      select: { name: true },
    });
    if (cls) {
      const rows = await prisma.student.findMany({
        where: {
          schoolId,
          className: cls.name,
          ...(filters.gender ? { gender: filters.gender } : {}),
          ...(filters.status ? { status: filters.status } : {}),
        },
        select: { id: true },
      });
      const ids = rows.map((r) => r.id);
      return {
        studentIds: ids,
        studentWhere: {
          schoolId,
          id: { in: ids.length ? ids : [EMPTY_STUDENT_ID] },
        },
      };
    }
  }

  if (filters.subjectId && !filters.teacherId) {
    const assignments = await prisma.teachingAssignment.findMany({
      where: {
        schoolId,
        subjectId: filters.subjectId,
        ...(filters.academicYearId
          ? { academicYearId: filters.academicYearId }
          : {}),
        ...(filters.classId ? { classId: filters.classId } : {}),
      },
      select: { classId: true },
    });
    const classIds = [...new Set(assignments.map((a) => a.classId))];
    if (classIds.length === 0) {
      return {
        studentIds: [],
        studentWhere: { schoolId, id: { in: [] } },
      };
    }
    studentWhere.enrollments = {
      some: {
        active: true,
        classId: { in: classIds },
        ...(filters.academicYearId
          ? { academicYearId: filters.academicYearId }
          : {}),
        ...(filters.streamId ? { streamId: filters.streamId } : {}),
      },
    };
  }

  const students = await prisma.student.findMany({
    where: studentWhere,
    select: { id: true },
  });
  const studentIds = students.map((s) => s.id);

  return {
    studentIds,
    studentWhere: {
      ...studentWhere,
      id: studentIds.length ? { in: studentIds } : { in: [EMPTY_STUDENT_ID] },
    },
  };
}

export async function loadAnalyticsFilterOptions(schoolId: string) {
  const [years, classes, subjects, teachers] = await Promise.all([
    prisma.academicYear.findMany({
      where: { schoolId },
      orderBy: { startDate: "desc" },
      select: { id: true, name: true, isCurrent: true, startDate: true, endDate: true },
    }),
    prisma.schoolClass.findMany({
      where: { schoolId },
      include: {
        academicYear: { select: { id: true, name: true } },
        streams: { select: { id: true, name: true, capacity: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.subject.findMany({
      where: { schoolId, active: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.staff.findMany({
      where: { schoolId, active: true, kind: "TEACHER" },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true },
    }),
  ]);

  return {
    academicYears: years.map((y) => ({
      id: y.id,
      name: y.name,
      isCurrent: y.isCurrent,
      startDate: y.startDate.toISOString().slice(0, 10),
      endDate: y.endDate.toISOString().slice(0, 10),
    })),
    classes: classes.map((c) => ({
      id: c.id,
      name: c.name,
      academicYearId: c.academicYear.id,
      academicYearName: c.academicYear.name,
      streams: c.streams,
    })),
    subjects,
    teachers,
    terms: ["Term 1", "Term 2", "Term 3"],
  };
}
