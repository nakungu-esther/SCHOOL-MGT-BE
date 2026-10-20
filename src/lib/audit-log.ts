import type { AuditAction, Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export async function writeAuditLog(input: {
  schoolId: string;
  userId?: string;
  action: AuditAction;
  detail?: Prisma.InputJsonValue;
}): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      schoolId: input.schoolId,
      userId: input.userId ?? null,
      action: input.action,
      detail: input.detail ?? {},
    },
  });
}
