import { Router } from "express";
import { z } from "zod";
import {
  assertClassInSchool,
  assertStaffInSchool,
  assertStreamInSchool,
  assertSubjectInSchool,
  assertYearInSchool,
  paramId,
} from "../lib/academics-scope";
import { triggerTeachingAssigned } from "../lib/notifications/triggers";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission, requireRole } from "../middleware/rbac";

const readAcademics = [requireAuth, requirePermission("classes.view")] as const;
const writeAdmin = [
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
] as const;

const staffKind = z.enum(["TEACHER", "ADMIN", "BURSAR", "SUPPORT"]);

export const academicsRouter = Router();

/** ---------- Staff ---------- */
academicsRouter.get("/staff", ...readAcademics, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const search = String(req.query.search ?? "").trim();
  const items = await prisma.staff.findMany({
    where: {
      schoolId,
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: "insensitive" } },
              { employeeId: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { fullName: "asc" },
  });
  res.json({ items: items.map(serializeStaff) });
});

const staffBody = z.object({
  employeeId: z.string().max(40).optional(),
  fullName: z.string().min(2).max(255),
  email: z.email().optional(),
  phone: z.string().max(40).optional(),
  jobTitle: z.string().max(120).optional(),
  department: z.string().max(120).optional(),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  kind: staffKind,
  active: z.boolean().optional(),
});

academicsRouter.post("/staff", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = staffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid staff data", details: parsed.error.flatten() });
    return;
  }
  try {
    const staff = await prisma.staff.create({
      data: {
        schoolId,
        employeeId: parsed.data.employeeId?.trim(),
        fullName: parsed.data.fullName.trim(),
        email: parsed.data.email?.trim().toLowerCase(),
        phone: parsed.data.phone?.trim(),
        jobTitle: parsed.data.jobTitle?.trim(),
        department: parsed.data.department?.trim(),
        hireDate: parsed.data.hireDate ? new Date(parsed.data.hireDate) : undefined,
        kind: parsed.data.kind,
        active: parsed.data.active ?? true,
      },
    });
    res.status(201).json(serializeStaff(staff));
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "Employee ID already exists" });
      return;
    }
    throw err;
  }
});

academicsRouter.put("/staff/:id", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = staffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid staff data" });
    return;
  }
  const existing = await prisma.staff.findFirst({
    where: { id: paramId(req.params.id), schoolId },
  });
  if (!existing) {
    res.status(404).json({ error: "Staff not found" });
    return;
  }
  const staff = await prisma.staff.update({
    where: { id: existing.id },
    data: {
      employeeId: parsed.data.employeeId?.trim(),
      fullName: parsed.data.fullName.trim(),
      email: parsed.data.email?.trim().toLowerCase(),
      phone: parsed.data.phone?.trim(),
      jobTitle: parsed.data.jobTitle?.trim(),
      department: parsed.data.department?.trim(),
      hireDate: parsed.data.hireDate ? new Date(parsed.data.hireDate) : null,
      kind: parsed.data.kind,
      active: parsed.data.active ?? existing.active,
    },
  });
  res.json(serializeStaff(staff));
});

/** ---------- Academic years ---------- */
academicsRouter.get("/years", ...readAcademics, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const items = await prisma.academicYear.findMany({
    where: { schoolId },
    orderBy: { startDate: "desc" },
  });
  res.json({ items: items.map(serializeYear) });
});

const yearBody = z.object({
  name: z.string().min(2).max(64),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isCurrent: z.boolean().optional(),
});

academicsRouter.post("/years", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = yearBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid year data" });
    return;
  }
  const year = await prisma.$transaction(async (tx) => {
    if (parsed.data.isCurrent) {
      await tx.academicYear.updateMany({
        where: { schoolId },
        data: { isCurrent: false },
      });
    }
    return tx.academicYear.create({
      data: {
        schoolId,
        name: parsed.data.name.trim(),
        startDate: new Date(parsed.data.startDate),
        endDate: new Date(parsed.data.endDate),
        isCurrent: parsed.data.isCurrent ?? false,
      },
    });
  });
  res.status(201).json(serializeYear(year));
});

academicsRouter.put("/years/:id", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = yearBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid year data" });
    return;
  }
  const existing = await prisma.academicYear.findFirst({
    where: { id: paramId(req.params.id), schoolId },
  });
  if (!existing) {
    res.status(404).json({ error: "Academic year not found" });
    return;
  }
  const year = await prisma.$transaction(async (tx) => {
    if (parsed.data.isCurrent) {
      await tx.academicYear.updateMany({
        where: { schoolId, id: { not: existing.id } },
        data: { isCurrent: false },
      });
    }
    return tx.academicYear.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name.trim(),
        startDate: new Date(parsed.data.startDate),
        endDate: new Date(parsed.data.endDate),
        isCurrent: parsed.data.isCurrent ?? existing.isCurrent,
      },
    });
  });
  res.json(serializeYear(year));
});

/** ---------- Classes ---------- */
academicsRouter.get("/classes", ...readAcademics, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const academicYearId = String(req.query.academicYearId ?? "").trim();
  const items = await prisma.schoolClass.findMany({
    where: {
      schoolId,
      ...(academicYearId ? { academicYearId } : {}),
    },
    include: { academicYear: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  res.json({
    items: items.map((c) => ({
      id: c.id,
      name: c.name,
      academicYearId: c.academicYearId,
      academicYearName: c.academicYear.name,
    })),
  });
});

const classBody = z.object({
  name: z.string().min(1).max(80),
  academicYearId: z.uuid(),
});

academicsRouter.post("/classes", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = classBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid class data" });
    return;
  }
  if (!(await assertYearInSchool(schoolId, parsed.data.academicYearId))) {
    res.status(400).json({ error: "Academic year not in this school" });
    return;
  }
  try {
    const row = await prisma.schoolClass.create({
      data: {
        schoolId,
        name: parsed.data.name.trim(),
        academicYearId: parsed.data.academicYearId,
      },
    });
    res.status(201).json(row);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "Class already exists for this year" });
      return;
    }
    throw err;
  }
});

academicsRouter.put("/classes/:id", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = classBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid class data" });
    return;
  }
  const existing = await prisma.schoolClass.findFirst({
    where: { id: paramId(req.params.id), schoolId },
  });
  if (!existing) {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  if (!(await assertYearInSchool(schoolId, parsed.data.academicYearId))) {
    res.status(400).json({ error: "Academic year not in this school" });
    return;
  }
  const row = await prisma.schoolClass.update({
    where: { id: existing.id },
    data: {
      name: parsed.data.name.trim(),
      academicYearId: parsed.data.academicYearId,
    },
  });
  res.json(row);
});

/** ---------- Streams ---------- */
academicsRouter.get("/streams", ...readAcademics, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const classId = String(req.query.classId ?? "").trim();
  const items = await prisma.stream.findMany({
    where: {
      schoolId,
      ...(classId ? { classId } : {}),
    },
    orderBy: { name: "asc" },
  });
  res.json({ items });
});

const streamBody = z.object({
  classId: z.uuid(),
  name: z.string().min(1).max(40),
  capacity: z.number().int().positive().optional(),
});

academicsRouter.post("/streams", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = streamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid stream data" });
    return;
  }
  if (!(await assertClassInSchool(schoolId, parsed.data.classId))) {
    res.status(400).json({ error: "Class not in this school" });
    return;
  }
  try {
    const row = await prisma.stream.create({
      data: {
        schoolId,
        classId: parsed.data.classId,
        name: parsed.data.name.trim(),
        capacity: parsed.data.capacity,
      },
    });
    res.status(201).json(row);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "Stream already exists" });
      return;
    }
    throw err;
  }
});

academicsRouter.put("/streams/:id", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = streamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid stream data" });
    return;
  }
  const existing = await prisma.stream.findFirst({
    where: { id: paramId(req.params.id), schoolId },
  });
  if (!existing) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }
  if (!(await assertClassInSchool(schoolId, parsed.data.classId))) {
    res.status(400).json({ error: "Class not in this school" });
    return;
  }
  const row = await prisma.stream.update({
    where: { id: existing.id },
    data: {
      classId: parsed.data.classId,
      name: parsed.data.name.trim(),
      capacity: parsed.data.capacity,
    },
  });
  res.json(row);
});

/** ---------- Subjects ---------- */
academicsRouter.get("/subjects", ...readAcademics, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const search = String(req.query.search ?? "").trim();
  const items = await prisma.subject.findMany({
    where: {
      schoolId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { code: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { code: "asc" },
  });
  res.json({ items });
});

const subjectBody = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(2).max(120),
  active: z.boolean().optional(),
});

academicsRouter.post("/subjects", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = subjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid subject data" });
    return;
  }
  try {
    const row = await prisma.subject.create({
      data: {
        schoolId,
        code: parsed.data.code.trim().toUpperCase(),
        name: parsed.data.name.trim(),
        active: parsed.data.active ?? true,
      },
    });
    res.status(201).json(row);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "Subject code already exists" });
      return;
    }
    throw err;
  }
});

academicsRouter.put("/subjects/:id", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = subjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid subject data" });
    return;
  }
  const existing = await prisma.subject.findFirst({
    where: { id: paramId(req.params.id), schoolId },
  });
  if (!existing) {
    res.status(404).json({ error: "Subject not found" });
    return;
  }
  const row = await prisma.subject.update({
    where: { id: existing.id },
    data: {
      code: parsed.data.code.trim().toUpperCase(),
      name: parsed.data.name.trim(),
      active: parsed.data.active ?? existing.active,
    },
  });
  res.json(row);
});

/** ---------- Teaching assignments ---------- */
academicsRouter.get("/assignments", ...readAcademics, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const academicYearId = String(req.query.academicYearId ?? "").trim();
  const items = await prisma.teachingAssignment.findMany({
    where: {
      schoolId,
      ...(academicYearId ? { academicYearId } : {}),
    },
    include: {
      staff: { select: { fullName: true, kind: true } },
      subject: { select: { code: true, name: true } },
      schoolClass: { select: { name: true } },
      stream: { select: { name: true } },
      academicYear: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    items: items.map((a) => ({
      id: a.id,
      staffId: a.staffId,
      staffName: a.staff.fullName,
      subjectId: a.subjectId,
      subjectCode: a.subject.code,
      subjectName: a.subject.name,
      classId: a.classId,
      className: a.schoolClass.name,
      streamId: a.streamId,
      streamName: a.stream?.name ?? null,
      academicYearId: a.academicYearId,
      academicYearName: a.academicYear.name,
    })),
  });
});

const assignmentBody = z.object({
  staffId: z.uuid(),
  subjectId: z.uuid(),
  classId: z.uuid(),
  streamId: z.uuid().nullable().optional(),
  academicYearId: z.uuid(),
});

academicsRouter.post("/assignments", ...writeAdmin, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = assignmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid assignment data" });
    return;
  }
  const { staffId, subjectId, classId, streamId, academicYearId } = parsed.data;
  if (!(await assertStaffInSchool(schoolId, staffId))) {
    res.status(400).json({ error: "Staff not in this school" });
    return;
  }
  if (!(await assertSubjectInSchool(schoolId, subjectId))) {
    res.status(400).json({ error: "Subject not in this school" });
    return;
  }
  if (!(await assertClassInSchool(schoolId, classId))) {
    res.status(400).json({ error: "Class not in this school" });
    return;
  }
  if (!(await assertYearInSchool(schoolId, academicYearId))) {
    res.status(400).json({ error: "Academic year not in this school" });
    return;
  }
  if (streamId && !(await assertStreamInSchool(schoolId, streamId))) {
    res.status(400).json({ error: "Stream not in this school" });
    return;
  }
  try {
    const row = await prisma.teachingAssignment.create({
      data: {
        schoolId,
        staffId,
        subjectId,
        classId,
        streamId: streamId ?? null,
        academicYearId,
      },
    });
    const meta = await prisma.teachingAssignment.findUnique({
      where: { id: row.id },
      include: {
        staff: { select: { userId: true } },
        subject: { select: { name: true } },
        schoolClass: { select: { name: true } },
      },
    });
    if (meta) {
      void triggerTeachingAssigned({
        schoolId,
        staffUserId: meta.staff.userId,
        subjectName: meta.subject.name,
        className: meta.schoolClass.name,
        assignmentId: row.id,
      });
    }
    res.status(201).json(row);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "Assignment already exists" });
      return;
    }
    throw err;
  }
});

academicsRouter.delete(
  "/assignments/:id",
  ...writeAdmin,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const existing = await prisma.teachingAssignment.findFirst({
      where: { id: paramId(req.params.id), schoolId },
    });
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    await prisma.teachingAssignment.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  },
);

function serializeStaff(s: {
  id: string;
  employeeId: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  department: string | null;
  hireDate: Date | null;
  kind: string;
  active: boolean;
  userId: string | null;
}) {
  return {
    id: s.id,
    employeeId: s.employeeId,
    fullName: s.fullName,
    email: s.email,
    phone: s.phone,
    jobTitle: s.jobTitle,
    department: s.department,
    hireDate: s.hireDate?.toISOString().slice(0, 10) ?? null,
    kind: s.kind,
    active: s.active,
    userId: s.userId,
  };
}

function serializeYear(y: {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
}) {
  return {
    id: y.id,
    name: y.name,
    startDate: y.startDate.toISOString().slice(0, 10),
    endDate: y.endDate.toISOString().slice(0, 10),
    isCurrent: y.isCurrent,
  };
}
