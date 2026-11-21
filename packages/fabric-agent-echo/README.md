# pi-fabric-agent-echo

Keep **completed [pi-fabric](https://github.com/fabric-runtime/pi-fabric) subagent conversations inside the main Pi transcript**, as collapsible entries you can scroll back to.

## The problem

A `fabric_exec` program can spawn child agents (`agents.run`, `agents.spawn`, councils, recursive `rlm.query`). Their conversation is *not* part of the main session transcript — it lives in Fabric's run directory:

```
<os.tmpdir()>/pi-fabric-runs-<random>/<runId>/
  status.json       # id, status, usage, turns, toolCalls, logFile
  events.jsonl      # the child's RPC stream (full messages)
  lifecycle.jsonl   # pi.agent_start / agent_settled / tokens.usage
```

Fabric spells out the run ID in every result, and you can inspect it live with `/fabric chat <runId>` (`ctrl+shift+a`) or the dashboard's *Topology · Run*. But that is a separate full-screen view: leave it, and there is nothing left in the transcript. Run artifacts are also temporary — one-shot runs are pruned after 24 hours by default (`retention.oneShotRunMs`).

Runs are read from both places Fabric can put them: the per-process temporary root (`<tmp>/pi-fabric-runs-*/<runId>/`) and, when children keep their own session so they stay resumable (`agents.childSession`, see **pi-fabric-resume**), the session-keyed cache root (`~/.cache/pi-fabric/runs/<pi-session-id>/<runId>/`). Only this session's cache root is read.

This extension closes that gap: when a run finishes, its conversation is appended to the main session as a compact card. `ctrl+o` expands it. The entry is a **TUI-only custom entry** (`pi.appendEntry`), so it is persisted with the session and can be re-read after `/resume`, but it is **never sent to the model** and costs no context.

## Install

```bash
pi install npm:pi-fabric-agent-echo
# or from a checkout
pi install ./packages/fabric-agent-echo
```

Requires `pi-fabric`. Restart Pi, then in an existing session run `/reload`.

## Use

Nothing to do — runs that settle during the session are appended automatically.

| Command | Effect |
| --- | --- |
| `/agent-echo` | Backfill any finished run that is not shown yet |
| `/agent-echo all` | Same, including runs that finished before this session started |
| `/agent-echo <id prefix>` | Backfill one specific run |
| `/agent-echo on` / `off` | Toggle automatic appending |

Collapsed card:

```
[agent] ● completed my-gateway/fast-model · 5m04s · 12 calls · ↑43k ↓2.2k  refactor the auth flow
  …last assistant message…
  [ctrl+o to expand the full conversation]
```

Expanded: the user prompt, every assistant message, every `⚙ tool(args)` call with a bounded result preview, and the run ID (so `/fabric chat <runId>` still works for the live view).

## How it works

1. Find the run roots owned by **this Pi process**: `pi-fabric-runs-*` whose `.fabric-owner.json` `pid` matches `process.pid` (a reload can leave more than one).
2. Scan `status.json` files below those roots (nested subagent runs included), keep the ones that are terminal and finished after the trigger point.
3. Rebuild the conversation from `events.jsonl` (`message_end` events), bounded to 12k characters per run.
4. `pi.appendEntry()` the result; dedupe by run ID, restored from persisted entries on `session_start`.

Triggers: the `tool_result` of a `fabric_exec` call, `agent_settled`, and a 4-second poll (background programs and detached spawns settle outside any tool call).

## Limits

- Only runs of the **current Pi process**. Runs from an older process are reachable with `/fabric chat <runId>` or `agents.log`, not here.
- Persistent actors (`actorId`) are skipped — they have their own conversation view.
- After the retention window the transcript body is gone; the card degrades to `(events.jsonl was cleaned up or has expired)`.
- Depends on Fabric's on-disk layout (`status.json`, `events.jsonl`, `.fabric-owner.json`). Those paths have been stable across recent releases, but a change there degrades this extension to "no cards" rather than breaking Fabric.
- `PI_FABRIC_AGENT_ECHO=0` disables automatic appending for the process.
