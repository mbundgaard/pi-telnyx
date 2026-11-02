# pi-telnyx deployment checklist

## Fresh installation

1. Install the reviewed pi-telnyx checkout into Pi and start a persistent session.
2. Use `telnyx_configure` to create that session's mapping under `.pi/telnyx/config.json`. Configuration is disabled until explicitly enabled.
3. Keep the returned relay token private. Arrange Telnyx's `custom_parameters.relayToken`, or store the token in Telnyx's TeXML secret store and use the extension-owned document.
4. Configure TLS and the intended hostname/ports. Authorize telephone callers before attaching them to this session.
5. Use `telnyx_enable`, inspect `telnyx_status`, then test an owner-authorized call.

Installation does not provision a telephone number, application, DNS record, tunnel or provider secret. Those resources require separately authorized setup.

## Replacing an active installation

Package identity, local storage paths, tool names, runtime ownership identifiers and the setup credential parameter are deployment contracts. Source edits do not update a running Pi instance or its provider configuration. For this identity change, use a **controlled stop and fresh process start**, not a hot reload over uncertain resource ownership.

1. Finish the call and stop the currently installed extension using its loaded tools. Verify its listener and owned connector have actually stopped. If cleanup is uncertain, do not start a replacement or kill unrelated processes.
2. Preserve a protected backup of the session mapping and credentials. Do not print tokens, include them in command arguments, or copy them into documentation.
3. Prepare `.pi/telnyx/config.json` explicitly for the **same persistent session ID**. Use the schema below, retain the authorized relay token and Telnyx speech settings, and leave `enabled: false`. There is no automatic discovery, import, compatibility alias or migration tool.
4. Preserve directory mode `0700` and file mode `0600`. Keep connector credentials protected. If a credential file is moved, update its absolute `tokenFile` path; moving a directory alone does not fix stored paths. Never rotate the relay token implicitly.
5. Close the previous Pi process after confirmed resource cleanup, install the reviewed checkout and resume the intended persistent session. Changing the checkout location must not accidentally create a different owning session. Update the local package installation path if the checkout moves.
6. Ensure the Telnyx setup frame supplies **`customParameters.relayToken`**. Call-command configuration uses `custom_parameters.relayToken`. The extension-owned TeXML document emits this parameter automatically after deployment; externally managed documents/call commands must be updated explicitly. The secret's stored value can remain unchanged when the relay token is preserved.
7. Confirm the mapping and private file paths, enable explicitly, verify the public TeXML/WebSocket routes and test an authorized call. Do not change the assigned number, application, hostname or tunnel merely for a package rename.

Use this configuration structure; the token placeholder below is intentionally not a valid credential:

```json
{
  "version": 1,
  "sessions": {
    "EXACT_PERSISTENT_SESSION_ID": {
      "enabled": false,
      "host": "127.0.0.1",
      "port": 43180,
      "token": "PRESERVE_THE_AUTHORIZED_RELAY_TOKEN"
    }
  }
}
```

Optional mapping fields are `tunnel`, `diagnostics` and `texml`, as described in the user guide. Unexpected mapping fields are rejected. Each configuration is exclusively for Telnyx Conversation Relay.

Repository hosting, checkout-directory renames, package installation and live deployment are separate operations. Verify the intended repository exists before distributing its install URL; package metadata is not evidence of a completed repository rename or publication.

## Post-deployment checks

- Exactly the five `telnyx_*` administrative tools are loaded.
- The intended persistent session owns the mapping and the fixed ports are ready.
- Status and diagnostic output do not contain credentials.
- Telnyx setup authentication succeeds, partial/final input behaves correctly, and public replies are audible.
- Unrelated input still revokes call output authority.
- Background pause is optional: an unconfirmed/rejected pause must not itself reject a call. It provides no guarantee against other sources of session input.
- Only claim live success after the owner confirms what was heard; enqueue logs are not playback acknowledgments.
