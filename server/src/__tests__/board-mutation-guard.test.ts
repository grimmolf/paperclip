import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";

function createApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" = "session",
  trustedOrigins?: string[],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? { type: "board", userId: "board", source: boardSource }
      : { type: "agent", agentId: "agent-1" };
    next();
  });
  app.use(boardMutationGuard(trustedOrigins));
  app.post("/mutate", (_req, res) => {
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe("boardMutationGuard", () => {
  it("allows safe methods for board actor", async () => {
    const app = createApp("board");
    const res = await request(app).get("/read");
    expect(res.status).toBe(204);
  });

  it("blocks board mutations without trusted origin", async () => {
    const app = createApp("board");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board mutation requires trusted browser origin" });
  });

  it("allows local implicit board mutations without origin", async () => {
    const app = createApp("board", "local_implicit");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("allows board mutations from default dev origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "http://localhost:3100")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("allows board mutations from trusted referer origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Referer", "http://localhost:3100/issues/abc")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("does not block authenticated agent mutations", async () => {
    const app = createApp("agent");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("allows board mutations from configured trusted origins", async () => {
    const app = createApp("board", "session", ["https://app.example.com"]);
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "https://app.example.com")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("rejects board mutations from unknown origins even with Host header match", async () => {
    // This verifies the CSRF fix: Host header is no longer used for trust
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "evil.example.com")
      .set("Origin", "http://evil.example.com")
      .send({ ok: true });
    expect(res.status).toBe(403);
  });

  it("rejects board mutations from origin not in configured trusted list", async () => {
    const app = createApp("board", "session", ["https://app.example.com"]);
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "https://attacker.example.com")
      .send({ ok: true });
    expect(res.status).toBe(403);
  });

  it("treats configured trusted origins case-insensitively", async () => {
    const app = createApp("board", "session", ["https://App.Example.COM"]);
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "https://app.example.com")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });
});
