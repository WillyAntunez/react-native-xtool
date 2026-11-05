/**
 * A local stand-in for the CocoaPods CDN and the download hosts: a node:http server on 127.0.0.1 that serves fixed
 * routes. No test reaches the network.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Route {
  status?: number;
  body?: string | Buffer;
  headers?: Record<string, string>;
  /** A path on this server (or a full URL) to answer 301 with. */
  redirect?: string;
  /** 403 when the request's User-Agent does not start with it. */
  needsUserAgent?: string;
  /**
   * Sends the full Content-Length but only the first `at` bytes of the body, then closes the connection: for the first
   * `times` requests (every request without it).
   */
  truncate?: { at: number; times?: number };
  /** Never answers (the connection stays open until the server closes). */
  hang?: boolean;
  /**
   * For the first `times` requests: answers `status` (with an empty body), or, without one, resets the connection
   * before any answer (the client reads ECONNRESET).
   */
  fail?: { times: number; status?: number };
}

export interface PodsServer {
  base: string;
  /** "METHOD path" per request, in order. */
  requests: string[];
  /** The User-Agent of each request, in order. */
  userAgents: (string | undefined)[];
  /** The Accept-Encoding of each request, in order. */
  encodings: (string | undefined)[];
  routes: Record<string, Route>;
  close(): Promise<void>;
}

/** Serves `routes` (path → route); any other path answers 404. Routes may be added after the start. */
export async function startPodsServer(routes: Record<string, Route> = {}): Promise<PodsServer> {
  const requests: string[] = [];
  const userAgents: (string | undefined)[] = [];
  const encodings: (string | undefined)[] = [];
  const hanging = new Set<import("node:http").ServerResponse>();
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    requests.push(`${req.method} ${url}`);
    userAgents.push(req.headers["user-agent"]);
    encodings.push(req.headers["accept-encoding"]);
    // No kept-alive sockets: under load a client reuses one the server is closing, and the request fails with ECONNRESET.
    res.setHeader("connection", "close");
    const route = routes[url.replace(/\?.*$/, "")];
    if (route === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    if (route.needsUserAgent !== undefined && !(req.headers["user-agent"] ?? "").startsWith(route.needsUserAgent)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (route.fail !== undefined && route.fail.times > 0) {
      route.fail.times--;
      if (route.fail.status !== undefined) res.writeHead(route.fail.status).end();
      else req.socket.resetAndDestroy();
      return;
    }
    if (route.hang === true) {
      hanging.add(res);
      return;
    }
    if (route.redirect !== undefined) {
      res.writeHead(301, { location: route.redirect }).end();
      return;
    }
    const body = route.body ?? "";
    res.writeHead(route.status ?? 200, { "content-length": String(Buffer.byteLength(body)), ...route.headers });
    const truncate = route.truncate;
    if (req.method !== "HEAD" && truncate !== undefined && (truncate.times === undefined || truncate.times > 0)) {
      if (truncate.times !== undefined) truncate.times--;
      res.write(Buffer.from(body).subarray(0, truncate.at), () => res.socket?.destroy());
      return;
    }
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    userAgents,
    encodings,
    routes,
    close: () => {
      for (const res of hanging) res.socket?.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A base URL on 127.0.0.1 whose port nothing listens on: it stands for "offline". */
export async function closedPortBase(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
