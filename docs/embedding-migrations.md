# Switching embedding models or dimensions on an existing brain

GBrain stores embeddings in a fixed-dimension `vector(N)` column on
`content_chunks`. If you switch to a model with a different dimension
(e.g. `openai:text-embedding-3-large` 1536 → `zeroentropyai:zembed-1`
1280, or `voyage:voyage-4-large` 2048), the on-disk column type doesn't
change automatically.

`gbrain init`, `gbrain doctor`, and `gbrain embed --stale` all detect
this mismatch and refuse to silently proceed. This doc is the recipe
they point at.

## Same-dimension model swaps and identity

If you switch to a different model at the **same** dimension count
(e.g. one 1536-dim provider to another, or a re-tuned model that keeps
its width), the column type doesn't change, so no `ALTER`/wipe recipe
is needed. GBrain stamps a versioned embedding-provenance signature onto
each fully embedded page. It binds the exact provider/model, dimensions,
active column, and document-side preprocessing contract. Chunk rows retain
the same fully qualified provider/model.

After you point the config at a new model, a dry run previews signature
drift and an explicitly requested live run re-embeds those pages:

```bash
# After switching to the new same-dim model in your config:
gbrain embed --stale          # re-embeds signature-drifted pages
gbrain embed --stale --dry-run # preview the count without re-embedding
```

Under federated_v2, the same drift is picked up by the per-source
`embed-backfill` jobs that `gbrain sync --all` enqueues (capped
`$X/source/24h`).

Legacy pages with a NULL or v1 (`<provider:model>:<dims>`) signature are not
silently treated as compatible. They remain excluded from automatic
signature invalidation so an upgrade cannot trigger an unapproved
whole-corpus rewrite, but semantic retrieval fails closed for that
unprovable cohort. Lexical retrieval remains available. Inventory and
migrate such a cohort with a separate, bounded re-embedding plan; do not
relabel legacy vectors without recomputing them.

A **dimension** change still requires the wipe-and-reinit (PGLite) or
column-alter (Postgres) recipe below — the on-disk `vector(N)` width
genuinely has to change.

## Why we don't do this automatically

Switching dimensions requires:

1. Dropping the HNSW vector index (pgvector won't survive an `ALTER COLUMN TYPE`).
2. Wiping every existing embedding (the old vectors are unusable in the new space — and pgvector refuses to cast them across dimensions, so this must happen before the alter).
3. Altering the column type (Postgres only — PGLite cannot do this).
4. Re-embedding the entire corpus (can take hours on a 50K-page brain and costs $1-100 in API calls depending on model).
5. Conditionally recreating the index (`vector` HNSW supports up to 2000
   dimensions; `halfvec` HNSW supports up to 4000).

That's not an upgrade-time auto-run. It's a deliberate, expensive
operation. Run it when you've decided you actually want the new model.

## PGLite (default install)

**PGLite cannot `ALTER COLUMN TYPE vector(N)`.** pgvector ships as
embedded WASM, not a native extension, and the WASM build rejects the
column-type alter with `could not access file "$libdir/vector"`. The
SQL recipe below works against Postgres only.

The path that works on PGLite is **wipe-and-reinit**. v0.37 ships a
single-command wrapper:

```bash
gbrain reinit-pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280
```

This backs up the existing brain to `<path>.bak`, runs `gbrain init`
with the new flags (preserving every other field in
`~/.gbrain/config.json`), and re-syncs the brain repo. Add `--no-sync`
to skip the resync, `--yes` to skip the TTY confirmation, `--json` for
structured output.

Equivalent by hand:

```bash
# 1. Back up the existing brain (in case you want to roll back).
mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak

# 2. Re-init with the new model + dimensions. `gbrain init` writes
#    the schema sized to the new dim, and (as of v0.37) preserves
#    every other field in ~/.gbrain/config.json (chat model,
#    expansion model, API keys).
gbrain init --pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280

# 3. Re-import your brain repo. `gbrain sync` reads the brain repo
#    from disk and re-creates the page rows.
gbrain sync

# 4. Re-embed. The embed pipeline now uses the new model and the
#    column accepts the new dim.
gbrain embed --stale
```

If your brain repo is large enough that re-syncing from disk is
expensive (>50K pages), see the Postgres section below — migrating to
Postgres temporarily lets you run the SQL recipe, then migrate back to
PGLite.

`GBRAIN_HOME` users: substitute the active database path (or use
`gbrain config get database_path` to find it).

## Postgres (Supabase / self-hosted)

Postgres supports the in-place column alter. Replace `<NEW_DIMS>` with
your target dimension count.

```sql
BEGIN;

-- 1. Drop the HNSW index. It can't survive the column type change.
DROP INDEX IF EXISTS idx_chunks_embedding;

-- 2. Clear stale embeddings FIRST. This must happen BEFORE the column
--    alter: pgvector refuses to cast existing vectors across dimensions
--    ("expected <NEW_DIMS> dimensions, not <OLD_DIMS>"), so altering a
--    column that still holds old-width vectors aborts the transaction.
--    NULLs cast fine. (The old vectors are unusable in the new space
--    anyway — this is the wipe step from the rationale above.)
UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;

-- 3. Alter the column type (all rows are NULL now, so the cast succeeds).
ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(<NEW_DIMS>);

-- 4. Recreate the HNSW index ONLY IF dims <= 2000. Above that, leave it
--    indexless and rely on exact scans (gbrain searchVector handles this
--    automatically — search just gets slower, not broken).
-- For dims <= 2000 (e.g. 1024, 1280, 1536, 768):
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- For vector dims > 2000 (e.g. 2048 Voyage 4 Large): skip step 4.

COMMIT;
```

An existing `halfvec(2048)` local Nemotron cohort can retain HNSW with
`halfvec_cosine_ops`. Changing `vector` to `halfvec`, or the reverse, is a
separate storage migration and is not performed by a normal upgrade.

Then re-init config with the new model:

```bash
gbrain init --supabase \
  --embedding-model <provider:model> \
  --embedding-dimensions <NEW_DIMS>
```

And re-embed:

```bash
gbrain embed --stale
```

## A note on `gbrain config set`

Pre-v0.37 docs recommended `gbrain config set embedding_model X` to
switch models. **This is a no-op for the embed pipeline.** `config set`
writes the DB plane; the embed gateway reads the file plane
(`~/.gbrain/config.json`). The pre-v0.37 recipe shipped the lie because
the contract wasn't surfaced.

As of v0.37, `gbrain config set embedding_model` and `gbrain config set
embedding_dimensions` REFUSE and print the wipe-and-reinit recipe.

To change schema-sizing fields, use `gbrain init` (PGLite) or the SQL
recipe (Postgres). Both update the file plane AND the schema together.

## Verify

After the recipe lands, `gbrain doctor --fast` should report green and
`gbrain doctor` should pass the `embedding_width_consistency` check. A search
can use semantic ranking only when runtime selection, DB selection, physical
column type/width, exact chunk model, and v2 page signatures agree:

```
✓ embedding_width_consistency   dim parity: config 1280 / column vector(1280)
```

If it doesn't, file an issue with the doctor output and the steps you
ran.

## v0.37+ followups

- Auto-fallback to alternative embedding providers when the primary
  fails quota/auth. Tracked; requires explicit `--try-fallback`
  consent because mixing provider vectors silently corrupts retrieval.
