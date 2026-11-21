# pi-fabric-resume

Resumable [pi-fabric](https://github.com/fabric-runtime/pi-fabric) children, restored on every Pi start.

Fabric dispatches a one-shot child with `--no-session`: when the child is interrupted — a watchdog kill, a timeout, a `SIGSEGV`, the host process dying, a reboot — the work it already did lives only in its process, and the parent's only option is to dispatch a new child that re-derives everything from a text summary. This package installs a tested runtime overlay that gives every Pi child its own Fabric-owned session, so `agents.resume({ id })` continues that exact child from its own transcript:

```ts
const h = await agents.spawn({ task: "…" });
const first = await agents.wait({ id: h.id });
if (first.status !== "completed") {
  const again = await agents.resume({ id: h.id, task: "finish the failing test first" });
  const done = await agents.wait({ id: again.id }); // same run id, same transcript, no redo
}
```

## Install

```bash
pi install npm:pi-fabric-resume
```

Restart Pi. The overlay is applied at startup, before Fabric creates its first run root.

From a checkout: `pi install ./pi-extras/packages/fabric-resume`.

## What it does

`pi install` runs with `--ignore-scripts` and a pi-fabric upgrade replaces `node_modules` wholesale, so a patched `dist` never survives on its own. Measured 2026-11-21: the 0.138.0 patch set disappeared with the 0.139.0 upgrade and `agents.resume` silently stopped existing. So this package ships the patched `dist` for one exact pi-fabric release and re-applies it every start:

- **Installed version must match** `overlay/manifest.json`'s `upstream` (currently `0.139.0`). Any other release is refused with a log line, never partially mixed.
- **Verified before writing**: every archive entry is checked against the manifest's size and sha256, so a corrupt tarball changes nothing.
- **Per-file atomic writes** (temp + rename), skipped when the bytes already match; a marker inside `dist` makes later starts a no-op.
- **Fails soft**: a missing pi-fabric, a busy lock, a mismatch — one stderr line, never a startup error.

What the overlay adds:

| Capability | Detail |
| --- | --- |
| `agents.childSession` | Each Pi child runs inside `<runDir>/child-session/session.jsonl`. |
| `agents.resume({ id, task? })` | Reopens that session: same run id, cwd, model, tools. Sends a `[Fabric continuation]` note plus your instruction, never the original task (repeating it makes a continued child re-emit finished output). Three manual resumes per run. |
| Persistent run root | With `childSession` on, the session's run root is `~/.cache/pi-fabric/runs/<pi-session-id>/` (override the base with `PI_FABRIC_RESUME_ROOT`), not a temporary directory deleted at close. |
| Cross-host adoption | Continuing the same Pi session (after a crash, a reboot, `pi -c`, `pi --session <file>`) adopts settled runs and resumes them. A run whose host died mid-flight is adopted once that host process and the child pid it launched are gone and the run has been quiet for 60 s; a live child is never pre-empted. |
| `retention.resumableRunMs` | Seven days by default; sweeps expired runs and abandoned session roots. |

`agents.childSession` must be on in `~/.pi/agent/fabric.json` (it is a Fabric setting, not an extension setting):

```json
{ "agents": { "childSession": true } }
```

Still out of reach: a run of a *different* Pi session id (continue it with `residency: "durable"` plus `agents.durableWorkerRecovery`), a run removed by `agents.cleanup` or the retention window, and a child dispatched before `childSession` was enabled.

## Environment

| Variable | Meaning |
| --- | --- |
| `PI_FABRIC_RESUME_PATCH=0` | Do not apply the overlay this start. |
| `PI_NPM_DIR=<dir>` | Where Pi's npm packages live. |
| `PI_CODING_AGENT_DIR=<dir>` | Pi agent dir (default `~/.pi/agent`). |
| `PI_FABRIC_RESUME_ROOT=<dir>` | Base directory for resumable run roots, read by pi-fabric itself. |

## Rebuilding for a new pi-fabric release

The overlay is built from a patched source tree, not from string substitutions — the change adds a module and edits the agent manager, config schema, guest surface and settings UI. `patches/` carries the series against upstream `0.139.0` (`0001`…`0005`, plus `combined.diff`). To move to a newer upstream:

```bash
git clone https://github.com/fabric-runtime/pi-fabric /tmp/pf-src
cd /tmp/pf-src && git checkout <new release> && git am ~/pi-extras/packages/fabric-resume/patches/000*.patch
bun install && bun run build                    # produces dist/
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=ustar \
  -czf ~/pi-extras/packages/fabric-resume/overlay/dist.tar.gz dist
node ~/pi-extras/packages/fabric-resume/scripts/write-manifest.mjs \
  --dist dist --upstream <new version> --build <short id>
```

`scripts/write-manifest.mjs` rewrites `overlay/manifest.json` (per-file size + sha256) from the built tree. Then bump this package's version, commit, and `npm publish -w packages/fabric-resume`.

## Revert

Remove the extension (`pi remove npm:pi-fabric-resume`) and reinstall pi-fabric for an unpatched dist:

```bash
cd ~/.pi/agent/npm && npm install pi-fabric@<version> --no-save
```

Existing run roots under `~/.cache/pi-fabric/runs/` are inert without the patch; delete them when you no longer need the transcripts.

## License

MIT. The overlay redistributes the built `dist` of [pi-fabric](https://github.com/fabric-runtime/pi-fabric) (MIT), patched as described in `patches/`.
