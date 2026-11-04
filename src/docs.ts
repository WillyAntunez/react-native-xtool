/** rn-xtool's troubleshooting page; error texts link to its sections. */
export const TROUBLESHOOTING_URL = "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md";

/** A link to the troubleshooting section with this heading anchor. */
export function troubleshootingUrl(anchor: string): string {
  return `${TROUBLESHOOTING_URL}#${anchor}`;
}
