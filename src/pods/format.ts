/** Texts shared by the binary-pod code. */
import { troubleshootingUrl } from "../docs.js";

/** The troubleshooting section every binary-pod stop links to. */
export const PODS_LINK = troubleshootingUrl("cocoapods-binaries");

/** A stop of the binary-pod steps: its message is the whole text the user sees. */
export class PodsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodsError";
  }
}

/** Decimal units: `30.3 MB` (one decimal) from 100 KB up, `7 KB` below, `size unknown` without a length. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "size unknown";
  const kb = Math.round(bytes / 1000);
  return kb < 100 ? `${kb} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}
