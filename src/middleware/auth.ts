import type { NextFunction, Request, Response } from "express";
import {
  buildAuthPayload,
  sessionSchoolId,
  type AuthPayload,
} from "../services/auth.service";

export type AuthedRequest = Request & { auth?: AuthPayload };

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.session.userId;
  const schoolId = sessionSchoolId(req.session);

  if (!userId || !schoolId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const auth = await buildAuthPayload(userId, schoolId);
    if (!auth) {
      req.session.destroy(() => undefined);
      res.status(401).json({ error: "Session invalid for this school" });
      return;
    }
    req.auth = auth;
    next();
  } catch (err) {
    console.error("requireAuth failed:", err);
    res.status(500).json({ error: "Authentication service error" });
  }
}
