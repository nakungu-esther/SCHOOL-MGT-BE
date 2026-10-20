import { PrismaClient } from "@prisma/client";
import { defaultTrialEndsAt } from "../src/lib/subscription-plans";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const schools = await prisma.school.findMany({ select: { id: true } });

  for (const school of schools) {
    await prisma.schoolSubscription.upsert({
      where: { schoolId: school.id },
      create: {
        schoolId: school.id,
        planCode: "STARTER",
        status: "TRIAL",
        trialEndsAt: defaultTrialEndsAt(),
      },
      update: {},
    });
  }

  console.log(`Seed complete — ensured trial subscriptions for ${schools.length} school(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
