# QueryLoad Threat Model

**Version 1.0 · ships with the app (D51).**

QueryLoad is a local-first RAG knowledge agent for confidentiality-sensitive
organizations. This document states plainly what QueryLoad protects against and,
just as importantly, **what it does not**. We do not overstate our guarantees.

## The honest claim (D36)

Confidential document content exists in exactly **two** places: your original
files, and **one encrypted index folder** beside them. QueryLoad never copies,
syncs, or transmits document content anywhere else. We do **not** say "we never
store your data", because that would be false. We say: your content lives in your files
and in one encrypted index, and nothing leaves the building.

## What QueryLoad protects against

- **Network exfiltration.** After installation the app makes zero network calls
  at runtime, meaning no telemetry, analytics, CDN fonts, or update pings. The only
  network activity is the explicit, user-initiated model download at first run,
  and (in organization mode) LAN traffic between clients and the office server.
  This is enforced structurally: the engine binds to loopback, the renderer's
  Content-Security-Policy forbids remote content, and a build-time audit fails
  the release if a remote network primitive appears in shipped code.
- **Data at rest.** The metadata database (all document text, file paths, chat
  history, and the audit log) is encrypted with SQLCipher. The key is sealed by
  Windows DPAPI, tied to the current user or machine. The vector index stores
  only numeric embeddings and opaque ids, never document text.
- **Transport.** All client↔engine traffic uses TLS, including on localhost.
  Clients pin the engine's self-signed certificate; the join code is the trust
  bootstrap in organization mode.
- **A hostile document.** Parsing runs in isolated worker processes; a corrupt
  or malicious file can crash a disposable worker at worst and is quarantined,
  never retried forever. Retrieved document text is always framed as quoted
  data with clear delimiters and can never be interpreted as instructions to the
  model; workspace access control is enforced in the retrieval query itself.
- **Casual local snooping.** Another local process cannot read the corpus by
  guessing the engine's port: every data request is authenticated, and the
  encrypted database is unreadable without the DPAPI-sealed key.
- **Abuse.** Login attempts are throttled with lockout after repeated failures
  (admin-unlockable). The external Engine API is disabled by default.

## What QueryLoad does NOT protect against

These are out of scope. If any of the following is true, QueryLoad's protections
can be bypassed, and no local application could honestly claim otherwise:

- **A compromised operating system.** Malware or a rootkit running with your
  privileges can read anything you can read, including decrypted content in
  memory and DPAPI-protected secrets.
- **Keyloggers and screen capture.** If your keystrokes or screen are being
  recorded, your passwords and answers are exposed regardless of QueryLoad.
- **A malicious administrator.** An admin can add users, assign workspaces, read
  the audit log, and enable the Engine API. QueryLoad enforces roles and logs
  actions, but it cannot defend against a trusted admin acting in bad faith.
- **Physical access to an unlocked machine.** DPAPI protects data at rest, but
  an attacker at your unlocked, logged-in session inherits your access.
- **Weak passwords.** Argon2id hashing protects stored credentials, but a
  guessable password undermines the account.
- **The original files.** QueryLoad encrypts its index; it does not encrypt your
  source documents. Protect those with your organization's normal controls
  (full-disk encryption, file permissions).

## Recommendations

- Keep the operating system patched and run reputable endpoint protection.
- Enable full-disk encryption (BitLocker) on machines holding sensitive files
  and the QueryLoad index folder.
- Use strong, unique passwords for QueryLoad accounts.
- Leave the Engine API disabled unless you have a specific, audited need.
- Restrict who holds the admin role.
