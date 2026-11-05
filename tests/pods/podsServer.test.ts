import { afterEach, describe, expect, it } from "vitest";
import { startPodsServer, type PodsServer } from "../support/podsServer.js";

let server: PodsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("startPodsServer", () => {
  // A loaded machine reuses a kept-alive socket the server is closing, and the request fails with ECONNRESET.
  it("closes the connection after every answer", async () => {
    server = await startPodsServer({ "/a": { body: "a" } });
    for (const method of ["GET", "HEAD"]) {
      const ok = await fetch(`${server.base}/a`, { method });
      await ok.arrayBuffer();
      expect(ok.headers.get("connection")).toBe("close");
    }
    const missing = await fetch(`${server.base}/missing`);
    await missing.arrayBuffer();
    expect(missing.headers.get("connection")).toBe("close");
  });
});
