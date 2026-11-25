# pi-extras

Small, dependency-free [Pi](https://pi.dev) extensions, extracted from daily use. Each one is an independent npm package; install only what you need.

> **Status (2026-11-25):** the three `fabric-*` packages are **archived / no longer installed or maintained** —
> upstream `pi-fabric` was retired on 2026-11-21 and this machine now orchestrates with `pi-subagents`. Their
> code stays here (and on npm) for anyone still running Fabric; nothing here patches modern Pi. Only
> **`pi-model-speed`** is active.

| Package | npm | Status / what it fixes |
| --- | --- | --- |
| [**pi-fabric-agent-echo**](packages/fabric-agent-echo) | [![npm](https://img.shields.io/npm/v/pi-fabric-agent-echo.svg)](https://www.npmjs.com/package/pi-fabric-agent-echo) | ⚠️ archived (Fabric retired). Completed [pi-fabric](https://github.com/fabric-runtime/pi-fabric) subagent conversations stay in your transcript as collapsible, model-invisible cards instead of disappearing behind `/fabric chat`. |
| [**pi-model-speed**](packages/model-speed) | [![npm](https://img.shields.io/npm/v/pi-model-speed.svg)](https://www.npmjs.com/package/pi-model-speed) | Measures real TTFT/TPOT per request and steps off a model that is consistently slow — within the same provider, never across. |
| [**pi-fabric-hardening**](packages/fabric-hardening) | [![npm](https://img.shields.io/npm/v/pi-fabric-hardening.svg)](https://www.npmjs.com/package/pi-fabric-hardening) | ⚠️ archived (Fabric retired). Idempotent runtime patches for pi-fabric/pi-fold/pi-grow-loop: survive a full tmpfs, keep the real cause of a dead child, configurable recovery watchdog, and no self-scheduling inside a Fabric child. |
| [**pi-fabric-resume**](packages/fabric-resume) | [![npm](https://img.shields.io/npm/v/pi-fabric-resume.svg)](https://www.npmjs.com/package/pi-fabric-resume) | ⚠️ archived (Fabric retired). Resumable Fabric children without forking pi-fabric: every child keeps its own session, so `agents.resume({ id })` continues an interrupted, crashed or post-reboot run from its own transcript. |

## Install

All four are published on npm and carry the `pi-package` keyword. **`pi-model-speed` is the only one to install today**;
the `fabric-*` ones are archived (see the status note above).

```bash
pi install npm:pi-model-speed
# archived, Fabric-only — kept for old Fabric installs:
# pi install npm:pi-fabric-agent-echo
# pi install npm:pi-fabric-hardening
# pi install npm:pi-fabric-resume
```

From a checkout instead:

```bash
git clone https://github.com/xiaquwan1001/pi-extras
pi install ./pi-extras/packages/fabric-agent-echo
```

Restart Pi, then `/reload` in sessions that were already open. Remove with `pi remove <source>`.

## Shared design rules

These extensions were written against the same constraints, and it shows:

- **No new dependencies.** Only Node built-ins and Pi's host-provided packages (`peerDependencies: *`), so nothing is duplicated into your extension module graph.
- **Host-provided packages stay peer deps**, never bundled.
- **Everything fails soft.** Missing package, changed upstream text, unreadable state file, absent Fabric run directory: skip and say so, never throw into a turn.
- **Nothing is sent to the model unless it is meant to be.** The echo cards use `pi.appendEntry` (persisted, invisible to the LLM). Model-speed only switches the live session model.
- **State lives in `~/.cache/pi-model-speed/` and `~/.pi/agent/model-speed.json`.** No hidden state in the repository.

## Requirements

- Pi 1.5.x or newer (`pi` with extension discovery and `/reload`).
- Node 22+ for the repository's own smoke script; the extensions themselves only use stable Node APIs.
- `pi-fabric` for the archived `fabric-agent-echo`, `fabric-hardening` and `fabric-resume` (they fail soft when it is absent — which is the state of this machine since 2026-11-21).

## Development

```bash
npm run pack:dry   # check what each package would publish
npm run smoke      # patch-set + parser self-checks, no network
```

## License

MIT
