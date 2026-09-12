// CRC-32/ISO-HDLC (the zlib/PNG one), reflected, polynomial 0xEDB88320.
// BattlEye's RCON header carries this over the packet payload.
//
// Extracted verbatim from claude-agents/packages/chat-ai/src/crc32.js and
// aegis-services/admin-bot/src/tools/beRcon.js's own crc32() — both bots
// independently wrote the identical algorithm (same table generation, same
// reflected input/output, same final XOR), so this is a genuine agreement,
// not a choice between two implementations.
const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[n] = c;
}

/** Returns the CRC32 of `buffer` as an unsigned 32-bit number. */
export function crc32(buffer) {
  let crc = 0 ^ -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}
