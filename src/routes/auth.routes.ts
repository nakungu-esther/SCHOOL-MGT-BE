import { Router } from "express";
import { z } from "zod";
import { checkRateLimit } from "../lib/auth-rate-limit";
import {
  createPasswordResetToken,
  resetPasswordWithToken,
} from "../lib/password-reset";
import { isSchoolOnboardingComplete } from "../lib/onboarding";
import {
  fetchOnboardingCompletedAt,
  markOnboardingCompleted,
} from "../lib/school-onboarding-db";
import { writeAuditLog } from "../lib/audit-log";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import {
  buildAuthPayload,
  loginToSchool,
  registerSchool,
} from "../services/auth.service";

const registerSchema = z.object({
  schoolName: z.string().min(2).max(255),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, "Invalid slug format"),
  email: z.email(),
  password: z.string().min(8).max(128),
  schoolType: z.string().max(200).optional(),
  country: z.string().max(120).optional(),
  district: z.string().max(120).optional(),
  schoolEmail: z.email().optional(),
  schoolPhone: z.string().max(40).optional(),
  adminFullName: z.string().min(2).max(120).optional(),
  adminPhone: z.string().max(40).optional(),
});

const loginSchema = z.object({
  slug: z.string().min(2).max(100).optional(),
  email: z.email(),
  password: z.string().min(8),
});

const forgotSchema = z.object({
  email: z.email(),
});

const resetSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(128),
});

export const authRouter = Router();

const GENERIC_RESET_MSG =
  "If an account exists for that email, password reset instructions have been sent.";

authRouter.post("/register", async (req, res) => {
  const limit = checkRateLimit(`register:${req.ip}`, 8, 60_000);
  if (!limit.allowed) {
    res.status(429).json({ error: "Too many registration attempts. Try again later." });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid registration data",
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const result = await registerSchool(parsed.data);
    res.status(201).json({
      success: true,
      slug: result.slug,
      email: parsed.data.email.trim().toLowerCase(),
      message: "School registered successfully. You can now sign in.",
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") {
      res.status(409).json({ error: "Email or school slug already exists" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

authRouter.post("/login", async (req, res) => {
  const limit = checkRateLimit(`login:${req.ip}`, 20, 60_000);
  if (!limit.allowed) {
    res.status(429).json({ error: "Too many login attempts. Try again later." });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload" });
    return;
  }

  const result = await loginToSchool(parsed.data);
  if (!result) {
    res.status(401).json({
      error: parsed.data.slug
        ? "Invalid school, email, or password"
        : "Invalid email or password. If you belong to multiple schools, include your school slug.",
    });
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    console.error("session regenerate failed:", err);
    res.status(500).json({ error: "Could not establish session" });
    return;
  }

  req.session.userId = result.userId;
  req.session.schoolId = result.schoolId;

  const auth = await buildAuthPayload(result.userId, result.schoolId);

  void writeAuditLog({
    schoolId: result.schoolId,
    userId: result.userId,
    action: "USER_LOGIN_SUCCEEDED",
    detail: { ip: req.ip ?? null },
  });

  res.json(auth);
});

authRouter.post("/logout", (req, res) => {
  const userId = req.session.userId;
  const schoolId = req.session.schoolId;

  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Could not log out" });
      return;
    }
    if (userId && schoolId) {
      void writeAuditLog({
        schoolId,
        userId,
        action: "USER_LOGOUT",
        detail: {},
      });
    }
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

authRouter.get("/me", requireAuth, (req: AuthedRequest, res) => {
  res.json(req.auth);
});

authRouter.get("/onboarding", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const schoolId = req.auth!.schoolId;
    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) {
      res.status(404).json({ error: "School not found" });
      return;
    }
    const onboardingCompletedAt = await fetchOnboardingCompletedAt(schoolId);
    res.json({
      complete: isSchoolOnboardingComplete({ ...school, onboardingCompletedAt }),
      school: {
        name: school.name,
        motto: school.motto,
        addressLine1: school.addressLine1,
        addressLine2: school.addressLine2,
        city: school.city,
        country: school.country,
        phone: school.phone,
        contactEmail: school.contactEmail,
        academicYear: school.academicYear,
        term: school.term,
        currency: school.currency,
        timezone: school.timezone,
        schoolType: school.schoolType,
      },
    });
  } catch (err) {
    console.error("GET /auth/onboarding failed:", err);
    res.status(500).json({ error: "Could not load onboarding" });
  }
});

authRouter.post("/onboarding/complete", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const schoolId = req.auth!.schoolId;
    await markOnboardingCompleted(schoolId);
    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) {
      res.status(404).json({ error: "School not found" });
      return;
    }
    const onboardingCompletedAt = await fetchOnboardingCompletedAt(schoolId);
    const auth = await buildAuthPayload(req.auth!.user.id, schoolId);
    res.json({
      complete: isSchoolOnboardingComplete({ ...school, onboardingCompletedAt }),
      auth,
    });
  } catch (err) {
    console.error("POST /auth/onboarding/complete failed:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Could not complete onboarding",
    });
  }
});

authRouter.post("/forgot-password", async (req, res) => {
  const limit = checkRateLimit(`forgot:${req.ip}`, 10, 60_000);
  if (!limit.allowed) {
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid email" });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const user = await pris