# pi-telnyx development

## Setup and validation

```bash
npm ci
npm run validate
npm run pack:check
```

The checked-in Pi development host is 1.4.0. CI exercises Node 22/24 on Linux. The public repository distributes `@comput/pi-telnyx`; see [releasing](releasing.md) for tag-triggered npm publication. Wildcard host peer dependencies follow Pi's package-loading convention; they are not a claim that all Pi versions are supported.

Tests are local and deterministic. They need neither a model API key nor Telnyx/Cloudflare credentials. Do not reuse private project mappings or live connectors in automated tests.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/config.ts` | Protected atomic per-session Telnyx mappings and distinct relay bearer tokens |
| `src/relay-transport.ts` | WebSocket upgrade, setup authentication, strict parsing, bounds and socket ownership |
| `src/conversation.ts` | Call/operation attribution, cancellation settlement, final transcript admission and text streaming |
| `src/index.ts` | Pi lifecycle/events and five Telnyx administrative tools |
| `src/runtime.ts` | Serialized listener/tunnel configuration, activation and cleanup |
| `src/ownership.ts` | Uncertain retired-resource fence surviving extension-factory reload |
| `src/tunnel.ts` | Owned cloudflared child with protected config/token-file inputs |
| `src/texml.ts` | Optional owned TeXML listener with provider-side secret references, no public credential values |
| `src/diagnostics.ts` | Bounded protected JSONL, opt-in text capture, metadata whitelist and known-secret redaction |
| `src/background-pause.ts` | Best-effort background pause request without context messages or a required dependency |

This package implements Telnyx Conversation Relay. Keep configuration and lifecycle logic focused on that contract.

## Important invariants

1. Exact persistent session + explicit relay configuration + enabled mapping before listening.
2. Authenticate setup before any operation-affecting callback. Provider IDs are metadata, not authorization.
3. One admitted call. Reject rather than replace. New work must not overlap unsettled old work.
4. Every incoming caller prompt checks ongoing ownership and cancellation, including final-only input.
5. Final transcripts replace partials. Completed pending utterances are bounded and retained separately.
6. Only current admitted call-owned `text_delta` events produce outgoing text. Never serialize the containing event.
7. Unknown/custom/user input joining a run revokes call output authority before its answer; never abort that unrelated work merely for the call.
8. `ctx.abort()` is a request, not an awaitable settlement barrier. Wait for `agent_settled`, check actual idle/pending state and fail closed on uncertainty.
9. Transport invalidation must still perform original-peer cleanup. Fencing new traffic must not suppress disconnect cleanup callbacks.
10. Token contents stay out of status/errors/logs. The explicitly returned relay token is distinct from the private connector credential.
11. Cleanup failure blocks replacement resources. Never stop independently owned tunnels.

## Test coverage

- `relay-transport.test.ts`: real loopback WebSockets; setup auth, invalid input, pending-peer and time/size/rate bounds, second-peer rejection, output protocol, stale generation, ordinary HTTP rejection and cleanup.
- `relay-integration.test.ts`: real Pi SDK and deterministic streaming provider; first output before model completion, Unicode preservation, announcements plus actual tool execution, private-event filtering, delayed abort, partial/final-only interrupts, cancellation inside a cooperative tool, no tool replay, new call, queued console follow-up isolation and reload.
- `background-pause.test.ts`: optional event acknowledgment, absent/older background, malformed/late replies and exception safety.
- `pi-streaming.test.ts`: separate host probes for an incremental versus deliberately buffered provider.
- `diagnostics.test.ts`: opt-in capture, UTF-8 bounds, known-token redaction, rotation, private permissions and filesystem attack rejection. Hardened diagnostics currently require Linux.
- `texml.test.ts`: fixed public document routes, secret-reference validation, request-data exclusion and owned lifecycle cleanup.
- `runtime.test.ts`: explicit Telnyx configuration, unmapped startup, token retention/rotation/redaction, late-listener fencing, uncertain tunnel cleanup and serialized configuration updates.
- `publication.test.ts`: strict package allowlist, metadata validation and loading the extracted npm artifact.
- `ownership.test.ts`, `package.test.ts`, `credential-import.test.ts`, `tunnel-token.test.ts`: retained ownership, persistent-session, package-loading and protected credential behavior.

Synthetic text marked private in tests is fabricated fixture data, never a real credential. Production credential files and `.pi/` are excluded from packaging and version control.

## Live validation still required

Simulated frames validate our implementation, not carrier behavior. Before claiming live readiness, use an authorized call to verify:

- Telnyx forwards the configured token into the setup frame.
- Public `wss://` upgrade reaches the intended fixed loopback origin.
- The selected transcription engine supplies the expected partial/final semantics.
- Caller speech interrupts existing TTS playback as configured.
- Multiple public assistant messages and their `last` boundaries sound correct.
- Model/tool latency and cancellation behavior are acceptable.

Do not treat synthetic-provider or tunnel tests as live-call playback evidence. Do not introduce live telephony costs or attach new public callers without authorization.

## Dependency audits

Run `npm audit --omit=dev` separately from the full development audit. The Pi development host has reported moderate transitive `minimatch` advisories; do not describe a full audit as clean without checking the current lockfile. Changes to host dependencies require rerunning the real-SDK tests.
