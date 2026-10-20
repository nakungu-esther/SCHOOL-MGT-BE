import { Router } from "express";
import { z } from "zod";
import { paramId } from "../lib/academics-scope";
import { writeAuditLog } from "../lib/audit-log";
import {
  triggerInvoiceIssued,
  triggerPaymentRecorded,
} from "../lib/notifications/triggers";
import { refreshInvoiceTotals } from "../lib/invoice-status";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission, requireRole } from "../middleware/rbac";

export const financeRouter = Router();

const financeRead = [requireAuth, requirePermission("finance.view")] as const;
const financeWrite = [requireAuth, requirePermission("finance.manage")] as const;

financeRouter.get("/summary", ...financeRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;

  const [invoices, paymentsByMethod] = await Promise.all([
    prisma.invoice.findMany({ where: { schoolId } }),
    prisma.invoicePayment.groupBy({
      by: ["method"],
      where: { schoolId },
      _sum: { amount: true },
      _count: { id: true },
    }),
  ]);

  let billed = 0;
  let paid = 0;
  let outstanding = 0;
  for (const inv of invoices) {
    const t = Number(inv.amountTotal);
    const p = Number(inv.amountPaid);
    billed += t;
    paid += p;
    outstanding += Math.max(0, t - p);
  }

  res.json({
    collections: paid,
    billed,
    outstanding,
    invoiceCount: invoices.length,
    openInvoices: invoices.filter((i) => i.status === "OPEN" || i.status === "PARTIAL").length,
    byMethod: paymentsByMethod.map((m) => ({
      method: m.method,
      total: Number(m._sum.amount ?? 0),
      count: m._count.id,
    })),
  });
});

financeRouter.get("/structures", ...financeRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const items = await prisma.feeStructure.findMany({
    where: { schoolId },
    include: {
      academicYear: { select: { name: true } },
      schoolClass: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    items: items.map((f) => ({
      id: f.id,
      name: f.name,
      term: f.term,
      amount: Number(f.amount),
      active: f.active,
      academicYearId: f.academicYearId,
      academicYearName: f.academicYear.name,
      classId: f.classId,
      className: f.schoolClass?.name ?? null,
    })),
  });
});

const structureBody = z.object({
  name: z.string().min(2).max(120),
  term: z.string().min(1).max(32),
  academicYearId: z.uuid(),
  classId: z.uuid().nullable().optional(),
  amount: z.number().positive(),
  active: z.boolean().optional(),
});

financeRouter.post(
  "/structures",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const parsed = structureBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid fee structure" });
      return;
    }
    const row = await prisma.feeStructure.create({
      data: {
        schoolId,
        name: parsed.data.name.trim(),
        term: parsed.data.term.trim(),
        academicYearId: parsed.data.academicYearId,
        classId: parsed.data.classId ?? null,
        amount: parsed.data.amount,
        active: parsed.data.active ?? true,
      },
    });
    res.status(201).json({ id: row.id, amount: Number(row.amount) });
  },
);

financeRouter.put(
  "/structures/:id",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const parsed = structureBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid fee structure" });
      return;
    }
    const existing = await prisma.feeStructure.findFirst({
      where: { id: paramId(req.params.id), schoolId },
    });
    if (!existing) {
      res.status(404).json({ error: "Fee structure not found" });
      return;
    }
    const row = await prisma.feeStructure.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name.trim(),
        term: parsed.data.term.trim(),
        academicYearId: parsed.data.academicYearId,
        classId: parsed.data.classId ?? null,
        amount: parsed.data.amount,
        active: parsed.data.active ?? existing.active,
      },
    });
    res.json({ id: row.id, amount: Number(row.amount) });
  },
);

financeRouter.get("/invoices", ...financeRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const items = await prisma.invoice.findMany({
    where: { schoolId },
    include: { student: { select: { fullName: true, admissionNo: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    items: items.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      description: i.description,
      studentName: i.student.fullName,
      admissionNo: i.student.admissionNo,
      amountTotal: Number(i.amountTotal),
      amountPaid: Number(i.amountPaid),
      balance: Number(i.amountTotal) - Number(i.amountPaid),
      status: i.status,
      createdAt: i.createdAt.toISOString(),
    })),
  });
});

const invoiceBody = z.object({
  studentId: z.uuid(),
  feeStructureId: z.uuid().optional(),
  description: z.string().min(2).max(255),
  amountTotal: z.number().positive().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

financeRouter.post("/invoices", ...financeWrite, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = invoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid invoice" });
    return;
  }

  const student = await prisma.student.findFirst({
    where: { id: parsed.data.studentId, schoolId },
  });
  if (!student) {
    res.status(400).json({ error: "Student not found" });
    return;
  }

  let amount = parsed.data.amountTotal;
  let feeStructureId = parsed.data.feeStructureId;
  if (feeStructureId) {
    const fee = await prisma.feeStructure.findFirst({
      where: { id: feeStructureId, schoolId },
    });
    if (!fee) {
      res.status(400).json({ error: "Fee structure not found" });
      return;
    }
    amount = amount ?? Number(fee.amount);
  }
  if (!amount) {
    res.status(400).json({ error: "amountTotal required" });
    return;
  }

  const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}`;
  const invoice = await prisma.invoice.create({
    data: {
      schoolId,
      studentId: student.id,
      feeStructureId: feeStructureId ?? null,
      invoiceNo,
      description: parsed.data.description.trim(),
      amountTotal: amount,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    },
  });

  void triggerInvoiceIssued({
    schoolId,
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    studentId: student.id,
    studentName: student.fullName,
    amount: Number(invoice.amountTotal),
  });

  res.status(201).json({
    id: invoice.id,
    invoiceNo: invoice.invoiceNo,
    amountTotal: Number(invoice.amountTotal),
  });
});

financeRouter.get(
  "/invoices/:id",
  ...financeRead,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const invoice = await prisma.invoice.findFirst({
      where: { id: paramId(req.params.id), schoolId },
      include: {
        student: true,
        payments: { orderBy: { paidAt: "desc" } },
      },
    });
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    res.json({
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      description: invoice.description,
      status: invoice.status,
      amountTotal: Number(invoice.amountTotal),
      amountPaid: Number(invoice.amountPaid),
      balance: Number(invoice.amountTotal) - Number(invoice.amountPaid),
      student: {
        id: invoice.student.id,
        fullName: invoice.student.fullName,
        admissionNo: invoice.student.admissionNo,
      },
      payments: invoice.payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        method: p.method,
        reference: p.reference,
        paidAt: p.paidAt.toISOString(),
      })),
    });
  },
);

financeRouter.get("/payments", ...financeRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const items = await prisma.invoicePayment.findMany({
    where: { schoolId },
    include: {
      invoice: {
        select: { invoiceNo: true, student: { select: { fullName: true } } },
      },
    },
    orderBy: { paidAt: "desc" },
    take: 100,
  });
  res.json({
    items: items.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      method: p.method,
      reference: p.reference,
      paidAt: p.paidAt.toISOString(),
      invoiceNo: p.invoice.invoiceNo,
      studentName: p.invoice.student.fullName,
    })),
  });
});

const paymentBody = z.object({
  invoiceId: z.uuid(),
  amount: z.number().positive(),
  method: z.enum(["CASH", "BANK", "MOBILE_MONEY", "OTHER"]),
  reference: z.string().max(120).optional(),
});

financeRouter.post("/payments", ...financeWrite, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const parsed = paymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payment" });
    return;
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: parsed.data.invoiceId, schoolId },
  });
  if (!invoice || invoice.status === "VOID") {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const balance = Number(invoice.amountTotal) - Number(invoice.amountPaid);
  if (parsed.data.amount > balance + 0.001) {
    res.status(400).json({ error: "Payment exceeds outstanding balance" });
    return;
  }

  const payment = await prisma.invoicePayment.create({
    data: {
      schoolId,
      invoiceId: invoice.id,
      amount: parsed.data.amount,
      method: parsed.data.method,
      reference: parsed.data.reference?.trim(),
    },
  });
  await refreshInvoiceTotals(invoice.id);

  await writeAuditLog({
    schoolId,
    userId: req.auth!.user.id,
    action: "INVOICE_PAYMENT_CREATED",
    detail: {
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: parsed.data.amount,
      method: parsed.data.method,
    },
  });

  const invStudent = await prisma.student.findFirst({
    where: { id: invoice.studentId, schoolId },
    select: { fullName: true },
  });
  void triggerPaymentRecorded({
    schoolId,
    paymentId: payment.id,
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    studentId: invoice.studentId,
    studentName: invStudent?.fullName ?? "Student",
    amount: parsed.data.amount,
  });

  res.status(201).json({ id: payment.id, receiptId: payment.id });
});

financeRouter.get(
  "/receipts/:id",
  ...financeRead,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const payment = await prisma.invoicePayment.findFirst({
      where: { id: paramId(req.params.id), schoolId },
      include: {
        invoice: {
          include: { student: true, school: { select: { name: true, currency: true } } },
        },
      },
    });
    if (!payment) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }
    res.json({
      receiptId: payment.id,
      paidAt: payment.paidAt.toISOString(),
      amount: Number(payment.amount),
      method: payment.method,
      reference: payment.reference,
      schoolName: payment.invoice.school.name,
      currency: payment.invoice.school.currency,
      invoiceNo: payment.invoice.invoiceNo,
      studentName: payment.invoice.student.fullName,
      admissionNo: payment.invoice.student.admissionNo,
    });
  },
);
