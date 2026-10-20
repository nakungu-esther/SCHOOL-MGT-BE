import { AuditAction } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";

export const adminRouter = Router();

adminRouter.get(
  "/check",
  requireAuth,
  requireRole("SCHOOL_ADMI