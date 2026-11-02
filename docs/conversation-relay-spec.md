# pi-telnyx Conversation Relay contract

pi-telnyx implements Telnyx Conversation Relay for one explicitly mapped persistent Pi session.

## Ownership and activation

An explicitly configured Telnyx mapping for the exact persistent Pi session ID, with `enabled: true`, is required. New/forked sessions do not inherit it. Configuration is stored only under `.pi/telnyx/` and has no protocol selector. No configuration is created merely by loading the extension.

One mapped listener admits one authenticated call. A second call is rejected, not swapped into the existing operation. Admission requires the Pi session to be idle with no queued input or unsettled owned operation. The call remains open across operations. A new call after disconnect uses the same mapped conversation history; deployments must authorize callers accordingly.

## Optional background cooperation

After authentication and successful call admission, before returning control to caller-frame handling, request a generic pause through `pi.events`:

- Request channel `pi-background:pause`: `{ requestId, sessionId, pausedUntil }`. `requestId` is locally generated; `sessionId` is the persistent Pi session ID (not the provider's call ID); `pausedUntil` is an absolute UTC ISO timestamp computed as connection time plus 30 minutes.
- Subscribe first to `pi-background:pause:result`. Confirm only a synchronous response with matching request/session IDs, `ok: true` and the requested timestamp. A matching `ok: false` reports rejection. Discard the temporary response listener immediately after emitting; no wait, retry, model turn or context message.
- Absence/older implementation, late or malformed acknowledgment, rejection and event-bus errors all permit the call to proceed. Status/optional `background.pause` diagnostics record the fixed outcome, never another extension's response text or exception.

A compatible background implementation skips scheduled launches and automatic completion notifications while paused. It preserves worker results and already-running workers, with no catch-up of skipped activity. No early resume is sent on disconnect, and no automatic renewal is made. The integration is not a general admission lock: other input still revokes call authority; a missing/expired/overwritten pause or background reload can allow automatic activity again. Authentication, busy-session rejection and output isolation remain unchanged.

## Authentication and transport

- Fixed IP/port, default loopback; WebSocket path exactly `/relay`, no query string.
- Ordinary HTTP requests to the relay listener return 404; only the configured WebSocket path admits calls.
- Require the first frame within five seconds: `setup`, nonempty string `sessionId`, and `customParameters.relayToken` matching the saved relay token.
- Telnyx call-command configuration uses `custom_parameters`; the received setup event uses `customParameters`.
- Hash both candidate and expected tokens and use constant-time equality. Authenticate before callbacks or operation effects; do not retain the setup body, echo tokens or log frame contents.
- TLS is supplied by an external reverse proxy/tunnel. Plain `ws://` is suitable for local testing only.
- The provider session ID, caller number and URL are not authentication. The call-control service must separately authorize who may access this Pi session.
- Maximum eight pending WebSocket peers; 64 KiB input frames, 32 KiB transcript bytes and 64 KiB buffered outgoing data. Transport rate limits reject abusive message/interrupt bursts. Slow or broken output closes the call rather than silently dropping speech.
- Protocol ping/pong checks detect dead peers. Setup and transport errors have generic close reasons, not model/tool/credential details.

## Incoming handling

For **every** valid `prompt`, `interrupt`, `eagerEndOfTurn` or `turnResumed`:

1. Check current call ownership and runtime generation.
2. If this call’s operation is ongoing, silence its output immediately and request cancellation. Repeated cancellation requests are intentional and harmless.
3. Only `prompt` with `last: true` supplies a final transcript. Wait for the old operation’s settlement before submitting new work.

A final-only prompt follows the same cancel-then-submit rule. `last: false` carries the transcript-so-far; it is **not** an incremental fragment to concatenate. `last: true` replaces the partial with the complete utterance. Empty finals do not start empty model requests.

Partials/interrupts close the submission gate until a subsequent final arrives. Completed but unsubmitted utterances are retained as separate text blocks if more than one final arrives during cancellation. The volatile pending queue is bounded to 32 finals/128 KiB. A new partial does not erase an already-completed utterance. Already-admitted utterances remain in Pi history.

DTMF and unknown frames are ignored, not converted into model requests. Provider `error`, duplicate setup, invalid frames and limits close the call. These are intentionally conservative behaviors, not full support for every Telnyx feature.

## Operation attribution and cancellation

The controller creates an internal random operation ID and submits a Pi custom message (`telnyx-relay`) with that ID. Incoming payloads cannot supply routing/operation metadata. The message’s admission event establishes output authority for that call-owned operation; the transcript is bracketed by external-input trust instructions in model context.

Output is accepted only for the current, admitted, unsilenced operation and peer. Local lifecycle generation and connection identity fence late callbacks. `agent_settled` releases the operation; the controller checks actual host idle/pending state before starting a replacement. It does not assume `ctx.abort()` is an awaitable settlement acknowledgment.

Cancellation suppresses speech immediately; it is not rollback or a force-kill. Completed tool results/history are preserved, and the controller does not replay tool calls. If cancellation has not settled within ten seconds, the peer is closed and replacement remains fenced until settlement. Async submission failure closes the call instead of blindly retrying.

A console/other-extension run, steering message, follow-up or unrelated custom message revokes call output authority. This is important because queued input can join a host run without another `before_agent_start` event. Such unrelated work is not cancelled merely to serve the call. Pi-generated system/tool-loadout patches and owned tool results do not themselves revoke ownership.

## Outgoing handling

Only `message_update` events whose assistant event type is **`text_delta`** can produce speech. Never serialize complete event objects. Thinking, tool calls/arguments/results, diagnostics and unrelated-session responses are excluded.

All eligible public assistant text streams automatically: announcements, progress and answers. There is no explicit send/speak tool. A text delta is recognizably public immediately, but it cannot establish that the model has begun its final answer. Tools can follow that text.

Frames use `{ "type": "text", "token": "…", "last": false }`. Keep one trailing Unicode scalar and send it with `last: true` at a normal assistant-message end. This avoids empty final markers and buffers neither the whole message nor the whole operation. A tool continuation can produce another spoken message on the same socket.

On interruption, discard the pending trailing scalar and suppress all later output from that operation. No fabricated application-level “stop audio” command is emitted; actual caller barge-in and playback clearing depend on Telnyx’s configured speech behavior. `last` is a speech-text boundary, not playback acknowledgment, call closure or agent-operation settlement.

Provider/model failures close the call conservatively. A buffered model provider cannot emit live text before its own buffering ends. Filtering event types is not semantic data-loss prevention: sensitive information intentionally written in public assistant text is spoken.

## Lifecycle and tunnel

Disable/reconfigure/reload/session switch revokes the peer, discards waiting transcripts and requests cancellation of owned work. Listener/tunnel cleanup must complete before replacement resources start. Uncertain child termination blocks replacement. Cleanup callbacks still revoke their original admitted peer after runtime-generation invalidation; they cannot route new caller input.

The existing protected connector-token-file/config-file tunnel management is retained. Connector-token contents never enter model context or process arguments. The relay bearer token is a distinct credential and can be returned on an explicit owner request. Routine status remains redacted.

## Optional TeXML and diagnostics

A configured `texml` profile adds an owned HTTP listener on a separate fixed port. It serves only `/telnyx/relay` (fixed voice instructions using a provider-side secret reference) and `/telnyx/decline` (hangup). No relay credential is embedded in the public XML. Configuration rejects credential-bearing URLs, non-WSS endpoints, mismatched paths and unsafe secret names. TeXML ingress bodies/headers are not retained or treated as model input. This listener shares the mapping's lifecycle/generation and cleanup fence. Telnyx secret provisioning and telephone caller authorization are outside this HTTP document endpoint.

Optional diagnostics use whitelisted metadata, local timestamps and sequence values. Logs cover transport admission/rejection, input, enqueue, close, operation cancellation/settlement and TeXML fetches. Text capture is separate opt-in, bounded to 8 KiB per event; files rotate at 1 MiB with one previous file. Known relay tokens are redacted. Setup frames, invalid payloads, raw remote close reasons, thinking and tool data are never serialized. Logs do not prove audio playback and are not a durable full-transcript audit. Linux filesystem protections reject symlinks/hardlinks; unavailable logging reports a generic status error without breaking the relay.

## Validation status

Automated loopback protocol tests and real Pi 1.4.0 SDK tests cover authentication, public text streaming before completion, tool-result filtering, interruption while streaming and inside a cooperative tool, delayed cancellation settlement, final-only input, subsequent calls, queued unrelated console input, disable and reload. Additional lifecycle tests cover explicit configuration, session isolation and cleanup fences.

An isolated synthetic-provider test has additionally passed through the real public Cloudflare WebSocket endpoint: invalid/missing authentication rejection, text before completion, partial interruption, replacement after settlement, persistent connection and reconnect, with zero extension errors. This exercises TLS/tunnel transport, not a Telnyx call.

An initial authorized call verified authentication and transcription in the isolated synthetic session. After replacing the voice alias with an exact live-catalog ID, a subsequent owner-operated call in the actual Pi session confirmed audible greetings/replies and exercised longer output/interruption. This is caller-observed evidence, not protocol-level playback acknowledgment or a measured quality/latency guarantee.

Best-effort background cooperation is additionally covered by unit tests for absent/older implementations, rejected/malformed/late replies and event exceptions, plus real Pi/WebSocket scenarios with unconfirmed, confirmed and rejected pause requests.

Protocol references:
- https://developers.telnyx.com/docs/voice/programmable-voice/conversation-relay
- https://developers.telnyx.com/api-reference/call-commands/start-conversation-relay
