import { Router } from "express";
import { z } from "zod";
import {
  assertClassInSchool,
  assertStreamInSchool,
  assertYearInSchool,
} from "../lib/academics-scope";
import { triggerEnrollmentUpdated } from "../lib/notifications/triggers";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission, requireRole } from "../middleware/rbac";

export const enrollmentsRouter = Router();

enrollmentsRouter.get(
  "/",
  requireAuth,
  requirePermission("students.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const academicYearId = String(req.query.academicYearId ?? "").trim();
    const classId = String(req.query.classId ?? "").trim();

    const items = await prisma.studentEnrollment.findMany({
      where: {
        schoolId,
        ...(academicYearId ? { academicYearId } : {}),
        ...(classId ? { classId } : {}),
      },
      include: {
        student: { select: { fullName: true, admissionNo: true, className: true } },
        academicYear: { select: { name: true } },
        schoolClass: { select: { name: true } },
        stream: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    res.json({
      items: items.map((e) => ({
        id: e.id,
        studentId: e.studentId,
        studentName: e.student.fullName,
        admissionNo: e.student.admissionNo,
        academicYearId: e.academicYearId,
        academicYearName: e.academicYear.name,
        classId: e.classId,
        className: e.schoolClass.name,
        streamId: e.streamId,
        streamName: e.stream?.name ?? null,
        active: e.active,
      })),
    });
  },
);

const enrollBody = z.object({
  studentId: z.uuid(),
  academicYearId: z.uuid(),
  classId: z.uuid(),
  streamId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
});

enrollmentsRouter.post(
  "/",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const parsed = enrollBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid enrollment" });
      return;
    }

    const student = await prisma.student.findFirst({
      where: { id: parsed.data.studentId, schoolId },
    });
    if (!student) {
      res.status(404).json({ error: "Student not found" });
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
    if (
      parsed.data.streamId &&
      !(await assertStreamInSchool(schoolId, parsed.data.streamId))
    ) {
      res.status(400).json({ error: "Invalid stream" });
      return;
    }

    const schoolClass = await prisma.schoolClass.findUnique({
      where: { id: parsed.data.classId },
    });

    const enrollment = await prisma.$transaction(async (tx) => {
      const row = await tx.studentEnrollment.upsert({
        where: {
          schoolId_studentId_academicYearId: {
            schoolId,
            studentId: parsed.data.studentId,
            academicYearId: parsed.data.academicYearId,
          },
        },
        create: {
          schoolId,
          studentId: parsed.data.studentId,
          academicYearId: parsed.data.academicYearId,
          classId: parsed.data.classId,
          streamId: parsed.data.streamId ?? null,
          active: parsed.data.active ?? true,
        },
        update: {
          classId: parsed.data.classId,
          streamId: parsed.data.streamId ?? null,
          active: parsed.data.active ?? true,
        },
      });

      if (schoolClass) {
        let classLabel = schoolClass.name;
        if (parsed.data.streamId) {
          const stream = await tx.stream.findUnique({
            where: { id: parsed.data.streamId },
          });
          if (stream) classLabel = `${schoolClass.name}-${stream.name}`;
        }
        await tx.student.update({
          where: { id: parsed.data.studentId },
          data: { className: classLabel },
        });
      }
      return row;
    });

    void triggerEnrollmentUpdated({
      schoolId,
      studentId: student.id,
      studentName: student.fullName,
    });

    res.status(201).json({ id: enrollment.id });
  },
);

const teacherLinkBody = z.object({
  staffId: z.uuid(),
  userId: z.uuid(),
});

enrollmentsRouter.put(
  "/teacher-link",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const parsed = teacherLinkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid link payload" });
      return;
    }

    const staff = await prisma.staff.findFirst({
      where: { id: parsed.data.staffId, schoolId },
    });
    if (!staff) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }

    const membership = await prisma.membership.findUnique({
      where: {
        schoolId_userId: { schoolId, userId: parsed.data.userId },
      },
    });
    if (!membership || membership.role !== "TEACHER") {
      res.status(400).json({ error: "User must be a teacher in this school" });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.staff.updateMany({
        where: { schoolId, userId: parsed.data.userId, id: { not: staff.id } },
        data: { userId: null },
      });
      await tx.staff.update({
        where: { id: staff.id },
        data: { userId: parsed.data.userId },
      });
    });

    res.json({ ok: true, staffId: staff.id, userId: parsed.data.userId });
  },
);
