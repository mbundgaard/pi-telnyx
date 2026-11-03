# pi-telnyx

**A persistent voice conversation with the current Pi session, over Telnyx Conversation Relay.**

Telnyx handles the telephone connection, speech recognition and speech synthesis. This extension implements Telnyx's Conversation Relay protocol: caller transcripts become input to one explicitly mapped Pi session, caller speech interrupts its ongoing work, and public assistant text streams back for speech synthesis.

```text
Caller ⇄ Telnyx STT / TTS ⇄ wss://your-host/relay ⇄ one persistent Pi session
                                      │
                          optional Cloudflare Tunnel
```

## Behavior

- **One exact session, one active call.** Installation does not expose any session. New and forked sessions inherit no mapping.
- **Interrupt on caller input.** Every valid prompt, including partials and final-only prompts, checks ongoing call-owned work, suppresses its output and requests cancellation.
- **Submit finals only.** `last: false` is not submitted to the model. `last: true` supplies the complete transcript after cancellation settles. Partials are not concatenated.
- **Speak public text automatically.** Announcements, progress and answers share the socket. Thinking, tool arguments/results and unrelated session output are not forwarded.
- **Keep the conversation open.** Several assistant messages and tool continuations can follow an input. A speech boundary does not close the WebSocket.
- **Fail closed on ownership/authentication errors.** Input, output and pending work are bounded. Unrelated console/extension input revokes the call rather than borrowing its output channel.

Streaming means public assistant text, not necessarily a final answer. A model can speak an announcement and then call tools. A model provider that buffers output cannot provide early text deltas.

## Install

Install from the public repository:

```bash
pi install git:github.com/mbundgaard/pi-telnyx
```

Or install the published npm package **`@comput/pi-telnyx`**:

```bash
pi install npm:@comput/pi-telnyx
```

For development, use `pi install --local /absolute/path/to/pi-telnyx`.

Restart Pi or reload its extensions. The tested host is **Pi 1.4.0**, with Node **22.19+**, on Linux. Installation alone starts no listener or tunnel.

## Configure Telnyx

In the persistent session that should receive calls, ask Pi to configure Telnyx Conversation Relay on a fixed address and port, for example `127.0.0.1:43180`. Configuration leaves the mapping disabled and returns a private **relay token**.

Arrange the Telnyx connection:

- WebSocket URL: `wss://your-host/relay`.
- Telnyx `custom_parameters`: `{ "relayToken": "YOUR_RELAY_TOKEN" }`.
- Enable partial prompts where supported by the selected transcription engine.
- Authorize the telephone caller in your call-control application **before** attaching it to this session.

Telnyx's `setup` event carries those parameters as `customParameters`. The extension verifies `customParameters.relayToken` before admitting input. Tokens in URLs are not supported; phone numbers and provider session IDs are not credentials.

Ask Pi to enable the saved mapping when ready. Telnyx accounts, numbers, applications, secrets and caller authorization are deployment responsibilities; the extension does not provision them.

## Tools and local configuration

| Tool | Purpose |
| --- | --- |
| `telnyx_status` | Redacted mapping, listener, tunnel, diagnostics and call state |
| `telnyx_configure` | Save this exact session's configuration; leave disabled; return its relay token |
| `telnyx_token` | Explicitly retrieve the saved relay token without rotation or restart |
| `telnyx_enable` | Start the configured relay and optional owned tunnel |
| `telnyx_disable` | Disconnect, discard waiting input and stop owned resources; preserve configuration |

Configuration is stored under **`.pi/telnyx/`** in the project. Mapping keys are persistent Pi session IDs. Bind address and port are fixed, with no fallback ports. Loopback is the default. The configuration describes Telnyx only; there is no protocol selector.

## Optional Cloudflare Tunnel

```json
{
  "port": 43180,
  "tunnel": {
    "enabled": true,
    "tokenFile": "/absolute/protected/cloudflare-tunnel.token"
  }
}
```

Install `cloudflared` separately and ensure it is on `PATH`; remotely managed tunnels require a version supporting `--token-file`. It is not included in the npm package.

Route the public hostname to `http://127.0.0.1:43180`; upgrades use `/relay`. A protected local `configFile` is supported instead of `tokenFile`. The extension starts only its own `cloudflared` child. It does not create tunnels, edit DNS or stop independent connectors.

**The Cloudflare connector credential is not the relay token.** Never paste its contents into a conversation or tool argument. Supply only its protected file path.

## Optional Telnyx TeXML endpoint

```json
{
  "port": 43180,
  "texml": {
    "enabled": true,
    "port": 43181,
    "publicRelayUrl": "wss://your-host/relay",
    "secretName": "your_telnyx_relay_secret"
  },
  "diagnostics": { "enabled": true, "captureText": false }
}
```

Store the relay token in Telnyx's TeXML secret store under `secretName`. Route `/telnyx/relay` and `/telnyx/decline` to the separate TeXML port. Set the application's voice and fallback URLs to those paths. The public document contains a `{{#secret}}NAME{{/secret}}` reference in its `relayToken` parameter, never the credential value.

The built-in speech configuration uses English, Deepgram Flux partial prompts and speech interruption. Optional `texml.voice` accepts an exact Telnyx-prefixed voice ID from the live `/text-to-speech/voices?provider=telnyx` catalog. The default is the catalog-listed UUID-based Callie voice.

## Diagnostics

Diagnostics are disabled by default. Enable metadata with `diagnostics.enabled`; explicitly choose `captureText: true` only to include bounded caller/public-assistant text. Setup payloads, raw errors, thinking and tool payloads are excluded; known relay-token values are redacted.

Logs are protected local **`.pi/telnyx/diagnostics.jsonl`**, rotated at approximately 1 MiB with one previous file. Captured text is capped at 8 KiB per event. Hardened logging requires Linux; unsupported platforms report logging unavailable without breaking the call. Enqueued output is not a playback acknowledgment.

## Telnyx messages

Example messages after connecting to the configured relay:

```json
{"type":"setup","sessionId":"example-call","customParameters":{"relayToken":"YOUR_RELAY_TOKEN"}}
{"type":"prompt","voicePrompt":"Could you check","last":false}
{"type":"prompt","voicePrompt":"Could you check the test results?","last":true}
```

Outgoing speech:

```json
{"type":"text","token":"I'll check the results","last":false}
{"type":"text","token":".","last":true}
```

`last: true` ends that assistant message's speech text, not the call or necessarily the Pi operation. The final Unicode scalar is held to provide a nonempty final frame; preceding text streams immediately.

## Optional background pause

Each authenticated, admitted call requests a session-targeted `pi-background:pause` until **30 minutes from connection**, directly over Pi's event bus. A compatible background extension skips scheduled launches and automatic completion notifications; it does not queue them for catch-up. Running workers and saved results are unaffected. The request adds no message to the agent's context.

This integration is **best effort**, not a dependency. Missing/older background extensions, missing acknowledgments, rejection or event errors do not prevent the call. Existing unrelated-input safeguards remain active; unpaused background activity can still interrupt the call.

`telnyx_status` reports `conversation.backgroundPause`: a `state` (`confirmed`, `unconfirmed`, `rejected`, `unavailable` or `error`) and `requestedUntil`. Confirmation is acknowledgment at connection, not a reservation: another request can replace the timestamp and background reload clears it. There is no renewal or early resume on hangup. Long calls can outlive the pause.

## Operational boundaries

- Cancellation is cooperative, **not rollback**. Completed tool effects and admitted history remain. Work that ignores cancellation can continue; replacement work is fenced until settlement.
- Waiting final transcripts are volatile and bounded. Disconnect/reload discards unsubmitted input. There is no durable delivery or replay guarantee.
- Caller authentication grants access to this session, not authority to override its instructions. Keep caller trust and tool access owner-controlled.
- Filtering excludes private event types, not sensitive meaning. A secret deliberately written in public assistant text is spoken.
- Source changes require `/reload`; ordinary project-file edits do not. Reload disconnects calls. See the deployment checklist before changing package identity, configuration paths or credentials.

## Validation and documentation

```bash
npm ci
npm run validate
npm run pack:check
```

Tests use real loopback WebSockets and a real Pi SDK session with a deterministic local model provider. They cover streaming, tools, cancellation, reconnect/reload, output isolation, optional background cooperation, credentials and transport bounds.

Public Cloudflare WebSocket tests passed authentication rejection, incremental text, interruption and reconnect. An owner-operated Telnyx call in the actual Pi session confirmed audible greetings/replies after selecting the exact catalog voice ID and exercised longer output/interruption. These observations are not playback telemetry or measured quality guarantees.

- [User guide](docs/user-guide.md)
- [Telnyx Conversation Relay contract](docs/conversation-relay-spec.md)
- [Development and validation](docs/development.md)
- [Deployment checklist](docs/deployment.md)
- [Publishing and release verification](docs/releasing.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

MIT licensed.
