/** The iPhone did not accept a TCP connection in time (asleep, locked, wrong IP, other network). */
export class DeviceUnreachableError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    reason: string,
  ) {
    super(`${host}:${port} did not answer (${reason})`);
    this.name = "DeviceUnreachableError";
  }
}

/** The peer closed a connection while we were waiting for data. */
export class DeviceClosedError extends Error {
  constructor(what: string) {
    super(`${what}: the iPhone closed the connection`);
    this.name = "DeviceClosedError";
  }
}

/** The peer stayed silent longer than the operation allows. */
export class DeviceTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what}: no answer from the iPhone within ${Math.round(timeoutMs / 1000)} s`);
    this.name = "DeviceTimeoutError";
  }
}

/** True for failures that mean "the connection went away", as opposed to a refusal by the device. */
export function isConnectionFailure(e: unknown): boolean {
  return (
    e instanceof DeviceUnreachableError ||
    e instanceof DeviceClosedError ||
    e instanceof DeviceTimeoutError ||
    e instanceof HeartbeatLostError ||
    (e instanceof Error && /^(ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED)$/.test(
      (e as NodeJS.ErrnoException).code ?? "",
    ))
  );
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The heartbeat session died: iOS tears down every other service connection with it. */
export class HeartbeatLostError extends Error {
  constructor(reason: string) {
    super(`Lost the Wi‑Fi heartbeat with the iPhone (${reason}); it probably locked, slept or left the network.`);
    this.name = "HeartbeatLostError";
  }
}

/** The TLS peer is not the iPhone of the pair record (another host on that address, or an impostor). */
export class DeviceAuthenticationError extends Error {
  constructor(host: string) {
    super(
      `The host at ${host} is not the paired iPhone: its TLS certificate does not match this computer's pair record. Nothing was sent to it.`,
    );
    this.name = "DeviceAuthenticationError";
  }
}
