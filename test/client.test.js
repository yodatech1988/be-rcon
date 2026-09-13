import test from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { crc32 } from "../src/crc32.js";
import { parsePacket } from "../src/protocol.js";
import { connectRcon } from "../src/client.js";

// Frames server-to-client packets the way a real BE server would.
function frame(payload) {
  const header = Buffer.alloc(6);
  header[0] = 0x42;
  header[1] = 0x45;
  header.writeUInt32LE(crc32(payload), 2);
  return Buffer.concat([header, payload]);
}

const loginResponse = (ok) => frame(Buffer.from([0xff, 0x00, ok ? 0x01 : 0x00]));
const commandResponse = (sequence, text) =>
  frame(Buffer.concat([Buffer.from([0xff, 0x01, sequence]), Buffer.from(text, "ascii")]));
const multipartResponse = (sequence, count, index, text) =>
  frame(
    Buffer.concat([
      Buffer.from([0xff, 0x01, sequence, 0x00, count, index]),
      Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8"),
    ]),
  );
const serverMessage = (sequence, text) =>
  frame(Buffer.concat([Buffer.from([0xff, 0x02, sequence]), Buffer.from(text, "ascii")]));

/** A minimal fake BE RCON server. `onPacket` decides how to answer. */
async function startFakeServer(onPacket) {
  const socket = createSocket("udp4");
  const received = [];
  let lastRemote = null;
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));

  socket.on("message", (datagram, remote) => {
    lastRemote = remote;
    const packet = parsePacket(datagram);
    received.push(packet);
    const reply = onPacket?.(packet);
    for (const buffer of [reply].flat().filter(Boolean)) {
      socket.send(buffer, remote.port, remote.address);
    }
  });

  return {
    port: socket.address().port,
    received,
    /** Sends an unsolicited packet to the client, as the game server does for chat. */
    push: (buffer) => socket.send(buffer, lastRemote.port, lastRemote.address),
    close: () => socket.close(),
  };
}

async function waitUntil(predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the expected condition");
}

test("logs in and resolves", async () => {
  const server = await startFakeServer((packet) => (packet.type === "login" ? loginResponse(true) : null));
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  assert.equal(server.received[0].type, "login");
  rcon.close();
  server.close();
});

test("rejects a wrong password and closes the socket", async () => {
  const server = await startFakeServer((packet) => (packet.type === "login" ? loginResponse(false) : null));

  await assert.rejects(
    () => connectRcon({ host: "127.0.0.1", port: server.port, password: "wrong" }),
    /login rejected/,
  );
  server.close();
});

test("a silent port is reported as RCon probably not being enabled", async () => {
  const server = await startFakeServer(() => null);

  await assert.rejects(
    () => connectRcon({ host: "127.0.0.1", port: server.port, password: "pw", loginTimeoutMs: 100 }),
    /may not be enabled/,
  );
  server.close();
});

test("sendCommand resolves with the response body", async () => {
  const server = await startFakeServer((packet) => {
    if (packet.type === "login") return loginResponse(true);
    if (packet.type === "command") return commandResponse(packet.sequence, "Players on server:");
    return null;
  });
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  assert.equal(await rcon.sendCommand("players"), "Players on server:");
  rcon.close();
  server.close();
});

test("the first command on a connection uses sequence 0, then counts up", async () => {
  const server = await startFakeServer((packet) => {
    if (packet.type === "login") return loginResponse(true);
    if (packet.type === "command") return commandResponse(packet.sequence, "ok");
    return null;
  });
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  await rcon.sendCommand("players");
  await rcon.sendCommand("players");
  assert.deepEqual(
    server.received.filter((p) => p.type === "command").map((p) => p.sequence),
    [0, 1],
  );
  rcon.close();
  server.close();
});

test("a multipart response is reassembled in index order even when it arrives out of order", async () => {
  const server = await startFakeServer((packet) => {
    if (packet.type === "login") return loginResponse(true);
    if (packet.type === "command") {
      return [
        multipartResponse(packet.sequence, 3, 2, "third"),
        multipartResponse(packet.sequence, 3, 0, "first "),
        multipartResponse(packet.sequence, 3, 1, "second "),
      ];
    }
    return null;
  });
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  assert.equal(await rcon.sendCommand("players"), "first second third");
  rcon.close();
  server.close();
});

test("a multi-byte character split across two parts survives reassembly", async () => {
  const bytes = Buffer.from("Players: Лёша", "utf8");
  const cut = bytes.length - 1; // splits the final two-byte character
  const server = await startFakeServer((packet) => {
    if (packet.type === "login") return loginResponse(true);
    if (packet.type === "command") {
      return [
        multipartResponse(packet.sequence, 2, 1, bytes.subarray(cut)),
        multipartResponse(packet.sequence, 2, 0, bytes.subarray(0, cut)),
      ];
    }
    return null;
  });
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  assert.equal(await rcon.sendCommand("players"), "Players: Лёша");
  rcon.close();
  server.close();
});

test("a command that never gets answered rejects instead of hanging", async () => {
  const server = await startFakeServer((packet) => (packet.type === "login" ? loginResponse(true) : null));
  const rcon = await connectRcon({
    host: "127.0.0.1",
    port: server.port,
    password: "pw",
    commandTimeoutMs: 100,
  });

  await assert.rejects(() => rcon.sendCommand("players"), /timed out/);
  rcon.close();
  server.close();
});

test("a server message is emitted as chat and acknowledged", async () => {
  const server = await startFakeServer((packet) => (packet.type === "login" ? loginResponse(true) : null));
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  const chatLine = once(rcon, "chat");
  server.push(serverMessage(7, "(Global) Bob: hi"));

  const [line] = await chatLine;
  assert.equal(line, "(Global) Bob: hi");

  // BE drops a client that doesn't acknowledge, so the ack matters as much as the event.
  await waitUntil(() => server.received.some((p) => p.type === "serverMessage" && p.sequence === 7));

  rcon.close();
  server.close();
});

test("a corrupt datagram surfaces as an error rather than killing the client", async () => {
  const server = await startFakeServer((packet) => (packet.type === "login" ? loginResponse(true) : null));
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  const errored = once(rcon, "error");
  server.push(Buffer.from("not a BE packet at all", "ascii"));

  const [err] = await errored;
  assert.match(err.message, /magic bytes/);

  rcon.close();
  server.close();
});

test("sayToPlayer issues the say command for that slot", async () => {
  const commands = [];
  const server = await startFakeServer((packet) => {
    if (packet.type === "login") return loginResponse(true);
    if (packet.type === "command") {
      commands.push(packet.data);
      return commandResponse(packet.sequence, "");
    }
    return null;
  });
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  await rcon.sayToPlayer(3, "hello there");

  assert.deepEqual(commands, ["say 3 hello there"]);
  rcon.close();
  server.close();
});

test("a garbage datagram during login does not crash the process", async () => {
  // No "error" listener can exist yet, so emitting one would throw out of the socket handler.
  const server = await startFakeServer((packet) =>
    packet.type === "login" ? [Buffer.from("garbage", "ascii"), loginResponse(true)] : null,
  );
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  assert.equal(server.received[0].type, "login");
  rcon.close();
  server.close();
});

test("an unresolvable host rejects the login instead of throwing an unhandled error", async () => {
  await assert.rejects(
    () => connectRcon({ host: "no-such-host.invalid", port: 2302, password: "pw", loginTimeoutMs: 5000 }),
    /socket error/,
  );
});

test("close() rejects commands still waiting for a response", async () => {
  const server = await startFakeServer((packet) => (packet.type === "login" ? loginResponse(true) : null));
  const rcon = await connectRcon({ host: "127.0.0.1", port: server.port, password: "pw" });

  const inFlight = rcon.sendCommand("players");
  rcon.close();

  await assert.rejects(() => inFlight, /connection closed/);
  assert.doesNotThrow(() => rcon.close());
  server.close();
});
