import type { NextFunction, Response } from "express";
import type { Role } from "@prisma/client";
import type { Permission } from "../types/roles";
import { hasPermission } from "../types/roles";
import type { AuthedRequest } from "./auth";

export function requirePermission(permission: Permission) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!hasPermission(req.auth.role, permission)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export function requireRole(role: Role) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (req.auth.role !== role) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}
