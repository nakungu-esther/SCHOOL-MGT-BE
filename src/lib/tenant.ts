import type { Response } from "express";
import { sessionSchoolId } from "../services/auth.service";
import type { AuthedRequest } from "../middleware/auth";

/** Resolve tenant id from session only (never from query/body). */
export function tenantIdFromSession(session: {
  schoolId?: string;
}): string | undefined {
  return sessionSchoolId(session);
}

/**
 * Ensures session tenant matches authenticated membership school.
 * Returns schoolId or sends error response.
 */
export function requireTenantScope(
  req: AuthedRequest,
  res: Response,
): string | null {
  const schoolId = tenantIdFromSession(req.session);
  if (!schoolId || !req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  if (schoolId !== req.auth.school.id) {
    res.status(403).json({ error: "School context mismatch" });
    return null;
  }
  return schoolId;
}
