import { existsSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { store } from "./storage.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info"
  }
});

await app.register(cors, {
  origin: config.corsOrigin,
  credentials: true
});
await app.register(sensible);
await app.register(jwt, {
  secret: config.jwtSecret
});

await store.load();
if (store.generatedAdminPassword) {
  app.log.warn("[setup] admin account created");
  app.log.warn(`[setup] username: ${config.adminUsername}`);
  app.log.warn(`[setup] admin password: ${store.generatedAdminPassword}`);
  app.log.warn("[setup] please change the password after first login");
}

await registerRoutes(app);

const publicDirCandidates = [
  process.env.PUBLIC_DIR,
  path.join(process.cwd(), "backend", "public"),
  path.join(process.cwd(), "public"),
  path.join(process.cwd(), "..", "frontend", "dist")
].filter(Boolean) as string[];
const publicDir = publicDirCandidates.find((candidate) => existsSync(path.join(candidate, "index.html")));

if (publicDir) {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/"
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.notFound();
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
