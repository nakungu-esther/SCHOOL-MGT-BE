import { Router } from "express";
import { z } from "zod";
import type { NotificationCategory, Prisma } from "@prisma/client";
import { paramId } from "../lib/academics-scope";
import {
  createNotification,
  serializeNotification,
  unreadCount,
} from "../lib/notifications/notification.service";
import { pushUnreadCount } from "../lib/notifications/realtime";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";

export const notificationsRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z
    .enum(["ACADEMIC", "ATTENDANCE", "FINANCE", "ANNOUNCEMENT", "SYSTEM"])
    .optional(),
  unreadOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  search: z.string().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

notificationsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const userId = req.auth!.user.id;

  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { page, limit, category, unreadOnly, archived, search, from, to } =
    parsed.data;

  const where: Prisma.PortalNotificationWhereInput = {
    schoolId,
    userId,
    archivedAt: archived ? { not: null } : null,
  };

  if (category) where.category = category as NotificationCategory;
  if (unreadOnly) where.readAt = null;
  if (search?.trim()) {
    const q = search.trim();
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { body: { contains: q, mode: "insensitive" } },
    ];
  }
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [total, items, unread, todayCount] = await Promise.all([
    prisma.portalNotification.count({ where }),
    prisma.portalNotification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    unreadCount(schoolId, userId),
    prisma.portalNotification.count({
      where: {
        schoolId,
        userId,
        archivedAt: null,
        createdAt: { gte: startOfToday() },
      },
    }),
  ]);

  res.json({
    summary: {
      total,
      unread,
      today: todayCount,
    },
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    items: items.map(serializeNotification),
  });
});

notificationsRouter.get(
  "/unread-count",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const count = await unreadCount(schoolId, req.auth!.user.id);
    res.json({ unreadCount: count });
  },
);

notificationsRouter.patch(
  "/:id/read",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const userId = req.auth!.user.id;
    const id = paramId(req.params.id);

    const note = await prisma.portalNotification.findFirst({
      where: { id, schoolId, userId },
    });
    if (!note) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const updated = await prisma.portalNotification.update({
      where: { id },
      data: { readAt: note.readAt ?? new Date() },
    });

    const count = await unreadCount(schoolId, userId);
    pushUnreadCount(schoolId, userId, count);

    res.json(serializeNotification(updated));
  },
);

notificationsRouter.patch("/mark-all-read", requireAuth, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  const userId = req.auth!.user.id;

  await prisma.portalNotification.updateMany({
    where: { schoolId, userId, readAt: null, archivedAt: null },
    data: { readAt: new Date() },
  });

  pushUnreadCount(schoolId, userId, 0);
  res.json({ ok: true });
});

notificationsRouter.patch(
  "/:id/archive",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const userId = req.auth!.user.id;
    const id = paramId(req.params.id);

    const note = await prisma.portalNotification.findFirst({
      where: { id, schoolId, userId },
    });
    if (!note) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const updated = await prisma.portalNotification.update({
      where: { id },
      data: { archivedAt: note.archivedAt ?? new Date() },
    });

    res.json(serializeNotification(updated));
  },
);

const preferencesBody = z.object({
  inAppEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  academicEnabled: z.boolean().optional(),
  attendanceEnabled: z.boolean().optional(),
  financeEnabled: z.boolean().optional(),
  announcementEnabled: z.boolean().optional(),
});

notificationsRouter.get(
  "/preferences",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const userId = req.auth!.user.id;

    const pref = await prisma.notificationPreference.upsert({
      where: { schoolId_userId: { schoolId, userId } },
      create: { schoolId, userId },
      update: {},
    });

    res.json({
      inAppEnabled: pref.inAppEnabled,
      emailEnabled: pref.emailEnabled,
      smsEnabled: pref.smsEnabled,
      academicEnabled: pref.academicEnabled,
      attendanceEnabled: pref.attendanceEnabled,
      financeEnabled: pref.financeEnabled,
      announcementEnabled: pref.announcementEnabled,
      emailConfigured: false,
      smsConfigured: false,
    });
  },
);

notificationsRouter.put(
  "/preferences",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const userId = req.auth!.user.id;

    const parsed = preferencesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid preferences" });
      return;
    }

    const pref = await prisma.notificationPreference.upsert({
      where: { schoolId_userId: { schoolId, userId } },
      create: { schoolId, userId, ...parsed.data },
      update: parsed.data,
    });

    res.json({
      inAppEnabled: pref.inAppEnabled,
      emailEnabled: pref.emailEnabled,
      smsEnabled: pref.smsEnabled,
      academicEnabled: pref.academicEnabled,
      attendanceEnabled: pref.attendanceEnabled,
      financeEnabled: pref.financeEnabled,
      announcementEnabled: pref.announcementEnabled,
    });
  },
);

/** Admin manual notification (all roles) */
notificationsRouter.post(
  "/manual",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    if (req.auth!.role !== "SCHOOL_ADMIN") {
      res.status(403).json({ error: "Admin only" });
      return;
    }

    const body = z
      .object({
        userId: z.uuid(),
        title: z.string().min(2).max(200),
        message: z.string().min(1).max(2000),
      })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    const membership = await prisma.membership.findUnique({
      where: { schoolId_userId: { schoolId, userId: body.data.userId } },
    });
    if (!membership) {
      res.status(400).json({ error: "User not in this school" });
      return;
    }

    const result = await createNotification({
      schoolId,
      userId: body.data.userId,
      category: "SYSTEM",
      type: "MANUAL",
      title: body.data.title,
      message: body.data.message,
      idempotencyKey: `manual:${Date.now()}:${body.data.userId}`,
    });

    res.status(result.created ? 201 : 200).json(result);
  },
);

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
