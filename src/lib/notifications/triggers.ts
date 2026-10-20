import type { AnnouncementAudience, AttendanceStatus } from "@prisma/client";
import { prisma } from "../prisma";
import {
  familyUserIdsForStudent,
  parentUserIdsForStudent,
  studentUserIdsForStudent,
  userIdsByRole,
  userIdsForAnnouncementAudience,
} from "./recipients";
import { notifyMany } from "./notification.service";

export async function triggerStudentAdmitted(input: {
  schoolId: string;
  studentId: string;
  fullName: string;
  className: string;
}): Promise<void> {
  const admins = await userIdsByRole(input.schoolId, ["SCHOOL_ADMIN"]);
  await notifyMany(admins, {
    schoolId: input.schoolId,
    category: "ACADEMIC",
    type: "STUDENT_ADMITTED",
    title: "New student admitted",
    message: `${input.fullName} was admitted to ${input.className}.`,
    relatedEntityType: "student",
    relatedEntityId: input.studentId,
    linkPath: `/dashboard/students`,
    idempotencyKeyPrefix: `student:admitted:${input.studentId}`,
  });
}

export async function triggerStudentClassChanged(input: {
  schoolId: string;
  studentId: string;
  fullName: string;
  previousClass: string;
  newClass: string;
  statusChanged?: boolean;
  newStatus?: string;
}): Promise<void> {
  if (input.statusChanged && input.newStatus === "TRANSFERRED") {
    const admins = await userIdsByRole(input.schoolId, ["SCHOOL_ADMIN"]);
    await notifyMany(admins, {
      schoolId: input.schoolId,
      category: "ACADEMIC",
      type: "STUDENT_TRANSFERRED",
      title: "Student transferred",
      message: `${input.fullName} status updated to ${input.newStatus}.`,
      relatedEntityType: "student",
      relatedEntityId: input.studentId,
      linkPath: `/dashboard/students`,
      idempotencyKeyPrefix: `student:transfer:${input.studentId}:${input.newStatus}`,
    });
    return;
  }

  if (input.previousClass === input.newClass) return;

  const family = await familyUserIdsForStudent(input.schoolId, input.studentId);
  await notifyMany(family, {
    schoolId: input.schoolId,
    category: "ACADEMIC",
    type: "STUDENT_CLASS_CHANGED",
    title: "Class assignment updated",
    message: `${input.fullName} moved from ${input.previousClass} to ${input.newClass}.`,
    relatedEntityType: "student",
    relatedEntityId: input.studentId,
    linkPath: `/dashboard/parent`,
    idempotencyKeyPrefix: `student:class:${input.studentId}:${input.newClass}`,
  });
}

export async function triggerEnrollmentUpdated(input: {
  schoolId: string;
  studentId: string;
  studentName: string;
}): Promise<void> {
  const family = await familyUserIdsForStudent(input.schoolId, input.studentId);
  await notifyMany(family, {
    schoolId: input.schoolId,
    category: "ACADEMIC",
    type: "ENROLLMENT_UPDATED",
    title: "Enrollment updated",
    message: `Enrollment records were updated for ${input.studentName}.`,
    relatedEntityType: "student",
    relatedEntityId: input.studentId,
    linkPath: `/dashboard/parent`,
    idempotencyKeyPrefix: `enrollment:${input.studentId}:${Date.now().toString().slice(0, 10)}`,
  });
}

export async function triggerAttendanceStatus(input: {
  schoolId: string;
  studentId: string;
  studentName: string;
  recordDate: string;
  status: AttendanceStatus;
}): Promise<void> {
  if (input.status !== "ABSENT" && input.status !== "LATE") return;

  const dateKey = input.recordDate.slice(0, 10);
  const parents = await parentUserIdsForStudent(input.schoolId, input.studentId);
  const type = input.status === "ABSENT" ? "ATTENDANCE_ABSENT" : "ATTENDANCE_LATE";
  const title =
    input.status === "ABSENT" ? "Absence recorded" : "Late arrival recorded";

  await notifyMany(parents, {
    schoolId: input.schoolId,
    category: "ATTENDANCE",
    type,
    title,
    message: `${input.studentName} was marked ${input.status.toLowerCase()} on ${dateKey}.`,
    relatedEntityType: "student",
    relatedEntityId: input.studentId,
    linkPath: `/dashboard/parent`,
    idempotencyKeyPrefix: `attendance:${input.studentId}:${dateKey}:${input.status}`,
  });

  if (input.status === "ABSENT") {
    const admins = await userIdsByRole(input.schoolId, ["SCHOOL_ADMIN"]);
    await notifyMany(admins, {
      schoolId: input.schoolId,
      category: "ATTENDANCE",
      type: "ATTENDANCE_ADMIN_ALERT",
      title: "Student absence",
      message: `${input.studentName} was marked absent on ${dateKey}.`,
      relatedEntityType: "student",
      relatedEntityId: input.studentId,
      linkPath: `/dashboard/attendance-exams?tab=attendance`,
      idempotencyKeyPrefix: `attendance:admin:${input.studentId}:${dateKey}`,
    });
  }
}

export async function triggerExamPublished(input: {
  schoolId: string;
  examinationId: string;
  examName: string;
  className: string;
}): Promise<void> {
  const students = await prismaStudentIdsInClass(
    input.schoolId,
    input.className,
  );

  for (const studentId of students) {
    const recipients = await familyUserIdsForStudent(
      input.schoolId,
      studentId,
    );
    await notifyMany(recipients, {
      schoolId: input.schoolId,
      category: "ACADEMIC",
      type: "EXAM_PUBLISHED",
      title: "Examination results published",
      message: `${input.examName} results for ${input.className} are now available.`,
      relatedEntityType: "examination",
      relatedEntityId: input.examinationId,
      linkPath: `/dashboard/parent`,
      idempotencyKeyPrefix: `exam:pub:${input.examinationId}:${studentId}`,
    });
  }
}

async function prismaStudentIdsInClass(
  schoolId: string,
  className: string,
): Promise<string[]> {
  const rows = await prisma.student.findMany({
    where: { schoolId, className, status: "ACTIVE" },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function triggerInvoiceIssued(input: {
  schoolId: string;
  invoiceId: string;
  invoiceNo: string;
  studentId: string;
  studentName: string;
  amount: number;
}): Promise<void> {
  const parents = await parentUserIdsForStudent(input.schoolId, input.studentId);
  await notifyMany(parents, {
    schoolId: input.schoolId,
    category: "FINANCE",
    type: "INVOICE_ISSUED",
    title: "New school fee invoice",
    message: `Invoice ${input.invoiceNo} for ${input.studentName}: ${input.amount.toFixed(2)}.`,
    relatedEntityType: "invoice",
    relatedEntityId: input.invoiceId,
    linkPath: `/dashboard/parent`,
    idempotencyKeyPrefix: `invoice:${input.invoiceId}`,
  });
}

export async function triggerPaymentRecorded(input: {
  schoolId: string;
  paymentId: string;
  invoiceId: string;
  invoiceNo: string;
  studentId: string;
  studentName: string;
  amount: number;
}): Promise<void> {
  const parents = await parentUserIdsForStudent(input.schoolId, input.studentId);
  await notifyMany(parents, {
    schoolId: input.schoolId,
    category: "FINANCE",
    type: "PAYMENT_RECORDED",
    title: "Payment received",
    message: `Payment of ${input.amount.toFixed(2)} recorded for invoice ${input.invoiceNo} (${input.studentName}).`,
    relatedEntityType: "invoice_payment",
    relatedEntityId: input.paymentId,
    linkPath: `/dashboard/parent`,
    idempotencyKeyPrefix: `payment:${input.paymentId}`,
  });

  const bursars = await userIdsByRole(input.schoolId, ["BURSAR", "SCHOOL_ADMIN"]);
  await notifyMany(bursars, {
    schoolId: input.schoolId,
    category: "FINANCE",
    type: "PAYMENT_RECORDED",
    title: "Fee payment recorded",
    message: `${input.amount.toFixed(2)} received for ${input.invoiceNo}.`,
    relatedEntityType: "invoice_payment",
    relatedEntityId: input.paymentId,
    linkPath: `/dashboard/finance?tab=payments`,
    idempotencyKeyPrefix: `payment:bursar:${input.paymentId}`,
  });
}

export async function triggerAnnouncementPublished(input: {
  schoolId: string;
  announcementId: string;
  audience: AnnouncementAudience;
  title: string;
}): Promise<void> {
  const userIds = await userIdsForAnnouncementAudience(
    input.schoolId,
    input.audience,
  );
  await notifyMany(userIds, {
    schoolId: input.schoolId,
    category: "ANNOUNCEMENT",
    type: "ANNOUNCEMENT",
    title: "School announcement",
    message: input.title,
    relatedEntityType: "announcement",
    relatedEntityId: input.announcementId,
    linkPath: `/dashboard/notifications`,
    idempotencyKeyPrefix: `announcement:${input.announcementId}`,
  });
}

export async function triggerTeachingAssigned(input: {
  schoolId: string;
  staffUserId: string | null;
  subjectName: string;
  className: string;
  assignmentId: string;
}): Promise<void> {
  if (!input.staffUserId) return;
  await notifyMany([input.staffUserId], {
    schoolId: input.schoolId,
    category: "ACADEMIC",
    type: "TEACHING_ASSIGNED",
    title: "Teaching assignment",
    message: `You were assigned to teach ${input.subjectName} in ${input.className}.`,
    relatedEntityType: "teaching_assignment",
    relatedEntityId: input.assignmentId,
    linkPath: `/dashboard/academics`,
    idempotencyKeyPrefix: `assign:${input.assignmentId}`,
  });
}
