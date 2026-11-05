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
  /** Never answers (the connection stays open until the server closes). */
  hang?: boolean;
}

export interface PodsServer {
  base: string;
  /** "METHOD path" per request, in order. */
  requests: string[];
  /** The User-Agent of each request, in order. */
  userAgents: (string | undefined)[];
  routes: Record<string, Route>;
  close(): Promise<void>;
}

/** Serves `routes` (path → route); any other path answers 404. Routes may be added after the start. */
export async function startPodsServer(routes: Record<string, Route> = {}): Promise<PodsServer> {
  const requests: string[] = [];
  const userAgents: (string | undefined)[] = [];
  const hanging = new Set<import("node:http").ServerResponse>();
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    requests.push(`${req.method} ${url}`);
    userAgents.push(req.headers["user-agent"]);
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
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    userAgents,
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
