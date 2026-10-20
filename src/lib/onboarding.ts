export function isSchoolOnboardingComplete(school: {
  onboardingCompletedAt?: Date | null;
  addressLine1: string | null;
  city: string | null;
  country: string | null;
  contactEmail: string | null;
  academicYear: string | null;
  term: string | null;
}): boolean {
  if (school.onboardingCompletedAt) return true;
  return Boolean(
    school.addressLine1?.trim() &&
      school.city?.trim() &&
      school.country?.trim() &&
      school.contactEmail?.trim() &&
      school.academicYear?.trim() &&
      school.term?.trim(),
  );
}

