import type { Server as HttpServer } from "node:http";
import type { Server, Socket } from "socket.io";
import { Server as SocketIOServer } from "socket.io";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { env } from "../../config/env";
import { pool } from "../../db/pool";
import "../../types/session";

let io: SocketIOServer | null = null;

export type RealtimeNotificationPayload = {
  id: string;
  category: string;
  type: string;
  title: string;
  message: string;
  linkPath: string | null;
  createdAt: string;
  unreadCount: number;
};

export function attachNotificationSocket(httpServer: HttpServer): SocketIOServer {
  const PgSession = connectPgSimple(session);
  const sessionMiddleware = session({
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
    },
  });

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.clientOrigin,
      credentials: true,
    },
    path: "/socket.io",
  });

  io.engine.use(
    (req: unknown, res: unknown, next: (err?: Error) => void) => {
      sessionMiddleware(req as never, res as never, next as never);
    },
  );

  io.use((socket: Socket, next) => {
    const req = socket.request as unknown as {
      session?: { userId?: string; schoolId?: string };
    };
    const userId = req.session?.userId;
    const schoolId = req.session?.schoolId;
    if (!userId || !schoolId) {
      next(new Error("Unauthorized"));
      return;
    }
    socket.data.userId = userId;
    socket.data.schoolId = schoolId;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;
    const schoolId = socket.data.schoolId as string;
    socket.join(userRoom(schoolId, userId));
  });

  return io;
}

function userRoom(schoolId: string, userId: string): string {
  return `school:${schoolId}:user:${userId}`;
}

export function pushNotificationToUser(
  schoolId: string,
  userId: string,
  payload: RealtimeNotificationPayload,
): void {
  io?.to(userRoom(schoolId, userId)).emit("notification", payload);
}

export function pushUnreadCount(
  schoolId: string,
  userId: string,
  unreadCount: number,
): void {
  io?.to(userRoom(schoolId, userId)).emit("unread_count", { unreadCount });
}
