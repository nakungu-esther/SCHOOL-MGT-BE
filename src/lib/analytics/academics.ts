import { prisma } from "../prisma";
import { getGradeBands, gradeLabelForPercent } from "../grading";
import {
  type AnalyticsFilters,
  buildStudentScope,
  resolveAnalyticsPeriod,
} from "./filters";
import { formatPct, kpi, pct } from "./kpi";

function passThreshold(bands: Awaited<ReturnType<typeof getGradeBands>>): number {
  const fail = bands.reduce((m, b) => (b.sortOrder > m.sortOrder ? b : m), bands[0]!);
  return fail ? fail.maxPercent + 0.01 : 50;
}

export async function academicsAnalytics(schoolId: string, filters: AnalyticsFilters) {
  const { studentIds } = await buildStudentScope(schoolId, filters);
  const bands = await getGradeBands(schoolId);
  const passMin = passThreshold(bands);

  const examWhere = {
    schoolId,
    published: true,
    ...(filters.academicYearId ? { academicYearId: filters.academicYearId } : {}),
    ...(filters.term ? { term: filters.term } : {}),
    ...(filters.classId ? { classId: filters.classId } : {}),
  };

  const exams = await prisma.examination.findMany({
    where: examWhere,
    select: { id: true },
  });
  const examIds = exams.map((e) => e.id);

  if (examIds.length === 0 || studentIds.length === 0) {
    return emptyAcademics();
  }

  const marks = await prisma.examMark.findMany({
    where: {
      schoolId,
      examinationId: { in: examIds },
      studentId: { in: studentIds },
      ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
    },
    include: {
      subject: { select: { name: true, code: true } },
      examination: {
        include: { schoolClass: { select: { name: true } }, papers: true },
      },
    },
    take: 10000,
  });

  const percents: number[] = [];
  const bySubject = new Map<string, { sum: number; n: number; name: string }>();
  const byClass = new Map<string, { sum: number; n: number; name: string }>();
  const gradeCounts = new Map<string, number>();

  for (const m of marks) {
    const paper = m.examination.papers.find((p) => p.subjectId === m.subjectId);
    const max = paper?.maxMarks ?? 100;
    if (max <= 0) continue;
    const p = (Number(m.score) / max) * 100;
    percents.push(p);
    const grade = gradeLabelForPercent(p, bands);
    gradeCounts.set(grade, (gradeCounts.get(grade) ?? 0) + 1);

    const sk = m.subjectId;
    const sub = bySubject.get(sk) ?? { sum: 0, n: 0, name: m.subject.name };
    sub.sum += p;
    sub.n += 1;
    bySubject.set(sk, sub);

    const ck = m.examination.classId;
    const cls = byClass.get(ck) ?? {
      sum: 0,
      n: 0,
      name: m.examination.schoolClass.name,
    };
    cls.sum += p;
    cls.n += 1;
    byClass.set(ck, cls);
  }

  const avg = percents.length ? percents.reduce((a, b) => a + b, 0) / percents.length : null;
  const passRate = percents.length
    ? pct(percents.filter((p) => p >= passMin).length, percents.length)
    : null;

  return {
    kpis: [
      kpi("avgScore", "Average score", "Mean % from published exams.", avg !== null ? `${Math.round(avg * 10) / 10}%` : "—", avg),
      kpi("passRate", "Pass rate", "Marks at or above school pass threshold.", formatPct(passRate), passRate),
      kpi("exams", "Published exams", "Examinations in scope.", String(examIds.length), examIds.length),
      kpi("marks", "Marks recorded", "Valid mark entries.", String(percents.length), percents.length),
    ],
    charts: {
      bySubject: [...bySubject.values()].map((s) => ({
        subject: s.name,
        average: Math.round((s.sum / s.n) * 10) / 10,
      })),
      byClass: [...byClass.values()].map((c) => ({
        className: c.name,
        average: Math.round((c.sum / c.n) * 10) / 10,
      })),
      gradeDistribution: [...gradeCounts.entries()].map(([grade, count]) => ({ grade, count })),
    },
    tables: {
      subjectPerformance: [...bySubject.entries()].map(([id, s]) => ({
        subjectId: id,
        subject: s.name,
        average: Math.round((s.sum / s.n) * 10) / 10,
        marks: s.n,
        linkPath: `/dashboard/attendance-exams?tab=marks`,
      })),
    },
  };
}

function emptyAcademics() {
  return {
    kpis: [
      kpi("avgScore", "Average score", "No published marks in scope.", "—"),
      kpi("passRate", "Pass rate", "—", "—"),
      kpi("exams", "Published exams", "—", "0"),
      kpi("marks", "Marks recorded", "—", "0"),
    ],
    charts: { bySubject: [], byClass: [], gradeDistribution: [] },
    tables: { subjectPerformance: [] },
  };
}
