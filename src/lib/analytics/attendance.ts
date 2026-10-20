import { prisma } from "../prisma";
import {
  type AnalyticsFilters,
  buildStudentScope,
  resolveAnalyticsPeriod,
} from "./filters";
import { formatPct, kpi, pct } from "./kpi";

const CHRONIC_THRESHOLD = 5;

export async function attendanceAnalytics(schoolId: string, filters: AnalyticsFilters) {
  const period = await resolveAnalyticsPeriod(schoolId, filters);
  const { studentIds } = await buildStudentScope(schoolId, filters);

  if (studentIds.length === 0) {
    return emptyAttendance();
  }

  const dateFilter =
    period.from || period.to
      ? {
          recordDate: {
            ...(period.from ? { gte: period.from } : {}),
            ...(period.to ? { lte: period.to } : {}),
          },
        }
      : {};

  const where = {
    schoolId,
    studentId: { in: studentIds },
    ...dateFilter,
  };

  const [byStatus, byClass, records] = await Promise.all([
    prisma.attendanceRecord.groupBy({
      by: ["status"],
      where,
      _count: { id: true },
    }),
    prisma.attendanceRecord.groupBy({
      by: ["className"],
      where,
      _count: { id: true },
    }),
    prisma.attendanceRecord.findMany({
      where,
      select: { recordDate: true, status: true, studentId: true },
      take: 8000,
    }),
  ]);

  let total = 0;
  let present = 0;
  let absent = 0;
  let late = 0;
  for (const row of byStatus) {
    total += row._count.id;
    if (row.status === "PRESENT" || row.status === "EXCUSED") present += row._count.id;
    if (row.status === "ABSENT") absent += row._count.id;
    if (row.status === "LATE") {
      late += row._count.id;
      present += row._count.id;
    }
  }

  const rate = pct(present, total);
  const absentRate = pct(absent, total);
  const lateRate = pct(late, total);

  const byDay = new Map<string, { total: number; ok: number }>();
  const byWeekday = new Map<number, { total: number; ok: number }>();
  const absencesByStudent = new Map<string, number>();

  for (const r of records) {
    const day = r.recordDate.toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { total: 0, ok: 0 };
    bucket.total += 1;
    if (r.status !== "ABSENT") bucket.ok += 1;
    byDay.set(day, bucket);

    const wd = r.recordDate.getUTCDay();
    const wb = byWeekday.get(wd) ?? { total: 0, ok: 0 };
    wb.total += 1;
    if (r.status !== "ABSENT") wb.ok += 1;
    byWeekday.set(wd, wb);

    if (r.status === "ABSENT") {
      absencesByStudent.set(r.studentId, (absencesByStudent.get(r.studentId) ?? 0) + 1);
    }
  }

  const chronicIds = [...absencesByStudent.entries()]
    .filter(([, c]) => c >= CHRONIC_THRESHOLD)
    .map(([id]) => id);

  const chronicStudents = chronicIds.length
    ? await prisma.student.findMany({
        where: { schoolId, id: { in: chronicIds } },
        select: { id: true, fullName: true, className: true, admissionNo: true },
      })
    : [];

  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    kpis: [
      kpi("rate", "Attendance rate", "Present, late, or excused share.", formatPct(rate), rate),
      kpi("absent", "Absenteeism rate", "Absent marks share.", formatPct(absentRate), absentRate),
      kpi("late", "Late arrival rate", "Late marks share.", formatPct(lateRate), lateRate),
      kpi("chronic", "Follow-up students", `≥ ${CHRONIC_THRESHOLD} absences in period.`, String(chronicStudents.length), chronicStudents.length),
    ],
    charts: {
      daily: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-30)
        .map(([date, v]) => ({ date, rate: pct(v.ok, v.total) ?? 0 })),
      byClass: byClass.map((c) => {
        return { className: c.className, records: c._count.id };
      }),
      byWeekday: [...byWeekday.entries()]
        .sort(([a], [b]) => a - b)
        .map(([d, v]) => ({ day: weekdayNames[d] ?? String(d), rate: pct(v.ok, v.total) ?? 0 })),
      heatmap: [...byDay.entries()].map(([date, v]) => ({
        date,
        rate: pct(v.ok, v.total),
      })),
    },
    tables: {
      followUp: chronicStudents.map((s) => ({
        studentId: s.id,
        name: s.fullName,
        className: s.className,
        admissionNo: s.admissionNo,
        absences: absencesByStudent.get(s.id) ?? 0,
        linkPath: `/dashboard/students?search=${encodeURIComponent(s.admissionNo)}`,
      })),
    },
  };
}

function emptyAttendance() {
  return {
    kpis: [
      kpi("rate", "Attendance rate", "No records.", "—"),
      kpi("absent", "Absenteeism rate", "—", "—"),
      kpi("late", "Late rate", "—", "—"),
      kpi("chronic", "Follow-up students", "—", "0"),
    ],
    charts: { daily: [], byClass: [], byWeekday: [], heatmap: [] },
    tables: { followUp: [] },
  };
}
