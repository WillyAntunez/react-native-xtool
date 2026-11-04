/**
 * The start of a PNG file, enough for rn-xtool's header check: the signature, an optional `CgBI` chunk (Apple's
 * crushed PNGs) and an IHDR chunk for `width`×`height`, with zero CRCs. Not a decodable image.
 */
export function png(width: number, height: number, o: { cgbi?: boolean } = {}): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    Buffer.from(data).copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...(o.cgbi === true ? [chunk("CgBI", [0x50, 0x00, 0x20, 0x06])] : []),
    chunk("IHDR", [...ihdr]),
    chunk("IEND", []),
  ]);
}
