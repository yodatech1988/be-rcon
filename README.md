# @aegis/be-rcon

Shared BattlEye RCON protocol client for The AEGIS Directive's DayZ agents. Extracted once both
`aegis-services/admin-bot` and `claude-agents/packages/chat-ai` had independent from-scratch
implementations (see each repo's `STATUS.md`/README for that history).

This is the canonical source. Both consumer repos include it as a **git submodule** at
`packages/be-rcon`:

```
git submodule add https://github.com/yodatech1988/be-rcon packages/be-rcon
```

To pull in upstream changes from a consumer repo:

```
git submodule update --remote packages/be-rcon
git add packages/be-rcon && git commit -m "Bump be-rcon submodule"
```

Only logic that is genuinely identical in intent between the two original implementations is
here: CRC32, the payload layout (`0xFF` + type byte + data), the three packet types, and a full
persistent-connection client (login, keepalive, multipart reassembly, server-message ack) ported
from chat-ai's tested implementation. Nothing DayZ-server-specific, chat-specific, or
admin-specific lives here — chat-line parsing stays in chat-ai, SFTP/broadcast tools stay in
admin-bot.

## API

```js
import { crc32, PacketType, loginPacket, commandPacket, keepalivePacket, ackPacket, parsePacket, connectRcon } from "@aegis/be-rcon";
```

- `crc32(buffer)` — CRC-32/ISO-HDLC, as BE's header checksum.
- `loginPacket(password)` / `commandPacket(sequence, command)` /
  `keepalivePacket(sequence)` / `ackPacket(sequence)` — build outbound
  packets (`'B' 'E' <crc32 LE> 0xFF <type> <data>`).
- `parsePacket(buffer)` — parse an inbound packet; throws on a bad magic,
  bad CRC, short buffer, or unknown type.
- `connectRcon({ host, port, password, ... })` — full client: connects,
  logs in, keeps the connection alive, reassembles multipart command
  responses, and acks server messages (chat). Returns an `EventEmitter`
  with `.sendCommand()`, `.sayToPlayer()`, `.close()`, and `"chat"` /
  `"error"` / `"close"` events.

See [`aegis-core/docs/OUTSTANDING.md`](https://github.com/yodatech1988/core/blob/main/docs/OUTSTANDING.md)
for this repo's open item (the framing disagreement below) in context with the rest of the
network.

## Live-confirmed protocol details (AEGIS Chernarus, 2026-09-13/14)

- **Framing:** the spec's 6-byte header (`'B' 'E' <crc32 LE> 0xFF <type> <data>`) is correct;
  login and server messages work with it. admin-bot's old extra leading `0xFF` was wrong. This
  settles the former "Known disagreement" section (claude-agents#14).
- **Sequence numbers start at 0.** The first command packet after login (a keepalive or a real
  command) must be sequence 0. A client starting at 1 logs in and receives server messages, but
  no command or keepalive is ever answered. A fix for this was pushed to be-rcon#3's branch after
  that PR had already merged, so it never reached `main` until this change.
- **Keepalive:** an empty command packet every 30 s (BE drops a client idle for 45 s).
- **Server messages:** acked with `0xFF 0x02 <sequence>` immediately; a resend of the same
  sequence is acked again but emitted once.

## Tests

`test/protocol.test.js` and `test/client.test.js`, ported from chat-ai's fuller, already-passing
suite. Run with `npm test`.
