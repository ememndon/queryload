# QueryLoad — Server Sizing Guide

**Version 1.0 (D74).** Guidance for provisioning a machine to run QueryLoad —
single-desktop (Pattern A) or an office server (Pattern B, organization mode).

QueryLoad runs entirely on your hardware. Two things drive sizing: the **model**
you run (which sets the memory floor) and the **corpus size + concurrent users**
(which set throughput and disk). Model requirements are equivalent to running
the same local model in comparable tools — QueryLoad adds no heavyweight
overhead of its own.

## Model memory floor (choose one active model)

| Model | Class | Min RAM | Recommended | Notes |
|-------|-------|---------|-------------|-------|
| Llama 3.2 3B | Floor tier | 8 GB | 8 GB | Lightest; works on modest laptops. |
| Qwen 2.5 7B / Llama 3.1 8B | Everyday laptop | 12 GB | 16 GB | Good general quality on a typical laptop. |
| Qwen 2.5 14B | Sweet spot | 24 GB | 32 GB | Best quality/effort balance for most firms. |
| Mistral Small 3 24B | Small server | 32 GB | 32 GB + GPU | A GPU markedly improves latency. |
| Gemma 2 27B | Small server | 32 GB | 48 GB / 24 GB VRAM | |
| Llama 3.3 70B / Qwen 2.5 72B | Office server | 48 GB + GPU | 64 GB / 48 GB VRAM | Server-grade; strongest answers. |

Below 8 GB RAM, QueryLoad refuses to run a local model. Below a model's minimum,
only the lightest model is offered.

## Corpus + indexing

- **Disk:** budget roughly the size of your documents again for the encrypted
  index and vectors (embeddings + metadata), plus the model file (2–47 GB by
  tier). Example: 20 GB of documents ≈ 20–30 GB of index.
- **Indexing time** is estimated up front per folder (sampled on your hardware).
  As a rough guide on a modern multi-core CPU: tens of thousands of documents
  index over a few hours in the background; the app remains usable meanwhile.
- **Embeddings** run on the same runtime; a GPU accelerates both indexing and
  answers.

## Organization mode (Pattern B) — server sizing by users × documents

Concurrency is served by parallel inference slots (continuous batching); a fair
queue holds overflow. These are starting points — measure with your corpus.

| Users (concurrent) | Documents | Recommended server |
|--------------------|-----------|--------------------|
| 1–3 | up to ~50k | 32 GB RAM, 8+ cores; 14B model. GPU optional. |
| 4–10 | up to ~250k | 64 GB RAM, 12+ cores, 24 GB VRAM GPU; 24–27B model. |
| 10–25 | up to ~1M | 128 GB RAM, 16+ cores, 48 GB VRAM GPU; 70B model. |
| 25+ | 1M+ | Multi-GPU server, 256 GB RAM; 70B+ model; consider a GPU inference backend. |

Notes:
- "Concurrent users" means users querying at the same instant, not total seats.
- More parallel slots need more VRAM/RAM; the admin can tune the slot count.
- Disk should comfortably exceed (documents + index + model), with headroom for
  growth and backups.
- These figures are guidance, not guarantees. Validate with a representative
  sample of your own documents before rollout.
