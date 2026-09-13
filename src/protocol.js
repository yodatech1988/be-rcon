import { crc32 } from "./crc32.js";

/**
 * BattlEye RCON packet encoding, per BERConProtocol.txt.
 *
 * Every packet is:   'B' 'E' <CRC32 of payload> <payload>
 * and every payload starts with 0xFF followed by a type byte:
 *   0x00 login           0x01 command           0x02 server message
 *
 * This framing (magic bytes, then a 4-byte little-endian CRC32 over
 * everything that follows, then the 0xFF-prefixed payload) is what
 * claude-agents/packages/chat-ai/src/protocol.js implements and tests
 * against a fake UDP server, and it's what the published BE spec describes.
 *
 * aegis-services/admin-bot/src/tools/beRcon.js sends an EXTRA leading 0xFF
 * byte before the 'B' 'E' magic (i.e. its wire packets look like
 * `0xFF 'B' 'E' <crc> 0xFF <type> <data>`, seven bytes of header instead of
 * six). That is a genuine, unresolved disagreement between the two
 * from-scratch implementations, not a typo this extraction papers over —
 * see the be-rcon README's "Known disagreement" section. Only this
 * (six-byte-header, no leading 0xFF) framing is extracted here, since it's
 * the one that matches the documented spec and the one chat-ai's own tests
 * independently frame server-to-client packets with. admin-bot's beRcon.js
 * keeps its own outer framing untouched and only imports the agreed-upon
 * crc32() and payload layout from this package.
 *
 * The spec does not state the CRC's byte order. Little-endian is what every
 * working implementation uses, and it's what this assumes — if the very
 * first login attempt gets no response despite a correct password and open
 * port, a wrong byte order here is the first thing to suspect.
 */
const MAGIC_B = 0x42;
const MAGIC_E = 0x45;
const PREFIX = 0xff;

export const PacketType = { LOGIN: 0x00, COMMAND: 0x01, SERVER_MESSAGE: 0x02 };

function framePayload(payload) {
  const header = Buffer.alloc(6);
  header[0] = MAGIC_B;
  header[1] = MAGIC_E;
  header.writeUInt32LE(crc32(payload), 2);
  return Buffer.concat([header, payload]);
}

export function loginPacket(password) {
  return framePayload(Buffer.concat([Buffer.from([PREFIX, PacketType.LOGIN]), Buffer.from(password, "utf8")]));
}

export function commandPacket(sequence, command) {
  return framePayload(
    Buffer.concat([Buffer.from([PREFIX, PacketType.COMMAND, sequence]), Buffer.from(command, "utf8")]),
  );
}

/** An empty command packet. BE drops a client that sends nothing for 45 seconds. */
export function keepalivePacket(sequence) {
  return commandPacket(sequence, "");
}

/** Server messages must be acknowledged or BE retries, then drops the client. */
export function ackPacket(sequence) {
  return framePayload(Buffer.from([PREFIX, PacketType.SERVER_MESSAGE, sequence]));
}

/**
 * Parses a received packet. Throws on anything malformed — a bad CRC means the
 * datagram is corrupt or isn't BE RCON at all, and acting on it would be worse
 * than failing.
 */
export function parsePacket(buffer) {
  if (buffer.length < 8) throw new Error("RCON packet too short");
  if (buffer[0] !== MAGIC_B || buffer[1] !== MAGIC_E) throw new Error("RCON packet missing BE magic bytes");

  const payload = buffer.subarray(6);
  const expected = buffer.readUInt32LE(2);
  if (crc32(payload) !== expected) throw new Error("RCON packet CRC mismatch");
  if (payload[0] !== PREFIX) throw new Error("RCON payload missing 0xFF prefix");

  const type = payload[1];
  const body = payload.subarray(2);

  switch (type) {
    case PacketType.LOGIN:
      return { type: "login", success: body[0] === 0x01 };

    case PacketType.COMMAND: {
      const sequence = body[0];
      const rest = body.subarray(1);
      // A multipart response is marked by a 0x00 byte followed by count and index.
      // Single-part ASCII responses never start with 0x00, which is what makes this
      // distinguishable.
      if (rest.length >= 3 && rest[0] === 0x00) {
        // `bytes` is kept so the client can join parts before decoding: a
        // multi-byte UTF-8 character can be split across two parts.
        const bytes = rest.subarray(3);
        return {
          type: "command",
          sequence,
          multipart: { count: rest[1], index: rest[2] },
          bytes,
          data: bytes.toString("utf8"),
        };
      }
      return { type: "command", sequence, bytes: rest, data: rest.toString("utf8") };
    }

    case PacketType.SERVER_MESSAGE:
      // Text is UTF-8, not ASCII: decoding as "ascii" strips the high bit and turns
      // every non-English player name and chat line into garbage.
      return { type: "serverMessage", sequence: body[0], message: body.subarray(1).toString("utf8") };

    default:
      throw new Error(`Unknown RCON packet type 0x${type.toString(16)}`);
  }
}
