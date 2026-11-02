# pi-telnyx user guide

## Prerequisites

- Pi 1.4.0 and a persistent session; Node 22.19 or newer.
- A configured Pi model that produces streaming text for low-latency speech.
- An owner-authorized Telnyx call-control application using Conversation Relay.
- A trusted `wss://` endpoint, typically a reverse proxy or Cloudflare Tunnel to the loopback listener.

No listener is started solely by installation. No telephone number, Telnyx account, call-control application, DNS record or tunnel is provisioned by this extension.

## Session setup

1. Open the Pi session that should own the conversation.
2. Ask Pi to configure Conversation Relay with a fixed port (for example, 43180). The default bind address is `127.0.0.1`.
3. Save the returned **relay token** in the protected configuration of your call-control application.
4. Configure its WebSocket URL as `wss://your-host/relay` and its Telnyx `custom_parameters` object with `relayToken` set to that token.
5. Authorize the caller before connecting it to this Pi session. A public phone number is not access control.
6. Ask Pi to enable this session’s saved mapping.

Configuration leaves the listener disabled until enable is requested. Reconfiguration stops existing resources. Rotating the token is explicit; otherwise reconfiguration retains it. Routine status never returns token contents. An explicit request to retrieve the saved token does not rotate it or restart anything.

Do not put tokens in URLs. The listener waits for Telnyx’s first `setup` frame and authenticates `customParameters.relayToken`; no caller input reaches Pi before that succeeds.

## Cloudflare Tunnel

For a remotely managed tunnel, use an absolute, protected `tokenFile`. For a locally managed tunnel, use an existing absolute `configFile`. These are mutually exclusive. Example configuration arguments:

```json
{
  "port": 43180,
  "host": "127.0.0.1",
  "tunnel": {
    "enabled": true,
    "tokenFile": "/absolute/protected/cloudflare-tunnel.token"
  }
}
```

Configure Cloudflare ingress to `http://127.0.0.1:43180`. Cloudflare terminates TLS and forwards WebSocket upgrades on `/relay`. The extension does not modify remote tunnel settings.

Keep the connector token out of prompts, tool arguments, command-line arguments and source control. Only its protected file path is supplied to `cloudflared`. The connector credential and relay token serve different purposes.

If importing an already-created connector credential from an authorized handoff file, the repository’s `scripts/import-tunnel-token.mjs` utility performs a protected copy, verifies bytes and only then removes the source. Run `node scripts/import-tunnel-token.mjs /absolute/source /absolute/destination` only for an authorized handoff; never paste the credential itself into the conversation. This repository helper is not included in the installable package.

An external connector may also forward to the relay. The extension neither manages nor stops independent connectors. A tunnel status of `spawned` is not a claim that the public hostname is reachable.

## Optional extension-owned TeXML endpoint

Configure `texml: { enabled: true, port: 43181, publicRelayUrl: "wss://your-host/relay", secretName: "your_telnyx_relay_secret" }` alongside the relay port. The ports must differ. Store the same relay token in Telnyx's native TeXML secret store using the specified name; this extension does not call Telnyx administrative APIs.

Route `/telnyx/relay` and `/telnyx/decline` to the TeXML port through your tunnel. Use those URLs as the Telnyx application's voice and fallback URLs respectively. The generated XML references the provider-side secret without publishing its value. Its initial profile is English, Deepgram Flux, partial prompts and speech interruption. The extension starts/stops this HTTP listener together with its relay/tunnel resources.

## Debug logging and reload

Configure `diagnostics: { enabled: true, captureText: false }` for metadata, or explicitly set `captureText: true` to include bounded caller/public-assistant text. Read the log path/error from status. Logs use protected mode-0600 JSONL under `.pi/telnyx/`, with one rotated file. Known relay-token values are redacted; raw setup bodies, thinking and tool payloads are not logged. Text capture may still contain sensitive spoken information: keep these files private. An outgoing enqueue event is not proof of delivery or playback.

Diagnostic filesystem hardening currently requires Linux. Other platforms report diagnostic logging unavailable rather than weakening file protections. A logging failure does not crash or interrupt the call.

When developing locally, install the checkout with `pi install --local /absolute/path/to/pi-telnyx`. Run `/reload` in the existing Pi session to load it. Extension code changes need a reload; ordinary files edited by already-loaded tools do not. Reload disconnects calls, so wait for a test call to finish first.

## During a call

- The socket stays open between turns.
- Each admitted call requests a 30-minute background pause directly, without prompting the agent. This is optional/best effort: older or missing Pi Background versions do not prevent calls. Check `conversation.backgroundPause` in status for acknowledgment; an unconfirmed pause does not protect against automatic background input.
- The pause is not renewed or cleared on hangup. It can expire during a long call, be replaced by another request, or disappear on background reload. Existing unrelated-input safeguards remain active.
- Partial transcripts cancel current call-owned work but are not submitted as model input.
- A complete final transcript also cancels current work, then starts its replacement after settlement.
- Previously completed tool effects/history remain. Cancellation is not rollback.
- Public announcements, progress and answers stream automatically; no “send response” tool is necessary.
- A spoken message can be followed by tool execution and another spoken message. The stream is not restricted to provably final answers.
- Console/other-extension input revokes the call’s output authority. Its answer must not be overheard or cancelled on behalf of the caller.

Configure Telnyx partial-prompt and interruption settings according to your transcription engine. Actual barge-in/playback clearing belongs to Telnyx; pi-telnyx does not invent an undocumented audio-clear frame. DTMF is not currently converted into requests.

## Disable and shutdown

`telnyx_disable` disables the saved mapping, disconnects the call, discards waiting input and requests cancellation of call-owned work. It stops only this extension’s listener/connector. Configuration and credentials remain.

Reload and session switch similarly disconnect and fence old output. Resuming the same enabled relay mapping can restart its listener, but cannot resurrect a disconnected call. If child termination cannot be confirmed, replacement startup is blocked rather than risking duplicate exposure.

A tool or provider that ignores cancellation may continue running after the call closes. New work is not submitted over that unsettled operation. Pending input is volatile, not an at-least-once delivery queue.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Nothing listens | Persistent session? Exact mapped ID? Telnyx mapping explicitly configured? Enabled? |
| Port already occupied | Free the configured port or explicitly choose another. There is no fallback. |
| WebSocket rejected | Exact `/relay` path, no query string, no other admitted call, healthy runtime. |
| Socket closes after opening | Setup within five seconds, correct `customParameters.relayToken`, valid frame types/sizes, idle Pi session. |
| No early speech | Model/provider actually emits text deltas? A buffered provider cannot stream early. |
| Caller speech does not interrupt promptly | Enable applicable Telnyx partial prompts/interruption settings; final-only prompts cannot arrive before transcription completes. |
| New request does not start | Waiting for final transcript or old cancellation settlement; inspect redacted status. |
| Call ends after console input | Intentional isolation: unrelated session work cannot use the call’s output channel. |
| Tunnel is spawned but public access fails | Check cloudflared installation, ingress, hostname/TLS and local origin. Process existence is not reachability verification. |

Local automated tests validate protocol and Pi integration, including best-effort background pause compatibility. The owner has also confirmed audible greetings/replies during a live call after the voice-ID correction. Retest carrier/STT/TTS and interruption behavior after relevant configuration changes; local enqueue events alone are not proof of playback.
