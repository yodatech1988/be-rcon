import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { loginPacket, commandPacket, keepalivePacket, ackPacket, parsePacket } from "./protocol.js";

// BE removes a client that sends no command for more than 45 seconds.
const KEEPALIVE_MS = 30_000;

/**
 * Connects and logs in to BattlEye RCON over UDP. Generic across any game
 * server that speaks BE RCON — nothing DayZ-, chat-, or admin-specific here.
 *
 * Extracted from claude-agents/packages/chat-ai/src/rcon.js, which is the
 * fuller of the two independent implementations (persistent connection,
 * keepalive, multipart reassembly, server-message ack). admin-bot's
 * src/tools/beRcon.js intentionally stays single-shot (connect, one command,
 * disconnect) rather than adopting this client, since admin-bot only fires
 * occasional restart/broadcast commands and its own outer packet framing
 * disagrees with this package's (see protocol.js's header comment) — that
 * disagreement is left in place rather than resolved here.
 *
 * Resolves to an emitter with:
 *   .on("chat", line)        raw server message text (chat and everything else)
 *   .on("error", err)        socket or protocol error
 *   .on("close")             socket closed
 *   .sendCommand(command)    resolves with the response text
 *   .sayToPlayer(slot, text) whisper — privacy is UNCONFIRMED, see chat-ai's README
 *   .close()
 */
export async function connectRcon({
  host,
  port,
  password,
  logRaw = false,
  loginTimeoutMs = 5_000,
  commandTimeoutMs = 10_000,
  keepaliveMs = KEEPALIVE_MS,
}) {
  const socket = createSocket("udp4");
  const emitter = new EventEmitter();

  let sequence = 0;
  // Sequence numbers are a single byte. At this traffic level a wrap can't collide
  // with an outstanding command, but that's the assumption being made.
  const nextSequence = () => {
    sequence = (sequence + 1) % 256;
    return sequence;
  };

  const pending = new Map(); // sequence -> { resolve, reject, timer, parts }
  let keepaliveTimer = null;
  let loginSettled = false;
  let socketClosed = false;

  const send = (packet) => socket.send(packet, port, host);

  // dgram throws if close() is called twice, and a login failure can race a caller's close().
  const closeSocket = () => {
    if (socketClosed) return;
    socketClosed = true;
    socket.close();
  };

  // EventEmitter throws (crashing the process) when "error" is emitted with no listener. Until
  // connectRcon resolves the caller cannot have attached one, so a stray datagram during login
  // must not be fatal; after that, errors go to whoever listens.
  const emitError = (err) => {
    if (emitter.listenerCount("error") > 0) emitter.emit("error", err);
  };

  function settleCommand(sequenceNumber, text) {
    const waiter = pending.get(sequenceNumber);
    if (!waiter) return; // keepalive responses, or a late duplicate
    clearTimeout(waiter.timer);
    pending.delete(sequenceNumber);
    waiter.resolve(text);
  }

  const loginResult = new Promise((resolve, reject) => {
    // A failed login must not leave the socket open: callers retry, and leaked
    // handles would also stop the process from ever exiting.
    const failLogin = (message) => {
      loginSettled = true;
      clearTimeout(loginTimer);
      closeSocket();
      reject(new Error(message));
    };

    const loginTimer = setTimeout(() => {
      if (loginSettled) return;
      failLogin(
        `No RCON response from ${host}:${port} within ${loginTimeoutMs}ms. BE RCon may not be enabled, or the port may be closed.`,
      );
    }, loginTimeoutMs);

    socket.on("message", (datagram) => {
      if (logRaw) console.log("RCON <-", datagram.toString("hex"));

      let packet;
      try {
        packet = parsePacket(datagram);
      } catch (err) {
        emitError(err);
        return;
      }

      if (packet.type === "login") {
        if (loginSettled) return;
        if (!packet.success) {
          failLogin("RCON login rejected — wrong password.");
          return;
        }
        loginSettled = true;
        clearTimeout(loginTimer);
        keepaliveTimer = setInterval(() => send(keepalivePacket(nextSequence())), keepaliveMs);
        resolve();
        return;
      }

      if (packet.type === "serverMessage") {
        // Acknowledge first: BE retries an unacknowledged message and then drops
        // the client, so this must not wait on any handler.
        send(ackPacket(packet.sequence));
        emitter.emit("chat", packet.message);
        return;
      }

      if (packet.type === "command") {
        if (!packet.multipart) {
          settleCommand(packet.sequence, packet.data);
          return;
        }
        const waiter = pending.get(packet.sequence);
        if (!waiter) return;
        waiter.parts.set(packet.multipart.index, packet.data);
        if (waiter.parts.size === packet.multipart.count) {
          const joined = Array.from({ length: packet.multipart.count }, (_, i) => waiter.parts.get(i) ?? "").join("");
          settleCommand(packet.sequence, joined);
        }
      }
    });

    // A socket error before login (e.g. an unresolvable host) fails the login instead of
    // surfacing as an unhandled "error" event.
    socket.on("error", (err) => {
      if (!loginSettled) {
        failLogin(`RCON socket error connecting to ${host}:${port}: ${err.message}`);
        return;
      }
      emitError(err);
    });
  });

  socket.on("close", () => {
    socketClosed = true;
    emitter.emit("close");
  });

  send(loginPacket(password));
  await loginResult;

  emitter.sendCommand = (command) =>
    new Promise((resolve, reject) => {
      const mySequence = nextSequence();
      const timer = setTimeout(() => {
        pending.delete(mySequence);
        reject(new Error(`RCON command timed out after ${commandTimeoutMs}ms: ${command}`));
      }, commandTimeoutMs);
      pending.set(mySequence, { resolve, reject, timer, parts: new Map() });
      send(commandPacket(mySequence, command));
    });

  // Whether this is private or broadcast with a per-player label is UNCONFIRMED —
  // see chat-ai's README before relying on it for anything sensitive.
  emitter.sayToPlayer = (slot, text) => emitter.sendCommand(`say ${slot} ${text}`);

  emitter.close = () => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    // Reject in-flight commands; otherwise their promises never settle and callers hang.
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("RCON connection closed before the command was answered"));
    }
    pending.clear();
    closeSocket();
  };

  return emitter;
}
