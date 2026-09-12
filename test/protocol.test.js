import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "../src/crc32.js";
import {
  loginPacket,
  commandPacket,
  keepalivePacket,
  ackPacket,
  parsePacket,
  PacketType,
} from "../src/protocol.js";

test("crc32 matches the standard check value", () => {
  // The documented CRC-32/ISO-HDLC check value for "123456789".
  assert.equal(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("packets carry the BE magic bytes, a little-endian CRC, and the 0xFF prefix", () => {
  const packet = commandPacket(7, "players");

  assert.equal(packet[0], 0x42); // 'B'
  assert.equal(packet[1], 0x45); // 'E'
  assert.equal(packet[6], 0xff);
  assert.equal(packet.readUInt32LE(2), crc32(packet.subarray(6)));
});

test("a login packet carries the password after the type byte", () => {
  const packet = loginPacket("hunter2");

  assert.equal(packet[7], PacketType.LOGIN);
  assert.equal(packet.subarray(8).toString("ascii"), "hunter2");
});

test("a command packet carries the sequence number then the command", () => {
  const packet = commandPacket(42, "players");

  assert.equal(packet[7], PacketType.COMMAND);
  assert.equal(packet[8], 42);
  assert.equal(packet.subarray(9).toString("ascii"), "players");
});

test("a keepalive is an empty command packet", () => {
  const packet = keepalivePacket(3);

  assert.equal(packet.length, 9); // header(6) + 0xFF + type + sequence
  assert.equal(packet.subarray(9).toString("ascii"), "");
});

test("an ack echoes the server message's sequence number", () => {
  const packet = ackPacket(9);

  assert.equal(packet[7], PacketType.SERVER_MESSAGE);
  assert.equal(packet[8], 9);
});

// Server-to-client packets, framed independently of the builders above so this
// isn't just a round-trip of our own code.
function frame(payload) {
  const header = Buffer.alloc(6);
  header[0] = 0x42;
  header[1] = 0x45;
  header.writeUInt32LE(crc32(payload), 2);
  return Buffer.concat([header, payload]);
}

test("parses a successful and a failed login response", () => {
  assert.deepEqual(parsePacket(frame(Buffer.from([0xff, 0x00, 0x01]))), { type: "login", success: true });
  assert.deepEqual(parsePacket(frame(Buffer.from([0xff, 0x00, 0x00]))), { type: "login", success: false });
});

test("parses a single-part command response", () => {
  const payload = Buffer.concat([Buffer.from([0xff, 0x01, 5]), Buffer.from("Players on server:", "ascii")]);
  const parsed = parsePacket(frame(payload));

  assert.equal(parsed.type, "command");
  assert.equal(parsed.sequence, 5);
  assert.equal(parsed.multipart, undefined);
  assert.equal(parsed.data, "Players on server:");
});

test("parses a multipart command response header", () => {
  const payload = Buffer.concat([Buffer.from([0xff, 0x01, 5, 0x00, 3, 1]), Buffer.from("middle", "ascii")]);
  const parsed = parsePacket(frame(payload));

  assert.deepEqual(parsed.multipart, { count: 3, index: 1 });
  assert.equal(parsed.data, "middle");
});

test("parses a server message and its sequence number", () => {
  const payload = Buffer.concat([Buffer.from([0xff, 0x02, 11]), Buffer.from("(Global) Bob: hi", "ascii")]);
  const parsed = parsePacket(frame(payload));

  assert.equal(parsed.type, "serverMessage");
  assert.equal(parsed.sequence, 11);
  assert.equal(parsed.message, "(Global) Bob: hi");
});

test("a corrupted packet is rejected rather than acted on", () => {
  const good = frame(Buffer.from([0xff, 0x02, 1, 0x41]));
  const corrupted = Buffer.from(good);
  corrupted[corrupted.length - 1] = 0x42; // body changed, CRC now wrong

  assert.throws(() => parsePacket(corrupted), /CRC mismatch/);
});

test("rejects non-BE datagrams, short datagrams, and unknown types", () => {
  assert.throws(() => parsePacket(Buffer.from("nonsense here", "ascii")), /magic bytes/);
  assert.throws(() => parsePacket(Buffer.from([0x42, 0x45])), /too short/);
  assert.throws(() => parsePacket(frame(Buffer.from([0xff, 0x09, 1]))), /Unknown RCON packet type/);
  assert.throws(() => parsePacket(frame(Buffer.from([0x00, 0x01, 1]))), /0xFF prefix/);
});
