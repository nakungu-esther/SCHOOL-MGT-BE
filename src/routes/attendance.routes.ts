import { Router } from "express";
import { z } from "zod";
import { paramId } from "../lib/academics-scope";
import { triggerAttendanceStatus } from "../lib/notifications/triggers";
import { prisma } from "../lib/prisma";
import { teacherCanManageClass } from "../lib/teacher-access";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const statusEnum = z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED"]);

export const attendanceRouter = Router();

async function studentsForRegister(
  schoolId: string,
  opts: { classId?: string; academicYearId?: string; className?: string },
) {
  if (opts.classId && opts.academicYearId) {
    const enrollments = await prisma.studentEnrollment.findMany({
      where: {
        schoolId,
        classId: opts.classId,
        academicYearId: opts.academicYearId,
        active: true,
        student: { status: "ACTIVE" },
      },
      include: { student: true },
      orderBy: { student: { fullName: "asc" } },
    });
    const schoolClass = await prisma.schoolClass.findUnique({
      where: { id: opts.classId },
    });
    return {
      className: schoolClass?.name ?? "",
      students: enrollments.map((e) => e.student),
    };
  }

  if (opts.className) {
    const students = await prisma.student.findMany({
      where: { schoolId, className: opts.className, status: "ACTIVE" },
      orderBy: { fullName: "asc" },
    });
    return { className: opts.className, students };
  }

  return { className: "", students: [] };
}

attendanceRouter.get(
  "/register",
  requireAuth,
  requirePermission("attendance.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const date = String(req.query.date ?? "");
    const className = String(req.query.className ?? "").trim();
    const classId = String(req.query.classId ?? "").trim();
    const academicYearId = String(req.query.academicYearId ?? "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "Valid date required" });
      return;
    }

    if (classId && academicYearId) {
      const allowed = await teacherCanManageClass(
        req,
        classId,
        academicYearId,
      );
      if (req.auth!.role === "TEACHER" && !allowed) {
        res.status(403).json({ error: "Not assigned to this class" });
        return;
      }
    }

    const { className: resolvedName, students } = await studentsForRegister(
      schoolId,
      {
        classId: classId || undefined,
        academicYearId: academicYearId || undefined,
        className: className || undefined,
      },
    );

    if (!resolvedName) {
      res.status(400).json({ error: "className or classId+academicYearId required" });
      return;
    }

    const records = await prisma.attendanceRecord.findMany({
      where: {
        schoolId,
        recordDate: new Date(date),
        className: resolvedName,
      },
    });
    const byStudent = new Map(records.map((r) => [r.studentId, r.status]));

    res.json({
      date,
      className: resolvedName,
      classId: classId || null,
      academicYearId: academicYearId || null,
      students: students.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        admissionNo: s.admissionNo,
        status: byStudent.get(s.id) ?? null,
      })),
    });
  },
);

const saveSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  className: z.string().min(1).max(80).optional(),
  classId: z.uuid().optional(),
  academicYearId: z.uuid().optional(),
  entries: z.array(
    z.object({
      studentId: z.uuid(),
      status: statusEnum,
    }),
  ),
});

attendanceRouter.post(
  "/register",
  requireAuth,
  requirePermission("attendance.manage"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid attendance payload" });
      return;
    }

    const { date, entries } = parsed.data;
    const recordDate = new Date(date);

    const { className: resolvedName, students } = await studentsForRegister(
      schoolId,
      {
        classId: parsed.data.classId,
        academicYearId: parsed.data.academicYearId,
        className: parsed.data.className,
      },
    );

    if (!resolvedName) {
      res.status(400).json({ error: "Could not resolve class" });
      return;
    }

    if (parsed.data.classId && parsed.data.academicYearId) {
      const allowed = await teacherCanManageClass(
        req,
        parsed.data.classId,
        parsed.data.academicYearId,
      );
      if (req.auth!.role === "TEACHER" && !allowed) {
        res.status(403).json({ error: "Not assigned to this class" });
        return;
      }
    }

    const studentIds = new Set(students.map((s) => s.id));
    for (const entry of entries) {
      if (!studentIds.has(entry.studentId)) {
        res.status(400).json({ error: "Student not enrolled in this class" });
        return;
      }
    }

    await prisma.$transaction(
      entries.map((entry) =>
        prisma.attendanceRecord.upsert({
          where: {
            schoolId_studentId_recordDate: {
              schoolId,
              studentId: entry.studentId,
              recordDate,
            },
          },
          create: {
            schoolId,
            studentId: entry.studentId,
            recordDate,
            className: resolvedName,
            status: entry.status,
          },
          update: { status: entry.status, className: resolvedName },
        }),
      ),
    );

    const nameById = new Map(students.map((s) => [s.id, s.fullName]));
    const dateIso = recordDate.toISOString();
    for (const entry of entries) {
      if (entry.status === "ABSENT" || entry.status === "LATE") {
        void triggerAttendanceStatus({
          schoolId,
          studentId: entry.studentId,
          studentName: nameById.get(entry.studentId) ?? "Student",
          recordDate: dateIso,
          status: entry.status,
        });
      }
    }

    res.json({ ok: true, saved: entries.length });
  },
);

attendanceRouter.get(
  "/analytics",
  requireAuth,
  requirePermission("attendance.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    const className = String(req.query.className ?? "").trim();

    const where = {
      schoolId,
      ...(className ? { className } : {}),
      ...(from && to
        ? {
            recordDate: {
              gte: new Date(from),
              lte: new Date(to),
            },
          }
        : {}),
    };

    const records = await prisma.attendanceRecord.findMany({ where });
    const total = records.length;
    const counts = {
      PRESENT: 0,
      ABSENT: 0,
      LATE: 0,
      EXCUSED: 0,
    };
    for (const r of records) {
      counts[r.status] += 1;
    }

    res.json({
      totalRecords: total,
      rates: {
        present: total ? counts.PRESENT / total : 0,
        absent: total ? counts.ABSENT / total : 0,
        late: total ? counts.LATE / total : 0,
        excused: total ? counts.EXCUSED / total : 0,
      },
      counts,
    });
  },
);

attendanceRouter.get(
  "/class-name/:classId",
  requireAuth,
  requirePermission("attendance.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const row = await prisma.schoolClass.findFirst({
      where: { id: paramId(req.params.classId), schoolId },
    });
    if (!row) {
      res.status(404).json({ error: "Class not found" });
      return;
    }
    res.json({ className: row.name, classId: row.id, academicYearId: row.academicYearId });
  },
);
