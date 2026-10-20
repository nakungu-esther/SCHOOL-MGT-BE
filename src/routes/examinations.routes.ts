import { Router } from "express";
import { z } from "zod";
import {
  assertClassInSchool,
  assertYearInSchool,
  paramId,
} from "../lib/academics-scope";
import { triggerExamPublished } from "../lib/notifications/triggers";
import { prisma } from "../lib/prisma";
import { teacherCanManageSubjectOnClass } from "../lib/teacher-access";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission, requireRole } from "../middleware/rbac";

export const examinationsRouter = Router();

const read = [requireAuth, requirePermission("assessment.view")] as const;
const write = [requireAuth, requirePermission("assessment.manage")] as const;
const publish = [requireAuth, requireRole("SCHOOL_ADMIN")] as const;

examinationsRouter.get("/", ...read, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const items = await prisma.examination.findMany({
    where: { schoolId },
    include: {
      schoolClass: { select: { name: true } },
      academicYear: { select: { name: true } },
      papers: { include: { subject: { select: { code: true, name: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    items: items.map((e) => ({
      id: e.id,
      name: e.name,
      term: e.term,
      published: e.published,
      classId: e.classId,
      className: e.schoolClass.name,
      academicYearId: e.academicYearId,
      academicYearName: e.academicYear.name,
      subjects: e.papers.map((p) => ({
        subjectId: p.subjectId,
        code: p.subject.code,
        name: p.subject.name,
        maxMarks: p.maxMarks,
      })),
    })),
  });
});

const examBody = z.object({
  name: z.string().min(2).max(120),
  term: z.string().min(1).max(32),
  academicYearId: z.uuid(),
  classId: z.uuid(),
  subjects: z
    .array(
      z.object({
        subjectId: z.uuid(),
        maxMarks: z.number().int().positive().max(1000),
      }),
    )
    .min(1),
});

examinationsRouter.post("/", ...write, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = examBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid examination data" });
    return;
  }
  if (!(await assertYearInSchool(schoolId, parsed.data.academicYearId))) {
    res.status(400).json({ error: "Invalid academic year" });
    return;
  }
  if (!(await assertClassInSchool(schoolId, parsed.data.classId))) {
    res.status(400).json({ error: "Invalid class" });
    return;
  }

  for (const s of parsed.data.subjects) {
    const sub = await prisma.subject.findFirst({
      where: { id: s.subjectId, schoolId },
    });
    if (!sub) {
      res.status(400).json({ error: "Subject not in school" });
      return;
    }
  }

  const exam = await prisma.$transaction(async (tx) => {
    const row = await tx.examination.create({
      data: {
        schoolId,
        name: parsed.data.name.trim(),
        term: parsed.data.term.trim(),
        academicYearId: parsed.data.academicYearId,
        classId: parsed.data.classId,
      },
    });
    await tx.examPaper.createMany({
      data: parsed.data.subjects.map((s) => ({
        examinationId: row.id,
        subjectId: s.subjectId,
        maxMarks: s.maxMarks,
      })),
    });
    return row;
  });

  res.status(201).json({ id: exam.id });
});

examinationsRouter.put("/:id", ...write, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = examBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid examination data" });
    return;
  }

  const existing = await prisma.examination.findFirst({
    where: { id: paramId(req.params.id), schoolId },
  });
  if (!existing) {
    res.status(404).json({ error: "Examination not found" });
    return;
  }
  if (existing.published) {
    res.status(403).json({ error: "Published examinations cannot be edited" });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.examination.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name.trim(),
        term: parsed.data.term.trim(),
        academicYearId: parsed.data.academicYearId,
        classId: parsed.data.classId,
      },
    });
    await tx.examPaper.deleteMany({ where: { examinationId: existing.id } });
    await tx.examPaper.createMany({
      data: parsed.data.subjects.map((s) => ({
        examinationId: existing.id,
        subjectId: s.subjectId,
        maxMarks: s.maxMarks,
      })),
    });
  });

  res.json({ ok: true });
});

examinationsRouter.post(
  "/:id/publish",
  ...publish,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const existing = await prisma.examination.findFirst({
      where: { id: paramId(req.params.id), schoolId },
      include: { schoolClass: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Examination not found" });
      return;
    }
    await prisma.examination.update({
      where: { id: existing.id },
      data: { published: true },
    });
    void triggerExamPublished({
      schoolId,
      examinationId: existing.id,
      examName: existing.name,
      className: existing.schoolClass.name,
    });
    res.json({ ok: true, published: true });
  },
);

examinationsRouter.get(
  "/:id/marks",
  ...read,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const exam = await prisma.examination.findFirst({
      where: { id: paramId(req.params.id), schoolId },
      include: {
        schoolClass: true,
        papers: { include: { subject: true } },
      },
    });
    if (!exam) {
      res.status(404).json({ error: "Examination not found" });
      return;
    }

    const className = exam.schoolClass.name;
    const enrollments = await prisma.studentEnrollment.findMany({
      where: {
        schoolId,
        classId: exam.classId,
        academicYearId: exam.academicYearId,
        active: true,
        student: { status: "ACTIVE" },
      },
      include: { student: true },
    });
    const students =
      enrollments.length > 0
        ? enrollments.map((e) => e.student)
        : await prisma.student.findMany({
            where: { schoolId, className, status: "ACTIVE" },
            orderBy: { fullName: "asc" },
          });

    const marks = await prisma.examMark.findMany({
      where: { examinationId: exam.id, schoolId },
    });
    const key = (sid: string, sub: string) => `${sid}:${sub}`;
    const markMap = new Map(
      marks.map((m) => [key(m.studentId, m.subjectId), Number(m.score)]),
    );

    res.json({
      examinationId: exam.id,
      published: exam.published,
      className,
      subjects: exam.papers.map((p) => ({
        subjectId: p.subjectId,
        code: p.subject.code,
        maxMarks: p.maxMarks,
      })),
      students: students.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        admissionNo: s.admissionNo,
        scores: exam.papers.map((p) => ({
          subjectId: p.subjectId,
          score: markMap.get(key(s.id, p.subjectId)) ?? null,
        })),
      })),
    });
  },
);

const marksBody = z.object({
  marks: z.array(
    z.object({
      studentId: z.uuid(),
      subjectId: z.uuid(),
      score: z.number().min(0),
    }),
  ),
});

examinationsRouter.put(
  "/:id/marks",
  ...write,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const exam = await prisma.examination.findFirst({
      where: { id: paramId(req.params.id), schoolId },
      include: { papers: true, schoolClass: true },
    });
    if (!exam) {
      res.status(404).json({ error: "Examination not found" });
      return;
    }
    if (exam.published) {
      res.status(403).json({
        error: "Marks cannot be changed after the examination is published",
      });
      return;
    }

    const parsed = marksBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid marks payload" });
      return;
    }

    const maxBySubject = new Map(
      exam.papers.map((p) => [p.subjectId, p.maxMarks]),
    );

    for (const m of parsed.data.marks) {
      const max = maxBySubject.get(m.subjectId);
      if (max === undefined) {
        res.status(400).json({ error: "Subject not part of examination" });
        return;
      }
      if (m.score > max) {
        res.status(400).json({
          error: `Score exceeds maximum (${max}) for subject`,
        });
        return;
      }

      const enrolled = await prisma.studentEnrollment.findFirst({
        where: {
          schoolId,
          studentId: m.studentId,
          classId: exam.classId,
          academicYearId: exam.academicYearId,
          active: true,
        },
      });
      const legacyStudent = enrolled
        ? null
        : await prisma.student.findFirst({
            where: {
              id: m.studentId,
              schoolId,
              className: exam.schoolClass.name,
            },
          });
      if (!enrolled && !legacyStudent) {
        res.status(400).json({ error: "Student not in examination class" });
        return;
      }

      const canTeach = await teacherCanManageSubjectOnClass(
        req,
        exam.classId,
        m.subjectId,
        exam.academicYearId,
      );
      if (req.auth!.role === "TEACHER" && !canTeach) {
        res.status(403).json({ error: "Not assigned to this subject/class" });
        return;
      }
    }

    await prisma.$transaction(
      parsed.data.marks.map((m) =>
        prisma.examMark.upsert({
          where: {
            examinationId_studentId_subjectId: {
              examinationId: exam.id,
              studentId: m.studentId,
              subjectId: m.subjectId,
            },
          },
          create: {
            schoolId,
            examinationId: exam.id,
            studentId: m.studentId,
            subjectId: m.subjectId,
            score: m.score,
          },
          update: { score: m.score },
        }),
      ),
    );

    res.json({ ok: true, saved: parsed.data.marks.length });
  },
);
