# ADR 0003: Route knowledge automatically and favor usefulness

- **Date:** 2026-07-24
- **Decision:** Accepted

## Context

The system serves one operator whose life and work do not divide cleanly into source-based domains.
Binding each intake source to one brain or requiring review for every promotion would reduce usefulness and create queues that can stall.
At the same time, multiple brains remain valuable for separating personal, company, employer, and service knowledge.

## Decision

A content classifier may select any configured brain based on what an evidence item concerns.
Eligible items promote automatically by default.

When the classifier is uncertain, it will route the item to the personal brain with a visible ambiguity marker rather than block ingestion.
The operator may later correct the assignment.
A correction moves and reprocesses the evidence in the selected brain, supersedes the incorrect copy, and becomes labeled classifier feedback.

This is a usefulness-first starting posture.
Source allowlists, mandatory approvals, or stronger domain gates may be added only after observed misrouting shows they are warranted.

## Consequences

- Most knowledge becomes available without human review.
- Ambiguous knowledge remains searchable and visibly uncertain.
- The personal brain becomes the fallback for cross-domain uncertainty.
- Wrong routing is an expected recoverable state rather than an exceptional pipeline failure.
- Correction behavior and eval capture are required parts of routing, not optional cleanup.

## Rejected Alternatives

### Bind each source to one brain

This is easy to secure but handles mixed conversations, email, and cross-domain activity poorly.

### Restrict classification to per-source allowlists

This limits damage from classification errors but is likely to reject useful cross-domain items before observed risk justifies the friction.

### Hold uncertain items for review

This avoids speculative filing but creates another queue that can stall and makes captured information temporarily unavailable.
