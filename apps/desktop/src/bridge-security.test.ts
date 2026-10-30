import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { Socket } from "node:net";
import { createBridgeServer } from "../server/bridge.mjs";

const FRONTEND_ORIGIN = "http://localhost:1420";
const JSON_HEADERS = { "Content-Type": "application/json" };
const INVOKE_BODY = JSON.stringify({ command: "orch_claim", args: { wp: "X" } });

interface BridgeCtx {
  server: http.Server;
  port: number;
  dispatch: ReturnType<typeof vi.fn>;
  sockets: Set<Socket>;
}

let ctx: BridgeCtx;

beforeEach(async () => {
  const dispatch = vi.fn(async (cmd: string) => ({ echoed: cmd }));
  const server = createBridgeServer({ dispatch });
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  ctx = { server, port, dispatch, sockets };
});

afterEach(async () => {
  for (const s of ctx.sockets) s.destroy();
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
});

interface RawOpts {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

interface RawRes {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function raw(opts: RawOpts): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: ctx.port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: opts.headers ?? {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function invoke(headers: Record<string, string>, body: string | null = INVOKE_BODY) {
  return raw({ method: "POST", path: "/api/invoke", headers, body });
}

describe("bridge host boundary", () => {
  it("serves the allowed localhost frontend origin and dispatches once", async () => {
    const res = await invoke({ Origin: FRONTEND_ORIGIN, ...JSON_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(FRONTEND_ORIGIN);
    expect(String(res.headers.vary)).toMatch(/Origin/);
    expect(JSON.parse(res.text)).toMatchObject({ ok: true });
    expect(ctx.dispatch).toHaveBeenCalledTimes(1);
    expect(ctx.dispatch).toHaveBeenCalledWith("orch_claim", { wp: "X" });
  });

  it("allows a direct same-origin client on the listening loopback port", async () => {
    const res = await invoke({
      Origin: `http://127.0.0.1:${ctx.port}`,
      ...JSON_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(ctx.dispatch).toHaveBeenCalledTimes(1);
  });

  it("allows a local non-browser client with no Origin and a valid Host", async () => {
    const res = await invoke(JSON_HEADERS);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ctx.dispatch).toHaveBeenCalledTimes(1);
  });

  it("accepts application/json with an optional charset", async () => {
    const res = await invoke({ Origin: FRONTEND_ORIGIN, "Content-Type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
    expect(ctx.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://evil.test",
    "http://localhost:1420.evil.test",
    "http://evil-localhost:1420",
    "http://127.0.0.1.evil.test:1420",
    "http://localhost:9999",
    "http://127.0.0.1:9999",
    "null",
  ])("rejects hostile origin %s without dispatch or a permissive header", async (origin) => {
    const res = await invoke({ Origin: origin, ...JSON_HEADERS });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it.each([["evil.test:1234"], ["localhost"], ["127.0.0.1"]])(
    "rejects bad Host %s even with no Origin",
    async (host) => {
      const res = await invoke({ Host: host, ...JSON_HEADERS });
      expect(res.status).toBe(403);
      expect(ctx.dispatch).not.toHaveBeenCalled();
    },
  );

  it("rejects a loopback Host on the wrong port", async () => {
    const res = await invoke({ Host: `127.0.0.1:${ctx.port + 1}`, ...JSON_HEADERS });
    expect(res.status).toBe(403);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("rejects cross-site fetch metadata even when Host looks local", async () => {
    const res = await invoke({ ...JSON_HEADERS, "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it.each([["text/plain", "command=orch_claim"], ["application/x-www-form-urlencoded", "command=orch_claim"]])(
    "rejects simple-form content type %s before dispatch",
    async (contentType, body) => {
      const res = await invoke({ Origin: FRONTEND_ORIGIN, "Content-Type": contentType }, body);
      expect(res.status).toBe(415);
      expect(ctx.dispatch).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON without dispatch", async () => {
    const res = await invoke({ Origin: FRONTEND_ORIGIN, ...JSON_HEADERS }, "{not json");
    expect(res.status).toBe(400);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON without dispatch", async () => {
    const big = JSON.stringify({ command: "orch_claim", pad: "a".repeat(1024 * 1024) });
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const res = await invoke({ Origin: FRONTEND_ORIGIN, ...JSON_HEADERS }, big);
    expect(res.status).toBe(413);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it.each([["{}"], ['{"command":42}'], ["[]"]])("rejects invalid shape %s without dispatch", async (body) => {
    const res = await invoke({ Origin: FRONTEND_ORIGIN, ...JSON_HEADERS }, body);
    expect(res.status).toBe(400);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("answers preflight for the allowed origin and rejects hostile preflight", async () => {
    const ok = await raw({
      method: "OPTIONS",
      path: "/api/invoke",
      headers: { Origin: FRONTEND_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(FRONTEND_ORIGIN);

    const bad = await raw({
      method: "OPTIONS",
      path: "/api/invoke",
      headers: { Origin: "http://localhost:1420.evil.test", "Access-Control-Request-Method": "POST" },
    });
    expect(bad.status).toBe(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("rejects SSE registration for a hostile origin", async () => {
    const res = await raw({
      method: "GET",
      path: "/api/events",
      headers: { Origin: "http://localhost:1420.evil.test" },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("streams SSE for the allowed frontend and cleans up on disconnect", async () => {
    const seen = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: ctx.port,
          method: "GET",
          path: "/api/events",
          headers: { Origin: FRONTEND_ORIGIN },
        },
        (res) => {
          try {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
            expect(res.headers["access-control-allow-origin"]).toBe(FRONTEND_ORIGIN);
          } catch (e) {
            reject(e);
            return;
          }
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            text += c;
            if (text.includes("connected")) {
              req.destroy();
              resolve(text);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", () => {
        /* expected after req.destroy() */
      });
      req.end();
    });
    expect(seen).toContain("connected");
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });
});
