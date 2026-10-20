import { createServer } from "node:http";
import { env, validateProductionConfig } from "./config/env";
import { createApp } from "./app";
import { attachNotificationSocket } from "./lib/notifications/realtime";

validateProductionConfig();

const app = createApp();
const httpServer = createServer(app);
attachNotificationSocket(httpServer);

httpServer.listen(env.port, () => {
  console.log(`EduManag