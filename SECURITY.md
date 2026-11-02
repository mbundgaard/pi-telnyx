# pi-telnyx security policy

## Reporting

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/mbundgaard/pi-telnyx/security/advisories/new). Do not include real relay tokens, connector credentials, private transcripts or session files in public issues.

## Supported version

The current development line is pi-telnyx 0.2, implementing Telnyx Conversation Relay.

## Trust boundary

A valid relay token grants access to an explicitly mapped Pi conversation and its enabled tools. It is **not** a public anonymous voice-assistant boundary. Authorize telephone callers in the call-control application before connecting them to an owner session, and isolate sessions for different trust domains. Subsequent calls to the same mapping share the existing history.

The extension authenticates the first WebSocket setup frame before admitting input, then attributes generated output to one call-owned operation. Call/session IDs and caller numbers are not authentication. TLS must be provided by a trusted reverse proxy/tunnel; loopback is the default bind address.

Authenticated transcripts are still external input, not system instructions or evidence of approval. Model-context trust notices help identify their origin but cannot replace appropriate tool permissions, caller authorization and human security controls.

Only typed public assistant text deltas are forwarded. Thinking events, tool payloads/results and unrelated session output are excluded. This is **not** semantic secret detection: a secret deliberately included in public assistant text will be spoken. Treat enabling the channel as authorization to hear the session’s public responses.

## Data handling and platform scope

Telnyx processes call audio, transcription and speech synthesis. Admitted caller transcripts become part of persistent Pi session history and are processed by the session's configured model provider. An optional tunnel provider handles transport. Disabling diagnostic text capture does not remove these data flows or erase Pi history. Apply your providers' retention policies and protect the session files as well as extension configuration.

Linux is the validated deployment platform. POSIX file modes protect credentials there. Windows ACL protection has not been validated; do not assume Unix permission guarantees apply on Windows. Hardened diagnostics are Linux-only and fail closed elsewhere.

## Credentials

- The relay bearer token is saved in protected project configuration. Administrative tools return it only as an intentional credential-bearing result; ordinary status/errors remain redacted. Do not share a transcript containing the token publicly.
- The Cloudflare connector token is a separate credential. It is read by cloudflared from a protected file and must never enter model context, process arguments or repository contents.
- Never pass tokens in WebSocket URLs. Avoid recording complete setup frames in reverse-proxy/application logs.
- Configuration and `.pi/` files are excluded from package publication. Preserve file permissions and restrict access to the owning OS user.

## Cancellation and availability

Cancellation is cooperative, not rollback or process termination. Completed tool effects/history remain. The controller suppresses late output immediately and refuses overlapping replacement work, but a misbehaving tool can continue running after a disconnect.

Transport and pending-work limits bound memory and abuse. They do not provide a comprehensive internet-facing denial-of-service defense: use upstream network/access controls. Authentication happens after WebSocket upgrade, within a five-second deadline; unauthenticated peers can briefly consume bounded socket resources.

Only owned listeners/tunnel children are stopped. Uncertain cleanup blocks replacement. A spawned connector is not proof of public reachability or authorization.

## Validation limits

Automated tests cover Telnyx WebSocket behavior and Pi host integration. Public-tunnel tests establish transport behavior; an owner-operated live call also confirmed audible greetings/replies and exercised longer output/interruption after selecting the catalog voice ID. Neither enqueue logs nor these observations provide a playback guarantee for future calls. Keep production rollout scoped to authorized callers and retest after relevant deployment changes.

Optional diagnostics may contain private spoken content when text capture is enabled. They are bounded, protected local files—not a public log or durable audit. Known relay-token values are redacted, and setup/invalid frames, thinking and tool payloads are excluded. Do not publish logs merely because credential fields are filtered.

The optional public TeXML document contains a provider-side secret reference, not its value. That protects credential disclosure but does not authenticate individual telephone callers. A phone number routed to this application can reach the mapped session: restrict caller access in the deployment before exposing a privileged session beyond owner-authorized testing.
