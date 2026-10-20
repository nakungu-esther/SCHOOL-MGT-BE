import { Router, type Response } from "express";
import { z } from "zod";
import { paramId } from "../lib/academics-scope";
import { triggerAnnouncementPublished } from "../lib/notifications/triggers";
import { createNotification } from "../lib/notifications/notification.service";
import { getGradeBands, gradeLabelForPercent } from "../lib/grading";
import {
  announcementVisibleToRole,
  userCanAccessStudentRecord,
} from "../lib/portal-access";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { Role } from "@prisma/client";

export const portalRouter = Router();

function requireFamilyRole(req: AuthedRequest, res: Response): Role | null {
  const role = req.auth!.role;
  if (
    role !== "PARENT" &&
    role !== "STUDENT" &&
    role !== "SCHOOL_ADMIN"
  ) {
    res.status(403).json({ error: "Portal access only for family roles" });
    return null;
  }
  return role;
}

const linkBody = z.object({
  userId: z.uuid(),
  studentId: z.uuid(),
  linkType: z.enum(["PARENT", "STUDENT"]),
});

portalRouter.post(
  "/links",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const parsed = linkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid link payload" });
      return;
    }

    const { userId, studentId, linkType } = parsed.data;

    const [student, membership] = await Promise.all([
      prisma.student.findFirst({ where: { id: studentId, schoolId } }),
      prisma.membership.findUnique({
        where: { schoolId_userId: { schoolId, userId } },
      }),
    ]);

    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    if (!membership) {
      res.status(400).json({ error: "User is not a member of this school" });
      return;
    }

    const expectedRole: Role = linkType === "PARENT" ? "PARENT" : "STUDENT";
    if (membership.role !== expectedRole) {
      res.status(400).json({
        error: `User membership role must be ${expectedRole} for this link type`,
      });
      return;
    }

    const link = await prisma.studentPortalLink.upsert({
      where: {
        schoolId_userId_studentId: { schoolId, userId, studentId },
      },
      create: { schoolId, userId, studentId, linkType },
      update: { linkType },
      include: {
        student: { select: { id: true, fullName: true, admissionNo: true } },
        user: { select: { id: true, email: true } },
      },
    });

    res.status(201).json({
      id: link.id,
      linkType: link.linkType,
      student: link.student,
      user: link.user,
    });
  },
);

portalRouter.get(
  "/students",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const role = req.auth!.role;
    if (role !== "PARENT" && role !== "STUDENT") {
      res.status(403).json({ error: "Only parents and students may list portal students" });
      return;
    }

    const links = await prisma.studentPortalLink.findMany({
      where: { schoolId, userId: req.auth!.user.id },
      include: {
        student: {
          select: {
            id: true,
            fullName: true,
            admissionNo: true,
            className: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      items: links.map((l) => ({
        linkId: l.id,
        linkType: l.linkType,
        ...l.student,
      })),
    });
  },
);

async function buildStudentOverview(schoolId: string, studentId: string) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
  });
  if (!student) return null;

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const [attendanceRecords, invoices, exams, bands] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { schoolId, studentId, recordDate: { gte: since } },
      orderBy: { recordDate: "desc" },
      take: 14,
    }),
    prisma.invoice.findMany({
      where: { schoolId, studentId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.examination.findMany({
      where: {
        schoolId,
        published: true,
        schoolClass: { name: student.className },
      },
      include: {
        schoolClass: true,
        academicYear: true,
        papers: { include: { subject: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    getGradeBands(schoolId),
  ]);

  let presentLike = 0;
  for (const r of attendanceRecords) {
    if (r.status === "PRESENT" || r.status === "LATE" || r.status === "EXCUSED") {
      presentLike += 1;
    }
  }
  const attendancePercent =
    attendanceRecords.length > 0
      ? Math.round((presentLike / attendanceRecords.length) * 100)
      : null;

  const examIds = exams.map((e) => e.id);
  const marks =
    examIds.length > 0
      ? await prisma.examMark.findMany({
          where: { schoolId, studentId, examinationId: { in: examIds } },
        })
      : [];
  const marksByExam = new Map<string, Map<string, number>>();
  for (const m of marks) {
    let sub = marksByExam.get(m.examinationId);
    if (!sub) {
      sub = new Map();
      marksByExam.set(m.examinationId, sub);
    }
    sub.set(m.subjectId, Number(m.score));
  }

  const examinationSummaries = exams.map((exam) => {
    const markBySubject = marksByExam.get(exam.id) ?? new Map();
    let totalScore = 0;
    let totalMax = 0;
    const subjects = exam.papers.map((p) => {
      const score = markBySubject.get(p.subjectId) ?? null;
      const percent =
        score !== null && p.maxMarks > 0 ? (score / p.maxMarks) * 100 : null;
      if (score !== null) {
        totalScore += score;
        totalMax += p.maxMarks;
      }
      return {
        subjectId: p.subjectId,
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
    return {
      id: exam.id,
      name: exam.name,
      term: exam.term,
      academicYear: exam.academicYear.name,
      className: exam.schoolClass.name,
      subjects,
      summary: {
        totalScore,
        totalMax,
        overallPercent,
        overallGrade:
          overallPercent !== null
            ? gradeLabelForPercent(overallPercent, bands)
            : null,
      },
    };
  });

  let feesOutstanding = 0;
  const invoiceRows = invoices.map((inv) => {
    const total = Number(inv.amountTotal);
    const paid = Number(inv.amountPaid);
    const balance = Math.max(0, total - paid);
    if (inv.status !== "VOID" && inv.status !== "PAID") {
      feesOutstanding += balance;
    }
    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      status: inv.status,
      amountTotal: total,
      amountPaid: paid,
      balance,
      dueDate: inv.dueDate,
    };
  });

  return {
    student: {
      id: student.id,
      fullName: student.fullName,
      admissionNo: student.admissionNo,
      className: student.className,
      status: student.status,
    },
    attendance: {
      recentDays: attendanceRecords.length,
      percentLast30: attendancePercent,
      recent: attendanceRecords.map((r) => ({
        date: r.recordDate,
        status: r.status,
      })),
    },
    examinations: examinationSummaries,
    fees: {
      outstanding: feesOutstanding,
      invoices: invoiceRows,
    },
  };
}

portalRouter.get(
  "/students/:studentId/overview",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const studentId = paramId(req.params.studentId);
    const allowed = await userCanAccessStudentRecord({
      schoolId,
      userId: req.auth!.user.id,
      membershipRole: req.auth!.role,
      studentId,
    });
    if (!allowed) {
      res.status(403).json({ error: "Not authorized for this student" });
      return;
    }

    const overview = await buildStudentOverview(schoolId, studentId);
    if (!overview) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    res.json(overview);
  },
);

portalRouter.get(
  "/students/:studentId/report-card",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const studentId = paramId(req.params.studentId);
    const examinationId = String(req.query.examinationId ?? "");
    if (!examinationId) {
      res.status(400).json({ error: "examinationId required" });
      return;
    }

    const allowed = await userCanAccessStudentRecord({
      schoolId,
      userId: req.auth!.user.id,
      membershipRole: req.auth!.role,
      studentId,
    });
    if (!allowed) {
      res.status(403).json({ error: "Not authorized for this student" });
      return;
    }

    const student = await prisma.student.findFirst({
      where: { id: studentId, schoolId },
    });
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    const exam = await prisma.examination.findFirst({
      where: { id: examinationId, schoolId, published: true },
      include: {
        schoolClass: true,
        academicYear: true,
        papers: { include: { subject: true } },
      },
    });
    if (!exam) {
      res.status(404).json({ error: "Published examination not found" });
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

portalRouter.get(
  "/announcements",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const role = requireFamilyRole(req, res);
    if (!role) return;

    const items = await prisma.announcement.findMany({
      where: { schoolId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json({
      items: items
        .filter((a) => announcementVisibleToRole(a.audience, role))
        .map((a) => ({
          id: a.id,
          audience: a.audience,
          title: a.title,
          body: a.body,
          createdAt: a.createdAt,
        })),
    });
  },
);

const announcementBody = z.object({
  audience: z.enum(["ALL", "PARENT", "STUDENT"]),
  title: z.string().min(2).max(200),
  body: z.string().min(1).max(5000),
});

portalRouter.post(
  "/announcements",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const parsed = announcementBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid announcement" });
      return;
    }

    const row = await prisma.announcement.create({
      data: { schoolId, ...parsed.data },
    });

    void triggerAnnouncementPublished({
      schoolId,
      announcementId: row.id,
      audience: row.audience,
      title: row.title,
    });

    res.status(201).json({
      id: row.id,
      audience: row.audience,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt,
    });
  },
);

portalRouter.get(
  "/notifications",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const role = req.auth!.role;
    if (role !== "PARENT" && role !== "STUDENT") {
      res.status(403).json({ error: "Notifications are for parents and students" });
      return;
    }

    const items = await prisma.portalNotification.findMany({
      where: { schoolId, userId: req.auth!.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json({
      items: items.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    });
  },
);

portalRouter.patch(
  "/notifications/:id/read",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const id = paramId(req.params.id);
    const note = await prisma.portalNotification.findFirst({
      where: { id, schoolId, userId: req.auth!.user.id },
    });
    if (!note) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const updated = await prisma.portalNotification.update({
      where: { id },
      data: { readAt: note.readAt ?? new Date() },
    });

    res.json({
      id: updated.id,
      readAt: updated.readAt,
    });
  },
);

const notificationBody = z.object({
  userId: z.uuid(),
  title: z.string().min(2).max(200),
  body: z.string().min(1).max(2000),
});

portalRouter.post(
  "/notifications",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const parsed = notificationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid notification" });
      return;
    }

    const membership = await prisma.membership.findUnique({
      where: {
        schoolId_userId: { schoolId, userId: parsed.data.userId },
      },
    });
    if (!membership) {
      res.status(400).json({ error: "User is not a member of this school" });
      return;
    }
    if (membership.role !== "PARENT" && membership.role !== "STUDENT") {
      res.status(400).json({
        error: "Notifications may only be sent to parents or students",
      });
      return;
    }

    const result = await createNotification({
      schoolId,
      userId: parsed.data.userId,
      category: "SYSTEM",
      type: "MANUAL",
      title: parsed.data.title,
      message: parsed.data.body,
      idempotencyKey: `portal-manual:${parsed.data.userId}:${Date.now()}`,
    });

    res.status(result.created ? 201 : 200).json(result);
  },
);

portalRouter.get(
  "/links",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const items = await prisma.studentPortalLink.findMany({
      where: { schoolId },
      include: {
        student: { select: { id: true, fullName: true, admissionNo: true } },
        user: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      items: items.map((l) => ({
        id: l.id,
        linkType: l.linkType,
        student: l.student,
        user: l.user,
        createdAt: l.createdAt,
      })),
    });
  },
);
