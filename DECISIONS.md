# QueryLoad Design Decisions

The source code cites decisions by number (`D37`, `D79`, and so on). This file
resolves those references.

It is a **public extract**: it contains the 55 technical decisions the code
actually cites, taken verbatim from the project's internal decision log. The
full log also covers commercial matters such as licensing, pricing, roadmap
sequencing and deployment partners, none of which are published here or are
needed to read the code.

A decision recorded here is binding on the implementation. Where a comment in
the source says "(D54)", it means that code exists to satisfy the entry below,
and changing the behaviour means revisiting the decision rather than just the
code.

---

* **D10.** Updates: app **notifies** when updates are available; in server mode the **server** connects for updates and distributes to clients. Update packages are **signature-verified** with the project's own signing key before applying.
* **D14.** **Diagnostic bundle** button: one-click zip of logs, config, hardware profile; never document content; user emails it manually.
* **D18.** Local inference runtime: **llama.cpp server** embedded/managed as a hidden sidecar (never exposed to the user; no "install Ollama first").
* **D18a. How the runtime actually gets there (owner ruling, 2026-07-20).** D18 said "embedded" but nothing implemented it: no code downloaded the binary and `electron-builder.yml` did not ship it, so `activateChatModel` always threw and **the app could not answer a question on any machine**. It went unnoticed because every phase smoke uses a stub backend. Resolved as follows:
  1. **Bundled in the installer, never downloaded.** `scripts/fetch-llama-runtime.mjs` is a BUILD-TIME step that pins a llama.cpp release by tag and SHA-256, verifies it, prunes it to the ~24 files `llama-server` actually loads (~38MB), and stages it at `vendor/llama/<platform>-<arch>`. `electron-builder.yml` ships that as `resources/runtime`.
  2. **No new runtime network exception.** Because the fetch is build-time, the shipped app still makes zero network calls to obtain the runtime, and `verify:no-runtime-network` stays clean. This is the main reason bundling was chosen over on-demand download.
  3. **CPU x64 build.** Runs on any x64 machine with no driver dependency, and costs ~17MB compressed. GPU-accelerated variants (CUDA/Vulkan) remain a possible optional download later.
  4. **The build fails loudly without it.** `npm run verify:runtime` refuses to package an installer whose runtime is missing or lacks a pinned manifest, so this class of gap cannot ship silently again.
  5. `vendor/llama/` stays gitignored, because binaries are fetched, never committed.
* **D19.** Embedding model: **BGE-M3**, fixed, hidden from users, never user-selectable (changing embedders invalidates indexes). Chosen for multilingual support, 8K context, MIT license.
* **D21.** Ingestion libraries: PDF.js / MuPDF (PDF), mammoth (DOCX), Tesseract (OCR for scans/images), plus email formats (see D31).
* **D23.** Platform: **Windows 10/11 64-bit first (MVP)**; engine also configured for **Windows Server 2019/2022**, running headless as a **Windows Service** (auto-start, no logged-in user, file logging). macOS later; Linux engine-only later.
* **D25.** **Pattern B (organization mode, post-MVP phase):** engine installed on one office server/strong PC; single shared index; users connect via a **dedicated client UI, not a browser** (owner ruling: browser access feels like the internet). The server hosts the client installer on the LAN; clients **auto-discover the server** (mDNS/broadcast) and connect with a **join code**. Silent-install MSI provided for org IT tooling. (Note: software cannot push-install itself to other machines; LAN-hosted installer + auto-discovery is the agreed mechanism.)
* **D27.** Path management: Settings screen with a **path input field + "Add Path" button**; unlimited paths; **paste-first with a small Browse fallback button** (dual approach ruled).
* **D28.** **Duplicate/overlap detection:** adding a path that is identical to or nested within an existing indexed path triggers a warning instead of double-indexing.
* **D29.** Ingestion behavior: recursive walk per path; progress UI ("Indexing N documents…"); **content-hash change detection** so restarts re-index only modified files; graceful NAS/mapped-drive offline handling ("index preserved, will resume when reconnected", so it never errors and never deletes the index).
* **D31.** **Email ingestion is MVP** (owner ruling): PST/MSG/EML parsing, implemented through the plugin-style **format-handler interface** so future formats are plugins, not surgery.
* **D32.** Chunking: presets **hidden** behind document-type detection (contracts vs. medical notes vs. correspondence chunk differently); no user-facing sliders.
* **D34.** **Locality rule:** the index lives only where the source documents live. Server mode: index + metadata in an app-created folder **on the server**; client machines persist nothing (no document content, no chat cache, because chat history lives server-side under the user's account). Single-machine mode: app-created folder in AppData.
* **D35.** **No second home:** the app never copies, syncs, or transmits document content anywhere except the one index folder. Client AppData holds only UI preferences and connection config.
* **D36.** **Honest claim rule:** marketing must not say "never stores data". The truthful claim is: confidential content exists in exactly two places, the original files and one encrypted index folder beside them.
* **D37.** **Curated catalog of exactly 8 models** (no open model list; no user-added GGUFs). Approved catalog (GGUF Q4\_K\_M default; exact versions re-verified at build time):
|#|Model|Class|Min RAM|Recommended|License|
|-|-|-|-|-|-|
|1|Llama 3.2 3B Instruct|Floor tier|8GB|8GB|Llama Community|
|2|Qwen 2.5 7B Instruct|Everyday laptop|12GB|16GB|Apache 2.0|
|3|Llama 3.1 8B Instruct|Everyday laptop|12GB|16GB|Llama Community|
|4|Qwen 2.5 14B Instruct|Sweet spot|24GB|32GB|Apache 2.0|
|5|Mistral Small 3 (24B)|Small server|32GB|32GB + GPU|Apache 2.0|
|6|Gemma 2 27B Instruct|Small server|32GB|48GB / 24GB VRAM|Gemma Terms|
|7|Llama 3.3 70B Instruct|Office server|48GB + GPU|64GB / 48GB VRAM|Llama Community|
|8|Qwen 2.5 72B Instruct|Office server|48GB + GPU|64GB / 48GB VRAM|Apache 2.0|
If newer stable generations exist at build time, they may replace same-tier entries, because the catalog is data, not code.
* **D37a. Amendment (owner ruling, 2026-07-20).** **The cap of 8 is lifted.** The catalog grows to cover the freely-licensed GGUF field rather than a fixed shortlist; everything else in D37 stands (curated list, no open model browser, no user-added GGUFs, Q4\_K\_M default, data not code). Admission rules for an entry:
  1. **Free to use, including commercially**, meaning Apache 2.0, MIT, or a vendor community licence (Llama, Gemma). Non-commercial and research-only weights (e.g. Cohere Command R, EXAONE) are excluded regardless of how freely they download.
  2. **Ungated GGUF** on a reputable host, reachable without a token.
  3. **`sizeBytes` verified against the host**, not estimated, because it drives the disk-eligibility check and the download progress bar.
  4. **Works through the raw `/completion` path.** Models that require a chat template to behave (notably GPT-OSS, which needs the harmony format) are excluded until the engine applies templates.
  The catalogue now carries 23 models across all five tiers. Reasoning models (Qwen 3, DeepSeek R1 distills) are marked `reasoning: true`; their `<think>` scratchpad is stripped before the answer is shown, stored, or audited (`rag/thinking.ts`).
* **D38.** Model catalog UI shows min/recommended specs per model. On selection, the app runs a **background hardware check** (RAM, GPU/VRAM, free disk) before download.
* **D39.** Hardware floor: **below recommended specs → warn and allow with the smallest model only; below 8GB RAM → refuse** with clear explanation.
* **D40.** The hardware check also **estimates indexing time for large archives** and states it upfront ("\~40,000 documents: estimated 9 hours, runs in background").
* **D41.** **One active model system-wide.** No per-workspace models (rejected). No embedder choice (rejected).
* **D42.** **Parallel inference:** llama.cpp continuous batching with parallel slots; slot count auto-suggested from server hardware (configurable by admin); queue is **overflow behavior only**, with visible "position in line"; **per-user round-robin fairness** so one heavy user cannot starve others. Future: swappable vLLM backend for GPU servers (deferred; enabled by engine/UI seam).
* **D43.** **Encryption at rest:** SQLCipher for SQLite metadata; encrypted vector storage; keys in Windows DPAPI/Credential Manager.
* **D44.** **Transport:** TLS on all client↔engine traffic including localhost; self-signed certificate generated at install; clients pin the cert on first join (join code = trust bootstrap).
* **D45.** **Electron hardening:** `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, strict whitelisted preload API surface, CSP, no remote content loading ever. Renderer treated as untrusted.
* **D46.** **Parser isolation:** all document parsing runs in separate low-privilege worker processes; corrupt/hostile files quarantined and logged, never retried forever.
* **D47.** **Prompt-injection defenses:** retrieved chunks always framed as quoted data with clear delimiters, never as instructions; system prompt states document content cannot alter behavior; **architectural backstop**: workspace filtering happens in the retrieval query before the model sees anything; answers render as text, never executed HTML.
* **D48.** **Engine API:** exists (engine/UI seam gives it nearly free) but **disabled by default**; admin-enabled; bearer-token auth bound to a role; all API queries logged like user queries.
* **D49.** **Abuse controls:** login throttling with backoff; lockout after repeated failures (admin-unlockable).
* **D50.** **Signed updates** (D10). **Encrypted backups/exports**: config/index export is always encrypted. **Supply chain:** locked dependency versions, vulnerability scanning in build pipeline, SBOM generated at build.
* **D52.** **Local accounts** (no Active Directory in v1): admin-created users, argon2 password hashing; first install creates the admin.
* **D53.** **Three roles:** Admin (users, paths, models, retention, audit log), Member (query assigned workspaces), Auditor (read audit log only).
* **D54.** **Workspace-based permissions:** admin assigns indexed paths into workspaces; users assigned to workspaces; retrieval **hard-filtered by workspace membership at query time** (ethical walls enforced in the query, not the UI).
* **D55.** Client sessions: join code connects a device; login issues a session token; admin can revoke devices.
* **D56.** **Audit log: default ON.** Every query, answer, cited sources, and user identity, timestamped, stored locally, exportable.
* **D57.** **Retention \& purge:** document deletion purges its chunks from the index; admin-set retention clocks; **audit log has retention settings** (it contains answer excerpts).
* **D58.** **Chat history:** persists per-user per-workspace by default; admin-set retention (off/30/90/365 days) in the same settings pane as document retention; **same purge scheduler as the audit log**; users can delete their own chats anytime.
* **D59.** Rule: **no unsourced facts. Analysis encouraged, fabrication forbidden.** The model may fully reason, analyze, review, and advise ("review this case") using its intelligence applied to retrieved documents. Factual claims about the matter must trace to sources. General-knowledge content must be visibly framed as such ("As a general principle…"). When documents don't contain something, the model says so instead of inventing.
* **D61.** Document pinning (pin files to always be in context, bypassing retrieval).
* **D63.** Hidden chunking presets by document type (D32).
* **D64.** Task library of saved professional prompts ("summarize this deposition," "extract obligations").
* **D65.** Drag-and-drop a single file into a chat; **per-drop toggle**: persist to workspace index or session-only.
* **D67.** Timeline extraction (chronological event table with citations from a workspace/file set).
* **D68.** Contradiction finder (flag where documents in a workspace disagree, with sources).
* **D69.** Template drafting (draft in the org's house style from their own template/precedent bank).
* **D70.** Network status transparency: per the final design, expressed as the quiet status indicator. The earlier "trust pill/Prove-It monitor" concept is **superseded by the final design's subtle treatment** (a live network-quiet state remains available in the UI, styled per D-Design).
**Operations \& lifecycle:**
* **D71.** First-run wizard: hardware scan → model selection filtered to the machine → add first path (with indexing time estimate) → land in the demo workspace.
* **D72.** **Synthetic demo corpus** ships in-app as a try-it-instantly workspace: **two mini-corpora**: a fictional law firm matter and a fictional clinic patient file. Doubles as test suite and marketing material.
* **D73.** "Rebuild index" button; config export/import (encrypted).
* **D75.** **Dark editorial theme is the sole theme.** Near-black canvas (#0F0F0E family), hairline dividers (#262624), no gradients, no glows, no shadows.
* **D76.** **Typography is the identity:** serif for the wordmark, chat/matter titles, and all AI answer text (line-height ≥ 1.7); sans-serif for UI chrome; small uppercase letter-spaced labels for section markers (TODAY, USER INTENT, REFERENCES, PROCESSING).
* **D77.** **Palette:** cream/ivory `#EDE8DC` primary text; bright cream `#E8E4DA` for user queries; warm gray `#A8A49B` body/answer text; muted `#6E6A63` for icons/placeholders; faint `#56534D` for labels; **single red-coral accent `#E5484D`** used ONLY for references, the processing indicator, and live states. Input surface `#161615` with border `#2A2A28`.
* **D78.** **Three-region layout:** LEFT sidebar holds the QueryLoad serif wordmark, "+ NEW CHAT", search, workspace/matter selection above chat history grouped by recency (TODAY / PREVIOUS 7 DAYS), Settings + Account pinned bottom. CENTER content column holds a serif title, "USER INTENT" label block, user query, serif answer, action row (copy, thumbs up/down, share) with right-aligned timestamp, PROCESSING indicator (coral dot + label). RIGHT holds the REFERENCES rail, which is the evidence system: citation entries in coral with doc icons, hover excerpt cards, click opens source at cited page.
* **D79.** **HARD LAYOUT RULE (the flaw fix):** the composer/input field is a child of the center column's grid track, with the same track and the same max-width (\~560 to 640px) as the content, aligned with it, **never absolutely positioned, never spanning under the References rail.** This rule is binding and must be asserted in tests.
* **D80.** Left sidebar carries both navigation layers (workspaces + chats) because access control is workspace-based (D54).
* **D82.** Killer demo: index a folder of files, ask a question, get a cited answer, **disable Wi-Fi, ask again**, and everything still works.