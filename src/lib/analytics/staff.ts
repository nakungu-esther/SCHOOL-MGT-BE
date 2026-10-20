import { prisma } from "../prisma";
import { type AnalyticsFilters } from "./filters";
import { kpi } from "./kpi";

export async function staffAnalytics(schoolId: string, filters: AnalyticsFilters) {
  const yearId = filters.academicYearId;

  const [staffByKind, deptGroups, teachers, assignments, subjects, classes, activeStudents] =
    await Promise.all([
      prisma.staff.groupBy({
        by: ["kind"],
        where: { schoolId, active: true },
        _count: { id: true },
      }),
      prisma.staff.groupBy({
        by: ["department"],
        where: { schoolId, active: true, department: { not: null } },
        _count: { id: true },
      }),
      prisma.staff.findMany({
        where: { schoolId, active: true, kind: "TEACHER" },
        select: { id: true, fullName: true, department: true },
      }),
      prisma.teachingAssignment.findMany({
        where: {
          schoolId,
          ...(yearId ? { academicYearId: yearId } : {}),
          ...(filters.classId ? { classId: filters.classId } : {}),
          ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
          ...(filters.teacherId ? { staffId: filters.teacherId } : {}),
        },
        include: {
          subject: { select: { name: true } },
          schoolClass: { select: { name: true } },
          staff: { select: { fullName: true } },
        },
      }),
      prisma.subject.findMany({
        where: { schoolId, active: true },
        select: { id: true, name: true, code: true },
      }),
      prisma.schoolClass.findMany({
        where: {
          schoolId,
          ...(yearId ? { academicYearId: yearId } : {}),
        },
        select: { id: true, name: true },
      }),
      prisma.student.count({ where: { schoolId, status: "ACTIVE" } }),
    ]);

  const teacherCount = teachers.length;
  const ratio = teacherCount > 0 ? Math.round((activeStudents / teacherCount) * 10) / 10 : null;

  const workload = new Map<string, { name: string; count: number }>();
  for (const a of assignments) {
    const w = workload.get(a.staffId) ?? { name: a.staff.fullName, count: 0 };
    w.count += 1;
    workload.set(a.staffId, w);
  }

  const assignedSubjectIds = new Set(assignments.map((a) => a.subjectId));
  const unassignedSubjects = subjects.filter((s) => !assignedSubjectIds.has(s.id));

  const assignedClassIds = new Set(assignments.map((a) => a.classId));
  const unassignedClasses = classes.filter((c) => !assignedClassIds.has(c.id));

  return {
    kpis: [
      kpi("staff", "Active staff", "All active staff records.", String(staffByKind.reduce((s, r) => s + r._count.id, 0))),
      kpi("teachers", "Teachers", "Active teaching staff.", String(teacherCount), teacherCount),
      kpi("ratio", "Student–teacher ratio", "Active students per teacher.", ratio !== null ? `1:${ratio}` : "—", ratio),
      kpi("unassignedSubjects", "Unassigned subjects", "No teaching assignment in scope.", String(unassignedSubjects.length), unassignedSubjects.length),
      kpi("timetableConflicts", "Timetable conflicts", "Requires timetable module.", "0", 0),
    ],
    charts: {
      byKind: staffByKind.map((k) => ({ kind: k.kind, count: k._count.id })),
      byDepartment: deptGroups.map((d) => ({
        department: d.department ?? "Unspecified",
        count: d._count.id,
      })),
      workload: [...workload.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 15)
        .map((w) => ({ teacher: w.name, assignments: w.count })),
    },
    tables: {
      workload: [...workload.entries()].map(([staffId, w]) => ({
        staffId,
        teacher: w.name,
        assignments: w.count,
        linkPath: `/dashboard/staff`,
      })),
      unassignedSubjects: unassignedSubjects.map((s) => ({
        code: s.code,
        name: s.name,
        linkPath: `/dashboard/academics`,
      })),
      unassignedClasses: unassignedClasses.map((c) => ({
        className: c.name,
        linkPath: `/dashboard/academics`,
      })),
    },
  };
}
