import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import {
  type AnalyticsFilters,
  buildStudentScope,
  resolveAnalyticsPeriod,
} from "./filters";
import { formatPct, kpi, pct } from "./kpi";

export async function enrollmentAnalytics(schoolId: string, filters: AnalyticsFilters) {
  const period = await resolveAnalyticsPeriod(schoolId, filters);
  const { studentWhere, studentIds } = await buildStudentScope(schoolId, filters);

  const baseWhere: Prisma.StudentWhereInput = { ...studentWhere, schoolId };

  const [enrolled, admissions, transferred, genderGroups, classGroups] = await Promise.all([
    prisma.student.count({ where: { ...baseWhere, status: "ACTIVE" } }),
    prisma.student.count({
      where: {
        ...baseWhere,
        ...(period.from || period.to
          ? {
              createdAt: {
                ...(period.from ? { gte: period.from } : {}),
                ...(period.to ? { lte: period.to } : {}),
              },
            }
          : {}),
      },
    }),
    prisma.student.count({
      where: {
        ...baseWhere,
        status: { in: ["TRANSFERRED", "INACTIVE"] },
        ...(period.from || period.to
          ? {
              updatedAt: {
                ...(period.from ? { gte: period.from } : {}),
                ...(period.to ? { lte: period.to } : {}),
              },
            }
          : {}),
      },
    }),
    prisma.student.groupBy({
      by: ["gender"],
      where: { ...baseWhere, status: "ACTIVE" },
      _count: { id: true },
    }),
    prisma.student.groupBy({
      by: ["className"],
      where: { ...baseWhere, status: "ACTIVE" },
      _count: { id: true },
      orderBy: { className: "asc" },
    }),
  ]);

  let months: { month: string; count: bigint }[] = [];
  if (studentIds.length > 0) {
    months = await prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COUNT(*)::bigint AS count
      FROM students
      WHERE school_id = ${schoolId}::uuid
        AND id = ANY(${studentIds}::uuid[])
      GROUP BY 1 ORDER BY 1 ASC LIMIT 24
    `.catch(() => []);
  }

  let capacityTotal = 0;
  if (filters.classId || filters.streamId) {
    const streams = await prisma.stream.findMany({
      where: {
        schoolId,
        ...(filters.classId ? { classId: filters.classId } : {}),
        ...(filters.streamId ? { id: filters.streamId } : {}),
      },
      select: { capacity: true },
    });
    capacityTotal = streams.reduce((s, x) => s + (x.capacity ?? 0), 0);
  }

  const retention = pct(enrolled, enrolled + transferred);

  return {
    period: {
      from: period.from?.toISOString() ?? null,
      to: period.to?.toISOString() ?? null,
    },
    kpis: [
      kpi("enrolled", "Total enrolled", "Active students in scope.", String(enrolled), enrolled),
      kpi("admissions", "New admissions", "Students created in the selected period.", String(admissions), admissions),
      kpi("retention", "Retention rate", "Active vs departures (approximation).", formatPct(retention), retention),
      kpi("transfers", "Transfers / inactive", "Status changes in period.", String(transferred), transferred),
      kpi(
        "capacity",
        "Capacity utilization",
        "Enrolled vs stream capacity when configured.",
        capacityTotal > 0 ? formatPct(pct(enrolled, capacityTotal)) : "—",
        capacityTotal > 0 ? pct(enrolled, capacityTotal) : null,
      ),
    ],
    charts: {
      enrollmentTrend: months.map((m) => ({ month: m.month, count: Number(m.count) })),
      byGender: genderGroups.map((g) => ({ gender: g.gender, count: g._count.id })),
      byClass: classGroups.map((c) => ({ className: c.className, count: c._count.id })),
    },
    tables: {
      byClass: classGroups.map((c) => ({
        className: c.className,
        students: c._count.id,
        linkPath: `/dashboard/students?search=${encodeURIComponent(c.className)}`,
      })),
    },
  };
}
