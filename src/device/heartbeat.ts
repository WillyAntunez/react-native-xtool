import { HeartbeatLostError, message } from "./errors.js";
import type { LockdownClient } from "./lockdown.js";
import { PlistChannel, type PlistDict } from "./plistio.js";

export const HEARTBEAT_SERVICE = "com.apple.mobile.heartbeat";

const DEFAULT_INTERVAL_SEC = 10;

export interface HeartbeatStep {
  reply?: PlistDict;
  intervalSec?: number;
  sleeping?: boolean;
}

/** What to do with one heartbeat message: `Marco` → `Polo`; `SleepyTime` → the iPhone is sleeping. */
export function heartbeatStep(msg: PlistDict): HeartbeatStep {
  if (msg.Command === "Marco") {
    const interval = Number(msg.Interval);
    return { reply: { Command: "Polo" }, intervalSec: interval > 0 ? interval : DEFAULT_INTERVAL_SEC };
  }
  if (msg.Command === "SleepyTime") return { sleeping: true };
  return {};
}

export interface HeartbeatOptions {
  /** How long to wait for the first Marco (iOS sends it immediately). */
  firstMarcoTimeoutMs?: number;
  /** Grace on top of the device's announced interval before the heartbeat counts as lost. */
  slackMs?: number;
}

/**
 * Over Wi‑Fi, iOS drops every lockdown service connection on its first request unless the host
 * keeps a `com.apple.mobile.heartbeat` session answering Marco with Polo (usbmuxd does this for
 * USB, which is why USB tools never notice). Start it before using any other service and keep it
 * for the whole operation.
 */
export class Heartbeat {
  private stopped = false;
  private intervalSec = DEFAULT_INTERVAL_SEC;
  failure: HeartbeatLostError | undefined;
  beats = 0;
  /** Rejects once the heartbeat is lost; never resolves. */
  readonly lost: Promise<never>;
  private rejectLost!: (e: Error) => void;

  private constructor(
    private readonly ch: PlistChannel,
    private readonly slackMs: number,
  ) {
    this.lost = new Promise<never>((_, reject) => (this.rejectLost = reject));
    this.lost.catch(() => {});
  }

  static async start(lockdown: Pick<LockdownClient, "openService">, opts: HeartbeatOptions = {}): Promise<Heartbeat> {
    const ch = new PlistChannel(await lockdown.openService(HEARTBEAT_SERVICE), "heartbeat");
    const hb = new Heartbeat(ch, opts.slackMs ?? 5000);
    try {
      const first = await ch.recv(opts.firstMarcoTimeoutMs ?? 15_000);
      const step = heartbeatStep(first);
      if (!step.reply) throw new Error(`heartbeat: expected Marco, got ${String(first.Command)}`);
      await ch.send(step.reply);
      hb.intervalSec = step.intervalSec!;
      hb.beats = 1;
    } catch (e) {
      ch.close();
      throw e;
    }
    void hb.loop();
    return hb;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const msg = await this.ch.recv(this.intervalSec * 1000 + this.slackMs);
        const step = heartbeatStep(msg);
        if (step.sleeping) throw new Error("the iPhone is going to sleep");
        if (step.reply) {
          this.intervalSec = step.intervalSec!;
          await this.ch.send(step.reply);
          this.beats++;
        }
      } catch (e) {
        if (!this.stopped) this.fail(message(e));
        return;
      }
    }
  }

  private fail(reason: string): void {
    this.failure = new HeartbeatLostError(reason);
    this.stopped = true;
    this.ch.close();
    this.rejectLost(this.failure);
  }

  /** Runs `op`, but rejects as soon as the heartbeat is lost (the op cannot succeed after that). */
  guard<T>(op: Promise<T>): Promise<T> {
    return Promise.race([op, this.lost]);
  }

  stop(): void {
    this.stopped = true;
    this.ch.close();
  }
}
