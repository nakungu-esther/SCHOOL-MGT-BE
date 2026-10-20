import bcrypt from "bcrypt";
import type { Role } from "@prisma/client";
import { defaultTrialEndsAt } from "../lib/subscription-plans";
import { prisma } from "../lib/prisma";
import { isSchoolOnboardingComplete } from "../lib/onboarding";
import { fetchOnboardingCompletedAt } from "../lib/school-onboarding-db";
import { permissionsForRole, type Permission } from "../types/roles";

const SALT_ROUNDS = 12;

export type AuthPayload = {
  user: { id: string; email: string; fullName: string | null };
  school: { id: string; name: string; slug: string };
  /** Session tenant id (same as school.id) for school-scoped queries */
  schoolId: string;
  role: Role;
  permissions: Permission[];
  onboardingComplete: boolean;
};

export async function registerSchool(input: {
  schoolName: string;
  slug: string;
  email: string;
  password: string;
  schoolType?: string;
  country?: string;
  district?: string;
  schoolEmail?: string;
  schoolPhone?: string;
  adminFullName?: string;
  adminPhone?: string;
}): Promise<{ schoolId: string; userId: string; slug: string }> {
  const slug = input.slug.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const result = await prisma.$transaction(async (tx) => {
    const school = await tx.school.create({
      data: {
        name: input.schoolName.trim(),
        slug,
        schoolType: input.schoolType?.trim() || null,
        country: input.country?.trim() || null,
        district: input.district?.trim() || null,
        contactEmail: input.schoolEmail?.trim().toLowerCase() || email,
        phone: input.schoolPhone?.trim() || null,
      },
    });

    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        fullName: input.adminFullName?.trim() || null,
        phone: input.adminPhone?.trim() || null,
      },
    });

    await tx.membership.create({
      data: {
        schoolId: school.id,
        userId: user.id,
        role: "SCHOOL_ADMIN",
      },
    });

    await tx.schoolSubscription.create({
      data: {
        schoolId: school.id,
        planCode: "STARTER",
        status: "TRIAL",
        trialEndsAt: defaultTrialEndsAt(),
      },
    });

    return { schoolId: school.id, userId: user.id, slug: school.slug };
  });

  return result;
}

export async function loginToSchool(input: {
  slug?: string;
  email: string;
  password: string;
}): Promise<{ userId: string; schoolId: string } | null> {
  const email = input.email.trim().toLowerCase();
  const slug = input.slug?.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: { include: { school: true } } },
  });
  if (!user) {
    return null;
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    return null;
  }

  if (slug) {
    const school = await prisma.school.findUnique({ where: { slug } });
    if (!school) return null;
    const membership = user.memberships.find((m) => m.schoolId === school.id);
    if (!membership) return null;
    return { userId: user.id, schoolId: school.id };
  }

  if (user.memberships.length === 1) {
    return {
      userId: user.id,
      schoolId: user.memberships[0]!.schoolId,
    };
  }

  return null;
}

export async function buildAuthPayload(
  userId: string,
  schoolId: string,
): Promise<AuthPayload | null> {
  const membership = await prisma.membership.findUnique({
    where: { schoolId_userId: { schoolId, userId } },
    include: {
      school: true,
      user: { select: { id: true, email: true, fullName: true } },
    },
  });
  if (!membership) {
    return null;
  }

  const onboardingCompletedAt = await fetchOnboardingCompletedAt(schoolId);
  const schoolForOnboarding = {
    ...membership.school,
    onboardingCompletedAt,
  };

  return {
    user: {
      id: membership.user.id,
      email: membership.user.email,
      fullName: membership.user.fullName,
    },
    school: {
      id: membership.school.id,
      name: membership.school.name,
      slug: membership.school.slug,
    },
    schoolId: membership.school.id,
    role: membership.role,
    permissions: permissionsForRole(membership.role),
    onboardingComplete: isSchoolOnboardingComplete(schoolForOnboarding),
  };
}

/** Tenant id for school-scoped queries — session only, never request body/query. */
export function sessionSchoolId(session: {
  schoolId?: string;
}): string | undefine