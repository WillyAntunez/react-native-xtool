import type { Duplex } from "node:stream";
import { DeviceClosedError, DeviceTimeoutError } from "./errors.js";

/**
 * Pull-style reader over a socket: `read(n)` resolves with exactly `n` bytes, or rejects when the
 * peer closes the connection or stays silent past the timeout. One reader per stream, one pending
 * read at a time (every device protocol here is strict request/response).
 */
export class ByteReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private ended = false;
  private error: Error | undefined;
  private wake: (() => void) | undefined;

  private readonly onData = (d: Buffer): void => {
    this.chunks.push(d);
    this.size += d.length;
    this.notify();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.notify();
  };
  private readonly onError = (e: Error): void => {
    this.error = e;
    this.notify();
  };

  constructor(
    readonly stream: Duplex,
    readonly what: string,
  ) {
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.on("close", this.onEnd);
    stream.on("error", this.onError);
  }

  private notify(): void {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.size);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return out;
  }

  async read(n: number, timeoutMs?: number): Promise<Buffer> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      if (this.size >= n) return this.take(n);
      if (this.error) throw this.error;
      if (this.ended) throw new DeviceClosedError(this.what);
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        this.wake = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        if (deadline !== undefined) {
          timer = setTimeout(() => {
            this.wake = undefined;
            reject(new DeviceTimeoutError(this.what, timeoutMs!));
          }, Math.max(0, deadline - Date.now()));
        }
      });
    }
  }

  /** Stops consuming the stream (e.g. before handing the raw socket to TLS); returns unread bytes. */
  detach(): Buffer {
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onEnd);
    this.stream.off("error", this.onError);
    return this.take(this.size);
  }
}

/** Writes and resolves once the data is handed to the OS (gives natural backpressure). */
export function writeAll(stream: Duplex, data: Buffer | Buffer[]): Promise<void> {
  const parts = Array.isArray(data) ? data : [data];
  return new Promise((resolve, reject) => {
    if (stream.destroyed || !stream.writable) {
      reject(new Error("connection already closed"));
      return;
    }
    let pending = parts.length;
    for (const p of parts) {
      stream.write(p, (err) => {
        if (err) reject(err);
        else if (--pending === 0) resolve();
      });
    }
  });
}
