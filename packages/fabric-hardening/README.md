# pi-fabric-hardening

Runtime hardening for [pi-fabric](https://github.com/fabric-runtime/pi-fabric) (and [pi-fold](https://pi.dev/packages/pi-fold)), as an extension instead of a fork.

## Why this exists

Every fix here comes from a real incident where Fabric's failure mode was worse than its bug:

| Symptom | Root cause |
| --- | --- |
| The whole Pi process disappears with `Unknown system error -122` | A full tmpfs made `writeRecord()` throw `EDQUOT`; the throw escaped as an `uncaughtException`. One status write killed the host. |
| Six parallel children "failed" with the same unrelated message | A child's `stderr` (an extension complaining) replaced the real cause of death, so `SIGSEGV` was invisible. |
| Children killed with `made no recovery progress for 60000ms` while still retrying | The recovery watchdog's timeout is a hardcoded 60 s and only resets on content deltas — longer than a slow gateway's TTFT, shorter than Pi's own retry backoff. |
| Atomic state writes fail once and stay failed | `renameAtomic` retried `EPERM/EACCES/EEXIST/EBUSY` but not `EDQUOT/ENOSPC/EIO`, so quota pressure became permanent corruption. |
| A `--no-session` child logs `Evidence ingestion requires an absolute Pi session file` | pi-fold's evidence hook throws when there is no session file, which then becomes the child's reported death cause. |

`pi install` runs with `--ignore-scripts` and upgrades replace `node_modules` wholesale, so a manual edit never survives. This extension re-applies a small patch set on every Pi start.

## The patch set

| id | package | effect |
| --- | --- | --- |
| `status-write-guard` | pi-fabric | a failed status write degrades to a stderr line; the host keeps running |
| `rename-quota-retry` | pi-fabric | atomic rename retries `EDQUOT/ENOSPC/EIO/EMFILE/ENFILE` (transient under quota pressure) |
| `recovery-watchdog-timeout` | pi-fabric | timeout reads `PI_FABRIC_RECOVERY_TIMEOUT_MS`, default **600 000 ms** (was hardcoded 60 000) |
| `exit-signal-decl`, `exit-signal-capture`, `exit-signal-record` | pi-fabric | the child's terminating signal is captured and stored as `exitSignal` |
| `error-ordering` | pi-fabric | "was killed by SIGSEGV" comes first, `stderr` becomes `; last stderr: …` |
| `evidence-no-session-guard` | pi-fold | skip evidence archiving when there is no session file instead of throwing |

Plus one patch-free fix: **TMPDIR relocation**. When `/tmp` is a tmpfs with less than `PI_FABRIC_TMPDIR_MIN_FREE_MB` (default 4096) MB free, `TMPDIR` is pointed at `~/.cache/pi-tmp` before Fabric creates its run roots. A real disk is left alone.

## Design rules

- **Idempotent.** Each patch carries a marker comment (`[pi-fabric-hardening:<id>]`). A file that already has it is left untouched, so restarting Pi is free.
- **Found by content, not filename.** pi-fabric's compiled chunks are renamed on every release (`chunk-QUWC6YCN.js` today, something else tomorrow), so patches search the declared roots and apply to every file containing the upstream text — including the two chunk files that each define `RETRYABLE_RENAME_CODES`.
- **Fails soft.** Package missing (`pi-fabric` not installed), file missing, or upstream text changed: the patch is skipped and reported. Nothing throws, nothing blocks startup.
- **No forking, no bundling.** Patches are text substitutions against the installed package; the extension has no dependency on pi-fabric.

## Install

```bash
pi install npm:pi-fabric-hardening
# or
pi install ./packages/fabric-hardening
```

Restart Pi. On the first start you will see lines like:

```
[fabric-hardening] patched pi-fabric: status writes degrade instead of crashing the host (1 file)
[fabric-hardening] TMPDIR /tmp -> /home/you/.cache/pi-tmp (tmpfs had 812 MB free)
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_FABRIC_HARDENING` | on | `0`/`off` disables all patches; `id1,id2` applies only those ids |
| `PI_FABRIC_HARDENING_EXCLUDE` | — | ids to skip |
| `PI_FABRIC_RECOVERY_TIMEOUT_MS` | `600000` | recovery watchdog timeout (consumed by patch 3) |
| `PI_FABRIC_TMPDIR` | unset | `off` disables relocation; a path forces that directory |
| `PI_FABRIC_TMPDIR_MIN_FREE_MB` | `4096` | relocate only when the tmpfs has less free space than this |
| `PI_NPM_DIR` | `~/.pi/agent/npm/node_modules` | where Pi installs packages |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent directory |

## Limits

- These are patches to compiled JavaScript inside someone else's package. An upstream release that rewrites the matched text turns a patch into a `skipped … upstream text changed` line — check the startup output after upgrading pi-fabric, and open an issue (or better, an upstream PR) when that happens.
- Patch text is validated against **pi-fabric 0.135.2** and **pi-fold 4.3.0**. Older and newer versions apply whatever still matches.
- `recovery-watchdog-timeout` only lengthens the watchdog; it does not make a genuinely hung model call succeed.
- A patched file is written in place, so `node --check` on the whole package is worth doing if you suspect breakage. Reinstalling the package with `pi update` restores the pristine files.

## Uninstall

```bash
pi remove npm:pi-fabric-hardening
pi update --extensions   # or reinstall pi-fabric / pi-fold to revert the patched files
```
