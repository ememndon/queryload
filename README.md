<p align="center">
  <img src="logo.png" width="96" alt="">
</p>

<h1 align="center">QueryLoad</h1>

<p align="center">
  A desktop app that answers questions about your own documents —<br>
  entirely on your machine, with every answer traceable to the page it came from.
</p>

---

## What it is

Point QueryLoad at a folder of documents — contracts, case files, patient
records, correspondence — and ask questions in plain English. It reads PDFs,
Word files, emails (including Outlook archives), spreadsheets and scanned
images, and answers using only what those documents actually say.

Two things make it different from a general chat assistant:

**Nothing leaves the machine.** The language model runs locally. Confidential
files are never uploaded to anyone's servers, and the app works with the network
switched off. This is enforced, not promised: a build step fails the moment any
shipped code gains an outbound network call, with a single narrow exception for
the user-initiated model download.

**Every claim is traceable.** Answers carry inline markers that resolve to a
specific document and page, and the source opens at that page. When the
documents do not contain the answer, the app says so instead of filling the gap.

It is built for confidentiality-sensitive work: separate walled workspaces so
staff only see the matters they are assigned, role-based access, an audit trail
of who asked what and which sources were used, and independent retention rules
for documents, conversations and the audit log.

<p align="center">
  <img src="design.png" width="620" alt="The QueryLoad interface: sidebar, answer column, and references rail">
</p>

## How it works

```
Documents  ->  extract -> chunk -> embed -> encrypted local index
Question   ->  retrieve (workspace-scoped) -> assemble grounded prompt
           ->  local model (llama.cpp) -> streamed answer + citations
```

Three parts, deliberately separated:

| Part | Role |
|---|---|
| **Engine** | Node process: ingestion, index, retrieval, inference, local HTTPS API. Runs headless. |
| **Renderer** | React UI. A pure client of the engine's API — it holds no business logic. |
| **Desktop shell** | Electron. Supervises the engine, owns the window, and is the only bridge to the OS. |

The engine binds loopback over HTTPS with a self-signed certificate pinned by
fingerprint, so the renderer trusts exactly one certificate and nothing else.
Text and vectors are stored separately: the vector index holds no document text,
and the metadata database is encrypted with a key sealed to the machine by
Windows DPAPI.

Retrieved document text is fenced inside delimiters derived from a hash of the
query and the retrieved passages, so no single document can predict the fence
and break out of its quoted block to be read as instructions. Access control is
enforced inside the retrieval query itself rather than filtered afterwards.

## Repository layout

```
packages/
  shared/     API contract types, constants, design tokens (no runtime deps)
  engine/     ingestion, extraction, index, retrieval, inference, API server
  ui/         React renderer
  desktop/    Electron main, preload, engine supervisor, OS integration
scripts/      build tooling + 8 acceptance suites + the network audit
corpus/       synthetic demo documents (fictional; shipped for the first-run demo)
docs/         threat model, deployment, sizing
DECISIONS.md  the design decisions the source code cites by number
```

## Running it

Requires Windows and Node 22+ (see `.nvmrc`).

```bash
npm ci
npm run fetch:runtime      # downloads + checksum-verifies the llama.cpp runtime
npm run build
npm start                  # launches the desktop app
```

Then choose a model in the app. The catalogue offers **23 models from 0.8 GB to
44 GB**, every one under a licence permitting commercial use. The app checks
RAM, CPU and free disk first and marks which will actually run well.

Verification:

```bash
npm run verify:all         # build, typecheck, lint, network audit,
                           # 8 acceptance suites, UI layout test
```

## Engineering notes

Files a reviewer might find worth a look:

- **`scripts/verify-no-runtime-network.mjs`** — the privacy claim as a build
  gate rather than a README assertion.
- **`packages/engine/src/rag/prompt.ts`** — grounded prompt assembly and the
  deterministic prompt-injection fence.
- **`packages/engine/src/rag/thinking.ts`** — a streaming filter that strips
  reasoning models' scratchpad before it can reach the answer, the transcript or
  the audit log, handling markers split across token boundaries.
- **`packages/engine/src/inference/scheduler.ts`** — parallel slots with
  per-user round-robin fairness, and separate budgets for time-to-first-token
  and mid-stream stalls.
- **`packages/engine/src/db/schema.ts`** — versioned migrations, with the schema
  version derived from the migration list rather than hand-maintained.
- **`scripts/fetch-llama-runtime.mjs`** — build-time runtime fetch pinned by tag
  and SHA-256 and pruned to the files actually loaded, which is what keeps the
  shipped app free of any runtime network call.

**Scale:** ~11,700 lines across 108 TypeScript source files; 121 assertions
across 8 acceptance suites, run by a single command.

## Status

**Built and working; not shipped.** The app runs, indexes documents and returns
grounded, cited answers from a local model. What is *not* done:

- No signed installer has been produced. Packaging is configured and its parts
  proven individually, but no release build exists yet.
- Model checksums are not yet pinned in the catalogue (`sha256: null`), so
  downloads are size-verified but not hash-verified.
- Answer quality depends heavily on the chosen model. Small models (1–3 B) will
  sometimes misstate what a document says — a property of the models, and a
  large part of why the citation trail matters.
- Windows only. macOS and Linux are not built.

This repository is a public extract of a private working repository: source,
build tooling, tests and design decisions are here; commercial planning
documents are not.

## Licence

No licence is granted. Published for review and evaluation.
