import { Router } from "express";
import type { Role } from "@prisma/client";
import { paramId } from "../lib/academics-scope";
import { writeAuditLog } from "../lib/audit-log";
import { getGradeBands, gradeLabelForPercent } from "../lib/grading";
import { prisma } from "../lib/prisma";
import {
  academicReportSummary,
  attendanceReportSummary,
  financeReportSummary,
} from "../lib/report-data";
import {
  academicSummaryToPdf,
  attendanceSummaryToPdf,
  financeSummaryToPdf,
} from "../lib/report-export-pdf";
import {
  academicSummaryToXlsx,
  attendanceSummaryToXlsx,
  financeSummaryToXlsx,
} from "../lib/report-export-xlsx";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

export const reportsRouter = Router();

const reportsRead = [requireAuth, requirePermission("reports.view")] as const;

function canViewFinanceReports(role: Role): boolean {
  return role === "SCHOOL_ADMIN" || role === "BURSAR";
}

type ReportKind = "academic" | "attendance" | "finance";

async function loadReport(kind: ReportKind, schoolId: string) {
  if (kind === "academic") return academicReportSummary(schoolId);
  if (kind === "attendance") return attendanceReportSummary(schoolId);
  return financeReportSummary(schoolId);
}

reportsRouter.get("/summary/academic", ...reportsRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  res.json(await academicReportSummary(schoolId));
});

reportsRouter.get("/summary/attendance", ...reportsRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  res.json(await attendanceReportSummary(schoolId));
});

reportsRouter.get("/summary/finance", ...reportsRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  if (!canViewFinanceReports(req.auth!.role)) {
    res.status(403).json({ error: "Financial reports require bursar or admin access" });
    return;
  }
  res.json(await financeReportSummary(schoolId));
});

reportsRouter.get("/export/:kind", ...reportsRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;

  const kind = String(req.params.kind) as ReportKind;
  if (!["academic", "attendance", "finance"].includes(kind)) {
    res.status(400).json({ error: "Unknown report kind" });
    return;
  }
  if (kind === "finance" && !canViewFinanceReports(req.auth!.role)) {
    res.status(403).json({ error: "Financial exports require bursar or admin access" });
    return;
  }

  const format = String(req.query.format ?? "xlsx").toLowerCase();
  if (format !== "xlsx" && format !== "pdf") {
    res.status(400).json({ error: "format must be xlsx or pdf" });
    return;
  }

  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { name: true },
  });
  const schoolName = school?.name ?? "School";

  const data = await loadReport(kind, schoolId);
  let buffer: Buffer;
  let contentType: string;
  let ext: string;

  if (format === "xlsx") {
    if (kind === "academic") {
      buffer = await academicSummaryToXlsx(
        data as Awaited<ReturnType<typeof academicReportSummary>>,
        schoolName,
      );
    } else if (kind === "attendance") {
      buffer = await attendanceSummaryToXlsx(
        data as Awaited<ReturnType<typeof attendanceReportSummary>>,
        schoolName,
      );
    } else {
      buffer = await financeSummaryToXlsx(
        data as Awaited<ReturnType<typeof financeReportSummary>>,
        schoolName,
      );
    }
    contentType =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    ext = "xlsx";
  } else {
    if (kind === "academic") {
      buffer = await academicSummaryToPdf(
        data as Awaited<ReturnType<typeof academicReportSummary>>,
        schoolName,
      );
    } else if (kind === "attendance") {
      buffer = await attendanceSummaryToPdf(
        data as Awaited<ReturnType<typeof attendanceReportSummary>>,
        schoolName,
      );
    } else {
      buffer = await financeSummaryToPdf(
        data as Awaited<ReturnType<typeof financeReportSummary>>,
        schoolName,
      );
    }
    contentType = "application/pdf";
    ext = "pdf";
  }

  await writeAuditLog({
    schoolId,
    userId: req.auth!.user.id,
    action: "REPORT_EXPORTED",
    detail: { kind, format },
  });

  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="edumanage-${kind}-report.${ext}"`,
  );
  res.send(buffer);
});

reportsRouter.get(
  "/students/:studentId/report-card",
  requireAuth,
  requirePermission("assessment.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const examinationId = String(req.query.examinationId ?? "");
    if (!examinationId) {
      res.status(400).json({ error: "examinationId required" });
      return;
    }

    const student = await prisma.student.findFirst({
      where: { id: paramId(req.params.studentId), schoolId },
    });
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    const exam = await prisma.examination.findFirst({
      where: { id: examinationId, schoolId },
      include: {
        schoolClass: true,
        academicYear: true,
        papers: { include: { subject: true } },
      },
    });
    if (!exam) {
      res.status(404).json({ error: "Examination not found" });
      return;
    }

    if (student.className !== exam.schoolClass.name) {
      res.status(400).json({
        error: "Student class does not match examination class",
      });
      return;
    }

    const marks = await prisma.examMark.findMany({
      where: { examinationId: exam.id, studentId: student.id, schoolId },
    });
    const markBySubject = new Map(marks.map((m) => [m.subjectId, Number(m.score)]));

    const bands = await getGradeBands(schoolId);
    let totalScore = 0;
    let totalMax = 0;

    const subjectRows = exam.papers.map((p) => {
      const score = markBySubject.get(p.subjectId) ?? null;
      const percent =
        score !== null && p.maxMarks > 0 ? (score / p.maxMarks) * 100 : null;
      if (score !== null) {
        totalScore += score;
        totalMax += p.maxMarks;
      }
      return {
        code: p.subject.code,
        name: p.subject.name,
        score,
        maxMarks: p.maxMarks,
        percent,
        grade: percent !== null ? gradeLabelForPercent(percent, bands) : null,
      };
    });

    const overallPercent =
      totalMax > 0 ? (totalScore / totalMax) * 100 : null;

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, motto: true },
    });

    res.json({
      school: { name: school?.name, motto: school?.motto },
      student: {
        id: student.id,
        fullName: student.fullName,
        admissionNo: student.admissionNo,
        className: student.className,
      },
      examination: {
        id: exam.id,
        name: exam.name,
        term: exam.term,
        academicYear: exam.academicYear.name,
        published: exam.published,
      },
      subjects: subjectRows,
      summary: {
        totalScore,
        totalMax,
        overallPercent,
        overallGrade:
          overallPercent !== null
            ? gradeLabelForPercent(overallPercent, bands)
            : null,
      },
    });
  },
);
