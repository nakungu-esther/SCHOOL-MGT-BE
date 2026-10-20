import { Router } from "express";
import { z } from "zod";
import {
  triggerStudentAdmitted,
  triggerStudentClassChanged,
} from "../lib/notifications/triggers";
import { writeAuditLog } from "../lib/audit-log";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const genderEnum = z.enum(["MALE", "FEMALE", "OTHER"]);
const statusEnum = z.enum(["ACTIVE", "GRADUATED", "TRANSFERRED", "INACTIVE"]);

const studentBodySchema = z.object({
  admissionNo: z.string().min(2).max(40),
  fullName: z.string().min(2).max(255),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: genderEnum,
  className: z.string().min(1).max(80),
  guardianName: z.string().min(2).max(255),
  guardianPhone: z.string().max(40).optional(),
  guardianEmail: z.email().optional(),
  status: statusEnum.optional(),
});

export const studentsRouter = Router();

function paramId(raw: string | string[]): string {
  return Array.isArray(raw) ? raw[0] : raw;
}

studentsRouter.get(
  "/",
  requireAuth,
  requirePermission("students.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const search = String(req.query.search ?? "").trim();
    const status = req.query.status
      ? statusEnum.safeParse(req.query.status)
      : null;
    const className = String(req.query.className ?? "").trim();

    const where = {
      schoolId,
      ...(status?.success ? { status: status.data } : {}),
      ...(className ? { className } : {}),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: "insensitive" as const } },
              { admissionNo: { contains: search, mode: "insensitive" as const } },
              { guardianName: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.student.count({ where }),
      prisma.student.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      items: items.map(serializeStudent),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  },
);

studentsRouter.get(
  "/:id",
  requireAuth,
  requirePermission("students.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const student = await prisma.student.findFirst({
      where: { id: paramId(req.params.id), schoolId },
    });
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    res.json(serializeStudent(student));
  },
);

studentsRouter.post(
  "/",
  requireAuth,
  requirePermission("students.manage"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const parsed = studentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid student data",
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const student = await prisma.student.create({
        data: {
          schoolId,
          admissionNo: parsed.data.admissionNo.trim(),
          fullName: parsed.data.fullName.trim(),
          dateOfBirth: new Date(parsed.data.dateOfBirth),
          gender: parsed.data.gender,
          className: parsed.data.className.trim(),
          guardianName: parsed.data.guardianName.trim(),
          guardianPhone: parsed.data.guardianPhone?.trim(),
          guardianEmail: parsed.data.guardianEmail?.trim().toLowerCase(),
          status: parsed.data.status ?? "ACTIVE",
        },
      });
      void triggerStudentAdmitted({
        schoolId,
        studentId: student.id,
        fullName: student.fullName,
        className: student.className,
      });
      void writeAuditLog({
        schoolId,
        userId: req.auth!.user.id,
        action: "STUDENT_CREATED",
        detail: { studentId: student.id, admissionNo: student.admissionNo },
      });
      res.status(201).json(serializeStudent(student));
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        res.status(409).json({ error: "Admission number already exists" });
        return;
      }
      throw err;
    }
  },
);

studentsRouter.put(
  "/:id",
  requireAuth,
  requirePermission("students.manage"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const parsed = studentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid student data",
        details: parsed.error.flatten(),
      });
      return;
    }

    const existing = await prisma.student.findFirst({
      where: { id: paramId(req.params.id), schoolId },
    });
    if (!existing) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    try {
      const student = await prisma.student.update({
        where: { id: existing.id },
        data: {
          admissionNo: parsed.data.admissionNo.trim(),
          fullName: parsed.data.fullName.trim(),
          dateOfBirth: new Date(parsed.data.dateOfBirth),
          gender: parsed.data.gender,
          className: parsed.data.className.trim(),
          guardianName: parsed.data.guardianName.trim(),
          guardianPhone: parsed.data.guardianPhone?.trim(),
          guardianEmail: parsed.data.guardianEmail?.trim().toLowerCase(),
          status: parsed.data.status ?? existing.status,
        },
      });
      void triggerStudentClassChanged({
        schoolId,
        studentId: student.id,
        fullName: student.fullName,
        previousClass: existing.className,
        newClass: student.className,
        statusChanged: existing.status !== student.status,
        newStatus: student.status,
      });
      void writeAuditLog({
        schoolId,
        userId: req.auth!.user.id,
        action: "STUDENT_UPDATED",
        detail: { studentId: student.id, admissionNo: student.admissionNo },
      });
      res.json(serializeStudent(student));
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        res.status(409).json({ error: "Admission number already exists" });
        return;
      }
      throw err;
    }
  },
);

studentsRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("students.manage"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const existing = await prisma.student.findFirst({
      where: { id: paramId(req.params.id), schoolId },
    });
    if (!existing) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    await prisma.student.delete({ where: { id: existing.id } });
    void writeAuditLog({
      schoolId,
      userId: req.auth!.user.id,
      action: "STUDENT_DELETED",
      detail: { studentId: existing.id, admissionNo: existing.admissionNo },
    });
    res.json({ ok: true });
  },
);

function serializeStudent(student: {
  id: string;
  schoolId: string;
  admissionNo: string;
  fullName: string;
  dateOfBirth: Date;
  gender: string;
  className