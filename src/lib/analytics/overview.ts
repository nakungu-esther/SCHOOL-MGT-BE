import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { getGradeBands } from "../grading";
import {
  type AnalyticsFilters,
  buildStudentScope,
  resolveAnalyticsPeriod,
  type ResolvedPeriod,
} from "./filters";

export type KpiTrend = "up" | "down" | "neutral" | null;

export type AnalyticsKpi = {
  key: string;
  label: string;
  definition: string;
  value: number | null;
  displayValue: string;
  previousValue: number | null;
  changePercent: number | null;
  trend: KpiTrend;
  hasComparison: boolean;
};

function decimalSum(values: { toString(): string }[]): number {
  let total = 0;
  for (const v of values) {
    total += Number(v);
  }
  return Math.round(total * 100) / 100;
}

function compareMetric(
  current: number | null,
  previous: number | null,
  higherIsBetter: boolean,
): Pick<AnalyticsKpi, "previousValue" | "changePercent" | "trend" | "hasComparison"> {
  if (current === null || previous === null || previous === 0) {
    return {
      previousValue: previous,
      changePercent: null,
      trend: null,
      hasComparison: previous !== null && previous !== 0,
    };
  }
  const changePercent = ((current - previous) / Math.abs(previous)) * 100;
  let trend: KpiTrend = "neutral";
  if (Math.abs(changePercent) >= 0.05) {
    const improved = higherIsBetter ? changePercent > 0 : changePercent < 0;
    trend = improved ? "up" : "down";
  }
  return {
    previousValue: previous,
    changePercent: Math.round(changePercent * 10) / 10,
    trend,
    hasComparison: true,
  };
}

function pct(n: number, d: number): number | null {
  if (d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

function formatPct(v: number | null): string {
  if (v === null) return "—";
  return `${v}%`;
}

function formatMoney(v: number | null, currency = ""): string {
  if (v === null) return "—";
  const prefix = currency ? `${currency} ` : "";
  return `${prefix}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRatio(v: number | null): string {
  if (v === null) return "—";
  return `1:${Math.round(v * 10) / 10}`;
}

async function countEnrolled(
  scope: Prisma.StudentWhereInput,
  statusDefaultActive: boolean,
): Promise<number> {
  const where: Prisma.StudentWhereInput = { ...scope };
  if (statusDefaultActive && !where.status) {
    where.status = "ACTIVE";
  }
  return prisma.student.count({ where });
}

async function countAdmissions(
  schoolId: string,
  scope: Prisma.StudentWhereInput,
  from: Date | null,
  to: Date | null,
): Promise<number> {
  const where: Prisma.StudentWhereInput = { ...scope, schoolId };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lte = to;
  }
  return prisma.student.count({ where });
}

async function countStatusChanges(
  scope: Prisma.StudentWhereInput,
  statuses: ("TRANSFERRED" | "INACTIVE" | "GRADUATED")[],
  from: Date | null,
  to: Date | null,
): Promise<number> {
  const where: Prisma.StudentWhereInput = {
    ...scope,
    status: { in: statuses },
  };
  if (from || to) {
    where.updatedAt = {};
    if (from) where.updatedAt.gte = from;
    if (to) where.updatedAt.lte = to;
  }
  return prisma.student.count({ where });
}

async function attendanceRate(
  schoolId: string,
  studentIds: string[],
  from: Date | null,
  to: Date | null,
  className?: string,
): Promise<number | null> {
  if (studentIds.length === 0) return null;
  const where: Prisma.AttendanceRecordWhereInput = {
    schoolId,
    studentId: { in: studentIds },
  };
  if (from || to) {
    where.recordDate = {};
    if (from) where.recordDate.gte = from;
    if (to) where.recordDate.lte = to;
  }
  if (className) where.className = className;

  const grouped = await prisma.attendanceRecord.groupBy({
    by: ["status"],
    where,
    _count: { id: true },
  });
  let total = 0;
  let attended = 0;
  for (const row of grouped) {
    total += row._count.id;
    if (row.status === "PRESENT" || row.status === "LATE" || row.status === "EXCUSED") {
      attended += row._count.id;
    }
  }
  return pct(attended, total);
}

async function examStats(
  schoolId: string,
  filters: AnalyticsFilters,
  studentIds: string[],
  passMinPercent: number,
): Promise<{ avgScore: number | null; passRate: number | null }> {
  if (studentIds.length === 0) return { avgScore: null, passRate: null };

  const examWhere: Prisma.ExaminationWhereInput = {
    schoolId,
    published: true,
  };
  if (filters.academicYearId) examWhere.academicYearId = filters.academicYearId;
  if (filters.term) examWhere.term = filters.term;
  if (filters.classId) examWhere.classId = filters.classId;

  const exams = await prisma.examination.findMany({
    where: examWhere,
    select: { id: true },
  });
  if (exams.length === 0) return { avgScore: null, passRate: null };

  const markWhere: Prisma.ExamMarkWhereInput = {
    schoolId,
    examinationId: { in: exams.map((e) => e.id) },
    studentId: { in: studentIds },
  };
  if (filters.subjectId) markWhere.subjectId = filters.subjectId;

  const marks = await prisma.examMark.findMany({
    where: markWhere,
    include: {
      examination: {
        include: { papers: { select: { subjectId: true, maxMarks: true } } },
      },
    },
  });
  if (marks.length === 0) return { avgScore: null, passRate: null };

  const percents: number[] = [];
  for (const m of marks) {
    const paper = m.examination.papers.find((p) => p.subjectId === m.subjectId);
    const max = paper?.maxMarks ?? 100;
    if (max <= 0) continue;
    percents.push((Number(m.score) / max) * 100);
  }
  if (percents.length === 0) return { avgScore: null, passRate: null };

  const avg = percents.reduce((a, b) => a + b, 0) / percents.length;
  const passed = percents.filter((p) => p >= passMinPercent).length;
  return {
    avgScore: Math.round(avg * 10) / 10,
    passRate: pct(passed, percents.length),
  };
}

async function financeStats(
  schoolId: string,
  studentIds: string[],
  from: Date | null,
  to: Date | null,
): Promise<{ invoiced: number; collected: number; outstanding: number; collectionRate: number | null }> {
  if (studentIds.length === 0) {
    return { invoiced: 0, collected: 0, outstanding: 0, collectionRate: null };
  }

  const invoiceWhere: Prisma.InvoiceWhereInput = {
    schoolId,
    studentId: { in: studentIds },
    status: { not: "VOID" },
  };
  if (from || to) {
    invoiceWhere.createdAt = {};
    if (from) invoiceWhere.createdAt.gte = from;
    if (to) invoiceWhere.createdAt.lte = to;
  }

  const invoices = await prisma.invoice.findMany({
    where: invoiceWhere,
    select: { amountTotal: true, amountPaid: true, status: true },
  });

  let invoiced = 0;
  let paidOnInvoices = 0;
  let outstanding = 0;
  for (const inv of invoices) {
    const total = Number(inv.amountTotal);
    const paid = Number(inv.amountPaid);
    invoiced += total;
    paidOnInvoices += paid;
    if (inv.status !== "PAID") {
      outstanding += Math.max(0, total - paid);
    }
  }

  const paymentWhere: Prisma.InvoicePaymentWhereInput = {
    schoolId,
    invoice: { studentId: { in: studentIds } },
  };
  if (from || to) {
    paymentWhere.paidAt = {};
    if (from) paymentWhere.paidAt.gte = from;
    if (to) paymentWhere.paidAt.lte = to;
  }
  const payments = await prisma.invoicePayment.findMany({
    where: paymentWhere,
    select: { amount: true },
  });
  const collected = decimalSum(payments.map((p) => p.amount));

  const collectionRate =
    invoiced > 0 ? pct(collected, invoiced) : paidOnInvoices > 0 ? pct(paidOnInvoices, invoiced) : null;

  return {
    invoiced: Math.round(invoiced * 100) / 100,
    collected: Math.round(collected * 100) / 100,
    outstanding: Math.round(outstanding * 100) / 100,
    collectionRate,
  };
}

async function capacityUtilization(
  schoolId: string,
  filters: AnalyticsFilters,
  enrolledCount: number,
): Promise<number | null> {
  const streamWhere: Prisma.StreamWhereInput = { schoolId };
  if (filters.classId) streamWhere.classId = filters.classId;
  if (filters.streamId) streamWhere.id = filters.streamId;

  const streams = await prisma.stream.findMany({
    where: streamWhere,
    select: { capacity: true },
  });
  const caps = streams.map((s) => s.capacity).filter((c): c is number => c != null && c > 0);
  if (caps.length === 0) return null;
  const totalCap = caps.reduce((a, b) => a + b, 0);
  return pct(enrolledCount, totalCap);
}

async function yoyEnrollmentGrowth(
  schoolId: string,
  filters: AnalyticsFilters,
): Promise<number | null> {
  if (!filters.academicYearId) return null;
  const current = await prisma.academicYear.findFirst({
    where: { id: filters.academicYearId, schoolId },
  });
  if (!current) return null;
  const prior = await prisma.academicYear.findFirst({
    where: { schoolId, endDate: { lt: current.startDate } },
    orderBy: { endDate: "desc" },
  });
  if (!prior) return null;

  const [currentCount, priorCount] = await Promise.all([
    prisma.studentEnrollment.count({
      where: { schoolId, academicYearId: current.id, active: true },
    }),
    prisma.studentEnrollment.count({
      where: { schoolId, academicYearId: prior.id, active: true },
    }),
  ]);
  if (priorCount === 0) return null;
  return Math.round(((currentCount - priorCount) / priorCount) * 1000) / 10;
}

export type OverviewCharts = {
  enrollmentByMonth: { month: string; count: number }[];
  attendanceWeekly: { week: string; rate: number | null }[];
};

async function chartEnrollmentByMonth(
  _schoolId: string,
  scope: Prisma.StudentWhereInput,
  from: Date | null,
  to: Date | null,
): Promise<OverviewCharts["enrollmentByMonth"]> {
  const where: Prisma.StudentWhereInput = { ...scope };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lte = to;
  }

  const students = await prisma.student.findMany({
    where,
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 5000,
  });
  if (students.length === 0) return [];

  const byMonth = new Map<string, number>();
  for (const s of students) {
    const month = s.createdAt.toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-24)
    .map(([month, count]) => ({ month, count }));
}

async function chartAttendanceWeekly(
  schoolId: string,
  studentIds: string[],
  from: Date | null,
  to: Date | null,
): Promise<OverviewCharts["attendanceWeekly"]> {
  if (studentIds.length === 0) return [];

  const records = await prisma.attendanceRecord.findMany({
    where: {
      schoolId,
      studentId: { in: studentIds },
      ...(from || to
        ? {
            recordDate: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    select: { recordDate: true, status: true },
    orderBy: { recordDate: "asc" },
    take: 5000,
  });

  const byWeek = new Map<string, { total: number; attended: number }>();
  for (const r of records) {
    const d = r.recordDate;
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    const bucket = byWeek.get(key) ?? { total: 0, attended: 0 };
    bucket.total += 1;
    if (r.status === "PRESENT" || r.status === "LATE" || r.status === "EXCUSED") {
      bucket.attended += 1;
    }
    byWeek.set(key, bucket);
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([week, v]) => ({
      week,
      rate: pct(v.attended, v.total),
    }));
}

async function computeKpiSet(
  schoolId: string,
  filters: AnalyticsFilters,
  period: ResolvedPeriod,
  scope: Prisma.StudentWhereInput,
  studentIds: string[],
  canFinance: boolean,
  currency: string,
): Promise<AnalyticsKpi[]> {
  const bands = await getGradeBands(schoolId);
  const failBand =
    bands.length > 0
      ? bands.reduce((min, b) => (b.sortOrder > min.sortOrder ? b : min), bands[0]!)
      : null;
  const passMinPercent = failBand ? failBand.maxPercent + 0.01 : 50;

  const prevScope = scope;

  const [
    enrolled,
    enrolledPrev,
    admissions,
    admissionsPrev,
    dropouts,
    dropoutsPrev,
    teachers,
    enrolledForRetention,
    enrolledPrevRetention,
  ] = await Promise.all([
    countEnrolled(scope, true),
    period.previousFrom && period.previousTo
      ? countEnrolled(prevScope, true)
      : Promise.resolve(null as number | null),
    countAdmissions(schoolId, scope, period.from, period.to),
    period.previousFrom && period.previousTo
      ? countAdmissions(schoolId, prevScope, period.previousFrom, period.previousTo)
      : Promise.resolve(null as number | null),
    countStatusChanges(scope, ["TRANSFERRED", "INACTIVE"], period.from, period.to),
    period.previousFrom && period.previousTo
      ? countStatusChanges(
          prevScope,
          ["TRANSFERRED", "INACTIVE"],
          period.previousFrom,
          period.previousTo,
        )
      : Promise.resolve(null as number | null),
    prisma.staff.count({ where: { schoolId, active: true, kind: "TEACHER" } }),
    countEnrolled(scope, true),
    period.previousFrom
      ? countEnrolled(prevScope, true)
      : Promise.resolve(null as number | null),
  ]);

  const retentionCurrent =
    enrolledForRetention + dropouts > 0
      ? pct(enrolledForRetention, enrolledForRetention + dropouts)
      : null;
  const retentionPrev =
    enrolledPrevRetention !== null && dropoutsPrev !== null
      ? enrolledPrevRetention + dropoutsPrev > 0
        ? pct(enrolledPrevRetention, enrolledPrevRetention + dropoutsPrev)
        : null
      : null;

  const dropoutRate =
    enrolledForRetention + dropouts > 0
      ? pct(dropouts, enrolledForRetention + dropouts)
      : null;
  const dropoutPrev =
    enrolledPrevRetention !== null && dropoutsPrev !== null
      ? enrolledPrevRetention + dropoutsPrev > 0
        ? pct(dropoutsPrev, enrolledPrevRetention + dropoutsPrev)
        : null
      : null;

  const [attRate, attRatePrev, exam, examPrev, finance, financePrev, capacity, yoyGrowth] =
    await Promise.all([
      attendanceRate(schoolId, studentIds, period.from, period.to),
      period.previousFrom && period.previousTo
        ? attendanceRate(
            schoolId,
            studentIds,
            period.previousFrom,
            period.previousTo,
          )
        : Promise.resolve(null as number | null),
      examStats(schoolId, filters, studentIds, passMinPercent),
      Promise.resolve({ avgScore: null as number | null, passRate: null as number | null }),
      canFinance
        ? financeStats(schoolId, studentIds, period.from, period.to)
        : Promise.resolve(null),
      canFinance && period.previousFrom && period.previousTo
        ? financeStats(schoolId, studentIds, period.previousFrom, period.previousTo)
        : Promise.resolve(null),
      capacityUtilization(schoolId, filters, enrolled),
      yoyEnrollmentGrowth(schoolId, filters),
    ]);

  const teacherRatio = teachers > 0 && enrolled > 0 ? enrolled / teachers : null;

  const kpis: AnalyticsKpi[] = [
    {
      key: "enrolled",
      label: "Total enrolled students",
      definition: "Active students matching the selected filters.",
      value: enrolled,
      displayValue: String(enrolled),
      ...compareMetric(enrolled, enrolledPrev, true),
    },
    {
      key: "admissions",
      label: "New admissions",
      definition: "Students admitted (created) within the selected period.",
      value: admissions,
      displayValue: String(admissions),
      ...compareMetric(admissions, admissionsPrev, true),
    },
    {
      key: "retention",
      label: "Student retention rate",
      definition: "Share of active students relative to departures in the period (approximation).",
      value: retentionCurrent,
      displayValue: formatPct(retentionCurrent),
      ...compareMetric(retentionCurrent, retentionPrev, true),
    },
    {
      key: "dropout",
      label: "Student dropout rate",
      definition: "Students marked transferred or inactive in the period vs active base.",
      value: dropoutRate,
      displayValue: formatPct(dropoutRate),
      ...compareMetric(dropoutRate, dropoutPrev, false),
    },
    {
      key: "attendance",
      label: "Average attendance rate",
      definition: "Present, late, or excused marks as a share of all attendance records in range.",
      value: attRate,
      displayValue: formatPct(attRate),
      ...compareMetric(attRate, attRatePrev, true),
    },
    {
      key: "passRate",
      label: "Academic pass rate",
      definition: "Share of published examination marks at or above the school pass threshold.",
      value: exam.passRate,
      displayValue: formatPct(exam.passRate),
      ...compareMetric(exam.passRate, examPrev.passRate, true),
    },
    {
      key: "avgScore",
      label: "Average examination score",
      definition: "Mean percentage score from published examinations and valid mark entries.",
      value: exam.avgScore,
      displayValue: exam.avgScore !== null ? `${exam.avgScore}%` : "—",
      ...compareMetric(exam.avgScore, examPrev.avgScore, true),
    },
  ];

  if (canFinance && finance) {
    const finPrev = financePrev;
    kpis.push(
      {
        key: "collectionRate",
        label: "Fee collection rate",
        definition: "Payments recorded in the period compared to invoiced amounts in the period.",
        value: finance.collectionRate,
        displayValue: formatPct(finance.collectionRate),
        ...compareMetric(
          finance.collectionRate,
          finPrev?.collectionRate ?? null,
          true,
        ),
      },
      {
        key: "outstanding",
        label: "Total outstanding fees",
        definition: "Unpaid balances on non-void, non-paid invoices for filtered students.",
        value: finance.outstanding,
        displayValue: formatMoney(finance.outstanding, currency),
        ...compareMetric(finance.outstanding, finPrev?.outstanding ?? null, false),
      },
    );
  } else {
    kpis.push(
      {
        key: "collectionRate",
        label: "Fee collection rate",
        definition: "Requires bursar or school admin access.",
        value: null,
        displayValue: "Restricted",
        previousValue: null,
        changePercent: null,
        trend: null,
        hasComparison: false,
      },
      {
        key: "outstanding",
        label: "Total outstanding fees",
        definition: "Requires bursar or school admin access.",
        value: null,
        displayValue: "Restricted",
        previousValue: null,
        changePercent: null,
        trend: null,
        hasComparison: false,
      },
    );
  }

  kpis.push(
    {
      key: "teacherRatio",
      label: "Teacher-to-student ratio",
      definition: "Active teachers compared to enrolled students (students per teacher).",
      value: teacherRatio,
      displayValue: formatRatio(teacherRatio),
      previousValue: null,
      changePercent: null,
      trend: null,
      hasComparison: false,
    },
    {
      key: "capacity",
      label: "Class capacity utilization",
      definition: "Enrolled students vs configured stream capacity where capacity is set.",
      value: capacity,
      displayValue: formatPct(capacity),
      previousValue: null,
      changePercent: null,
      trend: null,
      hasComparison: false,
    },
    {
      key: "yoyGrowth",
      label: "Year-on-year enrollment growth",
      definition: "Change in active enrollments vs the prior academic year (requires academic year filter).",
      value: yoyGrowth,
      displayValue: yoyGrowth !== null ? `${yoyGrowth}%` : "—",
      previousValue: null,
      changePercent: null,
      trend: yoyGrowth !== null && yoyGrowth > 0 ? "up" : yoyGrowth !== null && yoyGrowth < 0 ? "down" : null,
      hasComparison: yoyGrowth !== null,
    },
  );

  return kpis;
}

export async function analyticsOverview(
  schoolId: string,
  filters: AnalyticsFilters,
  canFinance: boolean,
) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { currency: true },
  });
  const currency = school?.currency ?? "";

  const period = await resolveAnalyticsPeriod(schoolId, filters);
  const { studentIds, studentWhere } = await buildStudentScope(schoolId, filters);

  const [kpis, enrollmentByMonth, attendanceWeekly] = await Promise.all([
    computeKpiSet(
      schoolId,
      filters,
      period,
      studentWhere,
      studentIds,
      canFinance,
      currency,
    ),
    chartEnrollmentByMonth(schoolId, studentWhere, period.from, period.to),
    chartAttendanceWeekly(schoolId, studentIds, period.from, period.to),
  ]);

  return {
    filters,
    period: {
      from: period.from?.toISOString() ?? null,
      to: period.to?.toISOString() ?? null,
      previousFrom: period.previousFrom?.toISOString() ?? null,
      previousTo: period.previousTo?.toISOString() ?? null,
    },
    kpis,
    charts: { enrollmentByMonth, attendanceWeekly },
    meta: { currency, canFinance },
  };
}
