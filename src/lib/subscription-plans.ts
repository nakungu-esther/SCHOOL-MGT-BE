import type { SubscriptionPlanCode } from "@prisma/client";

export type SubscriptionPlanDefinition = {
  code: SubscriptionPlanCode;
  name: string;
  monthlyPriceUgx: number;
  studentLimit: number;
  description: string;
};

export const SUBSCRIPTION_PLANS: SubscriptionPlanDefinition[] = [
  {
    code: "STARTER",
    name: "Starter",
    monthlyPriceUgx: 50_000,
    studentLimit: 300,
    description: "For small schools getting started on EduManage.",
  },
  {
    code: "GROWTH",
    name: "Growth",
    monthlyPriceUgx: 150_000,
    studentLimit: 1_500,
    description: "For growing schools with more classes and staff.",
  },
  {
    code: "ENTERPRISE",
    name: "Enterprise",
    monthlyPriceUgx: 450_000,
    studentLimit: 10_000,
    description: "For large institutions with high student volumes.",
  },
];

export function planByCode(code: SubscriptionPlanCode): SubscriptionPlanDefinition {
  const plan = SUBSCRIPTION_PLANS.find((p) => p.code === code);
  if (!plan) throw new Error(`Unknown plan ${code}`);
  return plan;
}

export function defaultTrialEndsAt(from = new Date()): Date {
  const end = new Date(from);
  end.setDate(end.getDate() + 30);
  return end;
}
