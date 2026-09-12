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

## Known disagreement — needs a live-server test, not a guess

`aegis-services/admin-bot/src/tools/beRcon.js` (pre-extraction) sent an **extra leading `0xFF`
byte** before the `'B' 'E'` magic bytes, i.e. wire packets of
`0xFF 'B' 'E' <crc> 0xFF <type> <data>` (7 bytes of header) instead of the
`'B' 'E' <crc> 0xFF <type> <data>` (6 bytes) that `chat-ai`'s original `protocol.js` sent and
that matches the documented BE spec. admin-bot expected the same extra `0xFF` on responses too,
so it was internally self-consistent — but it disagreed with chat-ai's framing. This package
implements the 6-byte framing only, since that's what both the spec and chat-ai's
independently-framed test fixtures agree on.

Whoever runs the next live RCON session against the real DayZ server should capture a raw hex
dump of what the server actually echoes back and settle which framing (or whether both work, if
BE's parser tolerates leading garbage) is correct.

## Tests

`test/protocol.test.js` and `test/client.test.js`, ported from chat-ai's fuller, already-passing
suite. Run with `npm test`.
