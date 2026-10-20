import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createApp } from "./app";
import { isAllowedBrowserOrigin } from "./middleware/origin-guard";

describe("isAllowedBrowserOrigin", () => {
  const allowed = "https://app.edumanage.example";

  it("allows matching Origin header", () => {
    assert.equal(
      isAllowedBrowserOrigin(allowed, undefined, allowed),
      true,
    );
  });

  it("rejects foreign Origin header", () => {
    assert.equal(
      isAllowedBrowserOrigin("https://evil.example", undefined, allowed),
      false,
    );
  });

  it("allows requests with no Origin (non-browser clients)", () => {
    assert.equal(isAllowedBrowserOrigin(undefined, undefined, allowed), true);
  });
});

describe("HTTP smoke", () => {
  it("GET /api/health returns ok", async () => {
    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const port = addr.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, "ok");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET /api/admin/audit-logs requires auth", async () => {
    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const port = addr.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/audit-logs`);
      assert.equal(res.status, 401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET /api/reports/summary/academi