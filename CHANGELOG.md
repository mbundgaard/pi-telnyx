# Changelog

## 0.2.1 — Trusted Publishing

- Prepare the patch release through the configured GitHub/npm Trusted Publisher with provenance and exact-artifact verification.
- Update installation documentation now that the npm package is available.
- Runtime behavior is unchanged from 0.2.0.

## 0.2.0 — pi-telnyx

- Implement Telnyx Conversation Relay at WebSocket `/relay` for one explicitly mapped persistent Pi session.
- Authenticate Telnyx setup using `customParameters.relayToken`; admit only one call at a time.
- Provide `telnyx_status`, `telnyx_configure`, `telnyx_token`, `telnyx_enable` and `telnyx_disable`, with protected session configuration under `.pi/telnyx/`.
- Check ongoing call-owned work on every caller prompt, including partial and final-only messages. Submit complete transcripts only after cancellation settles.
- Stream public assistant text automatically, including announcements and tool continuations, with message-level speech boundaries.
- Suppress thinking, tool payloads/results, cancelled output and unrelated session responses.
- Bound connection setup, input, output and pending transcripts; preserve fixed-port and owned-resource lifecycle controls.
- Support an optional owned Cloudflare Tunnel using protected connector files.
- Serve optional Telnyx TeXML instructions using provider-side secret references and exact catalog voice identifiers.
- Offer protected rotating diagnostics with explicit caller/public-text capture.
- Request an optional acknowledged background pause on admitted calls. Missing or incompatible background implementations remain best effort, without context messages, retries or catch-up.
- Validate through loopback WebSocket tests, real Pi SDK tests, public-tunnel tests and owner-operated live Telnyx calls.
