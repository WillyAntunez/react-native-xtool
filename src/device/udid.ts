/** iPhone UDIDs: `00008030-0000000000000000` style (2018+) or 40 hex digits (older devices). */
export const UDID_PATTERN = /^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/;

export const isValidUdid = (u: string): boolean => UDID_PATTERN.test(u);

/** usbmuxd may report new-style UDIDs without the dash; returns the canonical form or undefined. */
export function normalizeUdid(u: string): string | undefined {
  if (isValidUdid(u)) return u;
  if (/^[0-9A-Fa-f]{24}$/.test(u)) return `${u.slice(0, 8)}-${u.slice(8)}`;
  return undefined;
}

/** Throws unless `u` is a UDID: device-supplied values go into file paths and messages. */
export function checkUdid(u: string, source: string): string {
  if (!isValidUdid(u)) throw new Error(`${source} gave an invalid UDID (${JSON.stringify(u.slice(0, 64))})`);
  return u;
}

export const sameUdid = (a: string, b: string): boolean =>
  a.replace(/-/g, "").toUpperCase() === b.replace(/-/g, "").toUpperCase();
