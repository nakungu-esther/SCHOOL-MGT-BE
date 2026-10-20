import "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    /** Tenant scope — set only during login/register; never from client on data routes */
    schoolId?: string;
  }
}
