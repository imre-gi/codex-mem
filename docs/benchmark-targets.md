# Retentia Benchmark Targets

Retentia's product goal is to beat the public MemPalace memory/retrieval benchmarks while staying local-first and practical for personal coding agents.

## Competitive Gates

| Suite                      |           MemPalace reference |                                            Retentia target |
| -------------------------- | ----------------------------: | ---------------------------------------------------------: |
| LongMemEval raw / zero API |                     96.6% R@5 |                              >96.6% R@5 with no hosted API |
| LongMemEval hybrid         | 98.4% held-out / 100% stretch |   >=99% held-out, 100% stretch with documented methodology |
| ConvoMem                   |          92.9% average recall |                                      >92.9% average recall |
| LoCoMo hybrid              |                    88.9% R@10 |                                                >88.9% R@10 |
| Reranked retrieval         |   >=99% public / 100% stretch | 100% when reranking is enabled, with raw failures reported |

The honest benchmark lane is the zero-API lane. Reranking is a separate assisted lane and must never hide raw retrieval quality.

## Architecture Implications

1. Keep verbatim evidence as the source of truth.
   Retentia should store exact transcript/message/file chunks as immutable evidence, then derive compact memories and graph facts from them. Summaries are pointers and accelerators, not replacements.

2. Add a two-layer index.
   The current SQLite FTS path is useful but not enough for LongMemEval-class recall. Retentia needs a raw evidence index plus a compact symbolic/index layer for fast scoping by project, agent, task, time, person, artifact, topic, and decision.

3. Use hybrid retrieval by default.
   Retrieval should combine lexical BM25/FTS, local embeddings, metadata filters, temporal proximity, graph traversal, and task/session proximity. Each signal must be measurable and independently ablatable.

4. Make reranking optional and explicit.
   Rerank top-k candidates with a local or user-selected model only in the assisted lane. The dashboard and CLI should show raw rank, reranked rank, and why an item moved.

5. Benchmark before optimizing UI.
   The control plane matters, but beating MemPalace requires a reproducible harness first: dataset loaders, index builders, query runners, result files, and reports committed or generated deterministically.

6. Optimize for agent productivity, not benchmark gaming.
   Benchmarks are the scoreboard. The real product path is: ingest every useful agent trace, preserve exact evidence, retrieve minimal context, expose uncertainty, and let agents ask for deeper evidence only when needed.

## Near-Term Implementation Plan

1. Universal ingest: Copilot, Codex, and Claude Code transcripts/events into v2 immutable events.
2. Evidence drawers: persist verbatim chunks linked to event IDs and source offsets.
3. Hybrid retriever: FTS + local vector embeddings + metadata/time/graph boosts.
4. Evaluation harness: LongMemEval first, then ConvoMem and LoCoMo.
5. Reranker lane: optional model-based reranking over top-20 with transparent traces.
6. Dashboard metrics: recall, hit@k, token budget used, raw vs reranked deltas.

## Non-Negotiables

- Local-first by default.
- Zero API path must remain functional.
- Every generated memory must point back to verbatim evidence.
- Token-saving must be measured as context bytes/chars and approximate tokens.
- Provider support must work inside and outside VS Code.
