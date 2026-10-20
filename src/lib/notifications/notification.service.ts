import type {
  NotificationCategory,
  NotificationType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../prisma";
import {
  pushNotificationToUser,
  pushUnreadCount,
  type RealtimeNotificationPayload,
} from "./realtime";

export type CreateNotificationInput = {
  schoolId: string;
  userId: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  linkPath?: string;
  idempotencyKey?: string;
};

const categoryField: Record<
  NotificationCategory,
  keyof Prisma.NotificationPreferenceSelect
> = {
  ACADEMIC: "academicEnabled",
  ATTENDANCE: "attendanceEnabled",
  FINANCE: "financeEnabled",
  ANNOUNCEMENT: "announcementEnabled",
  SYSTEM: "inAppEnabled",
};

async function preferencesAllow(
  schoolId: string,
  userId: string,
  category: NotificationCategory,
): Promise<boolean> {
  const pref = await prisma.notificationPreference.findUnique({
    where: { schoolId_userId: { schoolId, userId } },
  });
  if (!pref) return true;
  if (!pref.inAppEnabled) return false;
  const key = categoryField[category];
  return Boolean(pref[key as keyof typeof pref]);
}

export async function unreadCount(
  schoolId: string,
  userId: string,
): Promise<number> {
  return prisma.portalNotification.count({
    where: {
      schoolId,
      userId,
      readAt: null,
      archivedAt: null,
    },
  });
}

export async function createNotification(
  input: CreateNotificationInput,
): Promise<{ created: boolean; notificationId?: string }> {
  const allowed = await preferencesAllow(
    input.schoolId,
    input.userId,
    input.category,
  );
  if (!allowed) return { created: false };

  try {
    const row = await prisma.portalNotification.create({
      data: {
        schoolId: input.schoolId,
        userId: input.userId,
        category: input.category,
        type: input.type,
        title: input.title,
        body: input.message,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
        linkPath: input.linkPath,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const count = await unreadCount(input.schoolId, input.userId);
    const payload: RealtimeNotificationPayload = {
      id: row.id,
      category: row.category,
      type: row.type,
      title: row.title,
      message: row.body,
      linkPath: row.linkPath,
      createdAt: row.createdAt.toISOString(),
      unreadCount: count,
    };
    pushNotificationToUser(input.schoolId, input.userId, payload);
    pushUnreadCount(input.schoolId, input.userId, count);

    return { created: true, notificationId: row.id };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      return { created: false };
    }
    throw err;
  }
}

export async function notifyMany(
  userIds: string[],
  base: Omit<CreateNotificationInput, "userId"> & {
    idempotencyKeyPrefix: string;
  },
): Promise<void> {
  const unique = [...new Set(userIds)];
  await Promise.all(
    unique.map((userId) =>
      createNotification({
        ...base,
        userId,
        idempotencyKey: `${base.idempotencyKeyPrefix}:${userId}`,
      }),
    ),
  );
}

export function serializeNotification(row: {
  id: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  linkPath: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    category: row.category,
    type: row.type,
    title: row.title,
    message: row.body,
    linkPath: row.linkPath,
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    readAt: row.readAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    isRead: Boolean(row.readAt),
  };
}
