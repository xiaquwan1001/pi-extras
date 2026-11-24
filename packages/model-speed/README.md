# pi-model-speed

Measure what your model provider actually delivers, and get off a model that is consistently slow — without leaving the provider.

## What it does

**Sampling.** Every model request is timed:

- **TTFT** — `before_provider_request` → first content delta (reported in the status line and commands),
- **TPOT** — ms per output token, derived from `message_end` usage.

Two details that make the numbers trustworthy rather than decorative:

- The anchor is `before_provider_request`, not `message_start`. `message_start` fires after the response headers, so counting from it reports a TTFT of ~0 for every request.
- Timings are queued, so overlapping requests (retries, nested calls, compaction) do not clobber each other.

Samples stay in memory for `/speed-stats` and are appended to `~/.cache/pi-model-speed/speed-log.jsonl`, which later sessions use for ranking.

**Slow-streak failover.** If the current model is slow — TTFT over the threshold, TPOT over the threshold, or a turn whose wall clock exceeded `turnWallMs` (bucketed by prompt size) — for `window` of the last turns, the extension switches to the fastest **other model of the same provider**. It never crosses providers, because that changes pricing and capabilities behind your back.

Staleness is judged per sample from the time it **ended** (`streakMaxAgeMs`), never from a sample's start. The earlier rule dropped the whole streak as soon as any sample had started more than `cooldownMs` ago, which is always true when turns take minutes — so failover was dead on exactly the gateways it exists for (limbus lane U, 2026-11-23: TTFT 147 s / 130 s / 904 s / 303 s on `ustc-dsf`, never switched, 73 minutes burned). `tests/streak.test.mjs` replays those samples.

**A hung request is not a slow turn.** `turn_end` never fires while a request is stuck, so a gateway that accepts the call and then sends nothing used to hang the session until Pi's HTTP idle timeout — and the retry landed on the same model. A stall timer is armed at `before_provider_request`:

- no first token for `thresholds.stallMs` (default 3 min) → log a `stall` line, notify, and switch to the fastest measured model under the same guards as a slow streak;
- still nothing after a second window → `ctx.abort()`, so the turn reports an abort instead of silence. For an async subagent that abort is also what wakes the parent up, instead of an hour with no news.

The timer is cleared on the first payload delta and at `message_end`/`turn_end`, so a slow-but-streaming turn is left to the streak logic.

Guards: once per `cooldownMs`, at most once per session, skipped while a manual `/model` is driving, the target must **clearly** be faster (`minImprovementRatio` / `minImprovementMs`) — a 13 s → 12 s "win" is not worth re-billing the prompt — and the target must **fit the session's context** (see below).

**Fast is not the same as usable.** A provider often mixes windows: a fast 256k model next to a slow 1M one. Letting speed alone pick the target hands a 300k-token session the 256k model, and the turn dies on a `400 ContextWindowExceededError` (inside a Fabric child, the whole run dies). Targets whose declared `contextWindow` is below the session's current tokens (from `getContextUsage()` and the largest prompt this session has already sent) plus `contextGuard.headroomTokens` are skipped, and both the switch notification and `/speed` say so.

**A warm session is expensive to leave.** Switching models discards the gateway's prefix cache and re-pays for the whole prompt, so a session that has already run `sessionBinding.warmTurns` turns (or `warmAfterMs` of wall time, or one turn whose prompt is past `thresholds.largePromptTokens`) is *bound*: its slow thresholds are multiplied by `boundThresholdMultiplier`, TTFT never triggers a switch below `boundMinTtftMs`, and the switch log/notification says `session bound`. A bound session stays on a model that is 20% slower, and still walks away from one that stalls for a minute.

**Never inside a child with a pinned model.** A background pi-subagents child (`PI_SUBAGENT_CHILD=1`, set by the runner) keeps the model its parent assigned: the parent verifies every assistant message against the launch candidate and fails the whole run with `model_verification_failed` ("Expected 'custom.ustc-pool/ustc-glm:high' but observed 'ustc-dsf2'") — even though the work finished. The same pin applies to any `PI_FABRIC_*` lineage marker; Pi Fabric was uninstalled in 2026-11-24, so the marker check is only a no-op compatibility guard. Sampling still runs in children, so their timings feed the shared ranking. `PI_MODEL_SPEED_ALLOW_CHILD=1` opts back in for debugging. The abort half of the stall watchdog still applies: it ends the turn, it does not change the model.

**Where it runs.** Ambient extensions load in the parent session and in *background* subagent children (`async: true`), which is where the stall watchdog earns its keep. Local *foreground* children (`async: false`) never load ambient extensions, so neither sampling nor failover happens there; opt in per agent with `subagentOnlyExtensions` when you need it.

## Install

```bash
pi install npm:pi-model-speed
# or
pi install ./packages/model-speed
```

Restart Pi (or `/reload`).

## Commands

| Command | Effect |
| --- | --- |
| `/speed` | Rank same-provider candidates by measured TTFT; runs the configured probe first if one is set |
| `/speed-stats` | This session's TTFT/TPOT medians per model |
| `/speed-auto on\|off` | Toggle failover for this session |

## Configuration

Optional file `~/.pi/agent/model-speed.json`:

```json
{
  "auto": true,
  "providers": ["my-gateway"],
  "candidates": ["fast-model", "big-model"],
  "thresholds": {
    "ttftSmallMs": 12000,
    "ttftLargeMs": 25000,
    "largePromptTokens": 30000,
    "tpotMs": 250,
    "turnWallMs": 90000,
    "stallMs": 180000
  },
  "window": 3,
  "streakMaxAgeMs": 1800000,
  "cooldownMs": 600000,
  "sessionBinding": {
    "warmTurns": 3,
    "warmAfterMs": 600000,
    "boundThresholdMultiplier": 3,
    "boundMinTtftMs": 60000,
    "minImprovementRatio": 1.6,
    "minImprovementMs": 5000
  },
  "contextGuard": {
    "enabled": true,
    "headroomTokens": 32000
  },
  "probe": {
    "command": ["bash", "/home/me/bin/model-probe.sh"],
    "file": "/home/me/.cache/model-probe.json"
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `auto` | `true` | Enable failover |
| `providers` | `[]` | Providers where switching is allowed; empty = any provider that offers 2+ models |
| `candidates` | `[]` | Model ids or `provider/id` worth considering; empty = every model of the current provider |
| `thresholds.ttftSmallMs` | `12000` | Slow TTFT for prompts under `largePromptTokens` |
| `thresholds.ttftLargeMs` | `25000` | Slow TTFT for large prompts (long prompts legitimately take longer) |
| `thresholds.tpotMs` | `250` | Slow output rate (≈4 tokens/s) |
| `thresholds.turnWallMs` | `90000` | A turn that took longer than this is slow regardless of TTFT |
| `thresholds.stallMs` | `180000` | No first token for this long = hung request: notify + switch; a second window aborts the turn (`PI_MODEL_SPEED_STALL_MS`, `0` disables) |
| `window` | `3` | Consecutive slow turns before switching |
| `minSlowInWindow` | `2` | How many of those `window` turns must be slow |
| `streakMaxAgeMs` | `1800000` | A sample older than this (by end time) leaves the streak (`PI_MODEL_SPEED_STREAK_MAX_AGE_MS`) |
| `switchCooldownMs` | `180000` | Minimum gap between switches inside one session |
| `maxSwitchesPerSession` | `3` | A session may step off more than once |
| `cooldownMs` | `600000` | Ping-pong window: never switch back to a model just left |
| `sessionBinding.warmTurns` | `3` | Turns after which the session counts as bound (prefix cache already paid) |
| `sessionBinding.warmAfterMs` | `600000` | …or this much wall time into the session |
| `sessionBinding.boundThresholdMultiplier` | `3` | Bound sessions use `thresholds` × this |
| `sessionBinding.boundMinTtftMs` | `60000` | Bound sessions never switch on a TTFT below this |
| `sessionBinding.minImprovementRatio` | `1.6` | Target must be this much faster than the current model |
| `sessionBinding.minImprovementMs` | `5000` | …and at least this many ms faster |
| `contextGuard.enabled` | `true` | Skip targets whose context window cannot hold the session (`PI_MODEL_SPEED_CONTEXT_GUARD=0` turns it off) |
| `contextGuard.headroomTokens` | `32000` | Room kept after the current prompt: the next reply plus a few turns before the window is re-checked |
| `probe.command` | — | Optional external probe, run by `/speed` and never automatically |
| `probe.file` | — | That probe's output: `{ "ts": 1700000000, "models": { "<id>": { "ok": true, "ttft": 1.2 } } }` (`ttft` in seconds) |

Environment overrides: `PI_MODEL_SPEED=0` (disable), `PI_MODEL_SPEED_DIR` (state dir), `PI_MODEL_SPEED_CONFIG` (config path), `PI_MODEL_SPEED_SLOW_MS`, `PI_MODEL_SPEED_SLOW_LARGE_MS`, `PI_MODEL_SPEED_SLOW_TPOT_MS`, `PI_MODEL_SPEED_SLOW_WALL_MS`, `PI_MODEL_SPEED_STALL_MS`, `PI_MODEL_SPEED_STREAK_MAX_AGE_MS`, `PI_MODEL_SPEED_WINDOW`, `PI_MODEL_SPEED_CONTEXT_GUARD=0`.

## Choosing a ranking source

Ranking uses, in order: the probe file (an out-of-band measurement, e.g. a cron job), then this extension's own sample history (median TTFT per model from `speed-log.jsonl`), then "unknown". Unknown models are never picked as a switch target — the extension says "no faster same-provider model is known yet" and leaves you where you are.

The probe is deliberately *not* part of the package: timing a model means spending tokens at *your* provider, and every gateway has its own way to do that. If you have one, point `probe.command` at it.

## Diagnosing "why didn't it switch?"

`speed-log.jsonl` (in `~/.cache/pi-model-speed/`) carries everything needed after the fact:

| `kind` | Meaning |
| --- | --- |
| `sample` | One timed request (TTFT/TPOT, prompt tokens, `longCall` for hangs) |
| `stall` | A request produced no first token for `stallMs` (`attempt` 1 = notify+switch, 2 = abort) |
| `switch` | The switch that happened (`from`/`to`, `reason` = `slow` or `stall`) |
| `switch-skip` | Why it did **not** happen: `auto off`, `switch budget spent`, `switch cooldown`, `provider … not in allowlist`, `fabric child` / `subagent child`, `target … missing from registry`, `setModel(…) refused`, or `no clearly faster same-provider target` — the last one also logs the ranking it saw (`ranked`, `excluded`, `needTokens`, `currentMedian`) |

```bash
node --test packages/model-speed/tests/   # failover decision, replayed from real samples
```

## Notes and limits

- TTFT depends on prompt size, gateway load and caching; the history median is a heuristic, not a benchmark.
- If your provider names the deployment that answered in a header (`x-litellm-model-name` / `x-litellm-model-id`), the sample records it as `served`, which is often more useful than the requested id.
- The extension never edits model configuration; it only calls `setModel` on the live session.
