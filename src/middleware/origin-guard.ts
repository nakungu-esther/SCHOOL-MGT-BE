import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

export function isAllowedBrowserOrigin(
  origin: string | undefined,
  referer: string | undefined,
  allowedOrigin: string,
): boolean {
  if (origin) {
    return origin === allowedOrigin;
  }
  if (referer) {
    try {
      const url = new URL(referer);
      const allowed = new URL(allowedOrigin);
      return url.origin === allowed.origin;
    } catch {
      return false;
    }
  }
  return true;
}

/** Reject cross-origin state-changing requests in production. */
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (env.nodeEnv !== "production") {
    next();
    return;
  }

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }

  const origin = req.get("origin");
  const referer = req.get("referer");
  if (!isAllowedBrowserOrigin(origin, referer, env.clientOrigin)) {
    res.status(403).json({ error: "Request origin not allowed" });
    return;
  }

  next();
}
