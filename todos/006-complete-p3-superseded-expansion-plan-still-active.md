---
status: complete
priority: p3
issue_id: "006"
tags: [code-review, docs, planning, workflow]
dependencies: []
---

# Superseded Expansion Plan Still Marked Active

The narrow expansion-only Copilot plan remains checked in with `status: active`, even though the broader repo-wide migration plan explicitly superseded it.

## Problem Statement

The current branch has two Copilot migration plan documents. The broader plan says it supersedes the earlier narrow plan, but the earlier document still presents itself as active work. That makes it look like the branch has an unfinished second implementation track even though the repo-wide migration is the authoritative plan.

## Findings

- `docs/plans/2026-04-20-refactor-route-all-anthropic-usage-through-github-copilot-plan.md:21` explicitly states that it supersedes the earlier narrow expansion-only plan.
- `docs/plans/2026-04-20-refactor-github-copilot-oauth-expansion-provider-plan.md:1-5` still has `status: active`.
- Because the user asked for review “vs the plans,” this stale status creates avoidable ambiguity about what is considered done.

## Proposed Solutions

### Option 1: Mark the narrow plan as superseded in frontmatter and overview

**Approach:** Change its status to `superseded` or `completed`, and add a one-line pointer to the broader plan.

**Pros:**
- Keeps the historical planning trail
- Removes ambiguity for future reviews

**Cons:**
- Minor documentation-only change

**Effort:** Small

**Risk:** Low

---

### Option 2: Add a note at the top without changing the frontmatter status

**Approach:** Leave the original metadata intact but prepend a clear “superseded by …” banner.

**Pros:**
- Minimal metadata change
- Preserves the original artifact exactly

**Cons:**
- Still leaves the stale `active` status in machine-readable form

**Effort:** Small

**Risk:** Low

## Recommended Action

Update the narrow plan document so both humans and tooling can see that it is no longer the live implementation target.

## Technical Details

**Affected files:**
- `docs/plans/2026-04-20-refactor-github-copilot-oauth-expansion-provider-plan.md`

## Acceptance Criteria

- [x] The narrow expansion-only plan is clearly marked superseded
- [x] Future reviewers can identify the broader Copilot migration plan as the single authoritative implementation plan

## Work Log

### 2026-04-20 - Review finding

**By:** Codex

**Actions:**
- Compared the current branch state against both Copilot-related plan documents
- Verified the broad plan supersedes the narrow one, but the narrow plan still reports `status: active`

**Learnings:**
- The implementation largely tracks the broader plan
- The remaining mismatch is now mostly plan-status hygiene rather than runtime code

### 2026-04-20 - Fixed

**By:** Codex

**Actions:**
- Changed the narrow expansion-only plan status from `active` to `superseded`
- Added an explicit pointer to the broader repo-wide Copilot migration plan

**Learnings:**
- Small plan-status mismatches can make a finished branch look incomplete during review
