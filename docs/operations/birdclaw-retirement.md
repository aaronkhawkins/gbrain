# Retiring legacy BirdClaw maintenance

After the replacement bookmark workflow passes acceptance, set the brain-local
database configuration key `research.birdclaw.enabled` to `false` with the
trusted local CLI. The unset/default value retains existing behavior.

```sh
gbrain config set research.birdclaw.enabled false
```

The switch excludes only:

- extraction candidates marked `intake_adapter: birdclaw-bookmarks-to-brain`;
- concept-synthesis input atoms marked `research_policy: birdclaw-research-v1`;
- new and queued media transcription jobs with provenance source `birdclaw`.

Discovery, backlog counts and research-health admission share the same SQL
policy. Ordinary extraction and synthesis continue, including ordinary atoms
in a concept that also has bookmark atoms. Existing bookmark pages, atoms,
concepts, original files and Git history are retained. This switch does not
archive sources, delete content, or disable a whole schema pack or autopilot.
The separate BirdClaw intake scheduler must also stop submitting legacy work.

Deploy the code and change the key only for the intended brain. If several
brains share an executable, select an isolated executable for the retiring
brain instead of replacing the shared binary. Stop that brain's autopilot
and wait for in-flight work to finish or terminate before changing its
executable/configuration; restart it after both are installed. The admission
switch is read at query/job time, but already running model calls are not
cancelled by changing this key alone.

Media jobs already queued when the switch changes are retained as permanent
failures with the content-free reason
`media_transcription:birdclaw_research_disabled`. Their worker remains available
to unrelated jobs. Re-enabling with `gbrain config unset research.birdclaw.enabled`
restores admission; retired media jobs need an explicit operator retry.

Use synthetic mixed-source fixtures for rollout checks. The focused regression
tests are `test/birdclaw-maintenance-optout.test.ts` and the real PostgreSQL
contract in `test/e2e/extract-atoms-discovery-sql.test.ts`.
