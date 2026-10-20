import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { env } from "./config/env";
import { pool } from "./db/pool";
import "./types/session";
import { originGuard } from "./middleware/origin-guard";
import { apiRateLimit } from "./middleware/api-rate-limit";
import { isHttpError } from "./lib/http-error";
import { adminRouter } from "./routes/admin.routes";
import { authRouter } from "./routes/auth.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { schoolRouter } from "./routes/school.routes";
import { assessmentRouter } from "./routes/assessment.routes";
import { attendanceRouter } from "./routes/attendance.routes";
import { academicsRouter } from "./routes/academics.routes";
import { examinationsRouter } from "./routes/examinations.routes";
import { gradingRouter } from "./routes/grading.routes";
import { enrollmentsRouter } from "./routes/enrollments.routes";
import { financeRouter } from "./routes/finance.routes";
import { reportsRouter } from "./routes/reports.routes";
import { analyticsRouter } from "./routes/analytics.routes";
import { portalRouter } from "./routes/portal.routes";
import { subscriptionRouter } from "./routes/subscription.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { studentsRouter } from "./routes/students.routes";

const PgSession = connectPgSimple(session);

export function createApp(): express.Application {
  const app = express();

  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: env.clientOrigin,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());
  app.use(originGuard);
  app.use(apiRateLimit);

  app.use(
    session({
      store: new PgSession({
        pool,
        tableName: "session",
        createTableIfMissing: false,
      }),
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: env.nodeEnv === "production",
        sameSite: env.nodeEnv === "production" ? "none" : "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "edumanage-api" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/school", schoolRouter);
  app.use("/api/students", studentsRouter);
  app.use("/api/academics", academicsRouter);
  app.use("/api/attendance", attendanceRouter);
  app.use("/api/examinations", examinationsRouter);
  app.use("/api/grading", gradingRouter);
  app.use("/api/assessment", assessmentRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/finance", financeRouter);
  app.use("/api/enrollments", enrollmentsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/portal", portalRouter);
  app.use("/api/subscription", subscriptionRouter);
  app.use("/api/admin", adminRouter);

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
  