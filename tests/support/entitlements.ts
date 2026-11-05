/** A plist document around `body`, as Xcode writes an .entitlements file. */
export const plistOf = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
  `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;

/**
 * tests/fixtures/pbxproj/with-objc.pbxproj with CODE_SIGN_ENTITLEMENTS set on the app target's Debug configuration
 * (`debug`) and Release configuration (`release`, `debug` by default); undefined leaves a configuration without it.
 */
export function withEntitlements(src: string, debug: string | undefined, release: string | undefined = debug): string {
  let n = 0;
  return src.replace(/^(\s*)INFOPLIST_FILE = HelloWorld\/Info\.plist;$/gm, (line, indent: string) => {
    const value = n++ === 0 ? debug : release;
    return value === undefined ? line : `${indent}CODE_SIGN_ENTITLEMENTS = ${value};\n${line}`;
  });
}
