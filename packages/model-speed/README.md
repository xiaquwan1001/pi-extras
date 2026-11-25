# pi-model-speed

Measure what your model provider actually delivers, and get off a model that is consistently slow — without leaving the provider.

## What it does

**Sampling.** Every model request is timed:

- **TTFT** — `before_provider_request` → first content delta (reported in the status line and commands),
- **TPOT** — ms per output token, derived from `message_end` usage,
- **tokens/s** — the inverse of TPOT, which is the number users actually feel during a long answer.

Two details that make the numbers trustworthy rather than decorative:

- The anchor is `before_provider_request`, not `message_start`. `message_start` fires after the response headers, so counting from it reports a TTFT of ~0 for every request.
- Timings are queued, so overlapping requests (retries, nested calls, compaction) do not clobber each other.

Samples are appended to `~/.cache/pi-model-speed/speed-log.jsonl` (every line carries the `session` it belongs to), and the tail of that log is aggregated into a **rolling window** (`stats.ts`): per model, median TTFT for small and large prompts, median and mean token generation speed, sample counts, errors and the age of the newest sample. `/speed` and `/speed-stats` read the window; it is also written to `~/.cache/pi-model-speed/stats.json` for scripts.

**A six-hour median is not a verdict.** With sparse sampling — long idle gaps between sessions — a fresh 10.2 s measurement used to lose against four 1.3 s measurements from hours earlier, so the model that had just gone slow still ranked as the fast one (`model-big`, 2026-11-24: window median 1.4 s, newest probe 10.2 s, ranked second-fastest). The window keeps those medians for context, but everything that *decides* something reads a verdict over the **recency cohort** (`stats.recentMs`, default = one `sampling.intervalMs`):

1. the recent cohort when it has a timed sample — one fresh reading beats any number of old ones,
2. otherwise the window median, if the newest sample is inside `stats.staleMs` (default 2 × the cohort),
3. otherwise **no TTFT at all** and the model is reported `stale`; a stale fast number is not a candidate, so the switch logic says "nothing clearly faster is known" instead of walking onto a slow model.

A fresh **failure** counts the same as a fresh slow reading: if the newest sample in the cohort is a timeout or an HTTP error, the model is unrankable until it answers again — the failure is the newest thing known about it.

The external probe file has the same rule via `probe.maxAgeMs`: past that age it is history, shown in `/speed` but never used as a ranking source.

**The pool is sampled automatically.** Real turns only measure the model in use, so a model nobody selected would stay unmeasured forever. When the session has been idle for `sampling.idleMs` and a model's newest synthetic sample is older than `sampling.intervalMs`, the extension sends one small timed request through `ctx.modelRegistry.streamSimple()` — the same credentials Pi uses, so no probe script and no API key in a config file — and records TTFT plus tokens/s as a `kind:"probe"` line. Details that keep this honest and cheap:

- a random tag at the front of the prompt, so a gateway prefix cache cannot fake a 0.3 s TTFT;
- sequential calls with a small gap: concurrent requests to one gateway queue and skew the numbers;
- the stalest models first, capped by `sampling.maxModels` (default 4) per run;
- a lease file plus the idle check, so two open sessions never double the spend;
- a real turn aborts in-flight samples, because the user's latency beats a background measurement.

This replaces the old "run a probe script when you remember to" flow. An external probe file is still accepted (and `/speed-probe --external` refreshes it) for legacy cron setups, but it is now the *fallback* ranking source.

**Slow-streak failover.** If the current model is slow — TTFT over the threshold, TPOT over the threshold, or a turn whose wall clock exceeded `turnWallMs` (bucketed by prompt size) — for `window` of the last turns, the extension switches to the fastest **other model of the same provider**. It never crosses providers, because that changes pricing and capabilities behind your back.

Staleness is judged per sample from the time it **ended** (`streakMaxAgeMs`), never from a sample's start. The earlier rule dropped the whole streak as soon as any sample had started more than `cooldownMs` ago, which is always true when turns take minutes — so failover was dead on exactly the gateways it exists for (a production lane, 2026-11-23: TTFT 147 s / 130 s / 904 s / 303 s on `model-fast`, never switched, 73 minutes burned). `tests/streak.test.mjs` replays those samples.

**A hung request is not a slow turn.** `turn_end` never fires while a request is stuck, so a gateway that accepts the call and then sends nothing used to hang the session until Pi's HTTP idle timeout — and the retry landed on the same model. A stall timer is armed at `before_provider_request`:

- no first token for `thresholds.stallMs` (default 3 min) → log a `stall` line, notify, and switch to the fastest measured model under the same guards as a slow streak;
- still nothing after a second window → `ctx.abort()`, so the turn reports an abort instead of silence. For an async subagent that abort is also what wakes the parent up, instead of an hour with no news.

The timer is cleared on the first payload delta and at `message_end`/`turn_end`, so a slow-but-streaming turn is left to the streak logic.

Guards: once per `cooldownMs`, at most once per session, skipped while a manual `/model` is driving, the target must **clearly** be faster (`minImprovementRatio` / `minImprovementMs`) — a 13 s → 12 s "win" is not worth re-billing the prompt — and the target must **fit the session's context** (see below).

**A session remembers what it already did.** The budget, the model the last automatic switch landed on, and the models this conversation abandoned are per session and persisted to `switch-state.json` (`sessions.<key>`), keyed by the session file name. Reload, `--resume` and fork restore them — plus this session's timed samples from the log — so a resumed conversation does not get a fresh budget and does not step back onto the model it just left. A *manual* `/model` still resets the budget (`model_select` with a model that is not ours); `/new` starts a conversation with no inherited memory, `/speed-stats` shows what was remembered.

**Fast is not the same as usable.** A provider often mixes windows: a fast 256k model next to a slow 1M one. Letting speed alone pick the target hands a 300k-token session the 256k model, and the turn dies on a `400 ContextWindowExceededError` (inside a Fabric child, the whole run dies). Targets whose declared `contextWindow` is below the session's current tokens (from `getContextUsage()` and the largest prompt this session has already sent) plus `contextGuard.headroomTokens` are skipped, and both the switch notification and `/speed` say so.

**A warm session is expensive to leave.** Switching models discards the gateway's prefix cache and re-pays for the whole prompt, so a session that has already run `sessionBinding.warmTurns` turns (or `warmAfterMs` of wall time, or one turn whose prompt is past `thresholds.largePromptTokens`) is *bound*: its slow thresholds are multiplied by `boundThresholdMultiplier`, TTFT never triggers a switch below `boundMinTtftMs`, and the switch log/notification says `session bound`. A bound session stays on a model that is 20% slower, and still walks away from one that stalls for a minute.

**Never inside a child with a pinned model.** A background pi-subagents child (`PI_SUBAGENT_CHILD=1`, set by the runner) keeps the model its parent assigned: the parent verifies every assistant message against the launch candidate and fails the whole run with `model_verification_failed` ("Expected 'my-gateway/model-big:high' but observed 'model-fast2'") — even though the work finished. The same pin applies to any `PI_FABRIC_*` lineage marker; Pi Fabric was uninstalled in 2026-11-24, so the marker check is only a no-op compatibility guard. Sampling still runs in children, so their timings feed the shared ranking. `PI_MODEL_SPEED_ALLOW_CHILD=1` opts back in for debugging. The abort half of the stall watchdog still applies: it ends the turn, it does not change the model.

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
| `/speed` | Rolling window of recent TTFT / tokens-per-second per model, plus the ranked candidates; refreshes stale models in the background |
| `/speed-probe` | Sample the stale pool models now (background); `/speed-probe --force` ignores freshness; `/speed-probe <model…>` samples exactly those; `--external` runs the legacy probe script |
| `/speed-stats` | This session's TTFT/TPOT medians, the remembered switch budget, and the rolling recent window |
| `/speed-auto on\|off` | Toggle failover for this session |
| `/speed-router` | The `auto` virtual model: chain, per-model health, and the model it would pick now |
| `/speed-pick` | Print the provider-qualified model the router would use now — use it when dispatching a subagent |

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
  "sampling": {
    "enabled": true,
    "intervalMs": 1800000,
    "idleMs": 60000,
    "startDelayMs": 15000,
    "timeoutMs": 45000,
    "promptTokens": 2000,
    "maxTokens": 128,
    "maxModels": 4,
    "gapMs": 400,
    "providers": [],
    "models": []
  },
  "stats": { "windowMs": 21600000, "recentMs": 1800000, "staleMs": 3600000 },
  "probe": {
    "command": ["bash", "/home/me/bin/model-probe.sh"],
    "file": "/home/me/.cache/model-probe.json",
    "maxAgeMs": 3600000
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
| `sampling.enabled` | `true` | Take synthetic timed samples of the whole pool in the background (`PI_MODEL_SPEED_SAMPLING=0` disables) |
| `sampling.intervalMs` | `1800000` | A model is re-sampled at most once per this interval (`PI_MODEL_SPEED_SAMPLING_INTERVAL_MS`) |
| `sampling.idleMs` | `60000` | Only sample after this much quiet: a sample taken mid-turn measures queueing |
| `sampling.startDelayMs` | `15000` | Wait after session start before the first sample |
| `sampling.timeoutMs` | `45000` | Hard cap per sample |
| `sampling.promptTokens` | `2000` | Approximate prompt size of a synthetic sample |
| `sampling.maxTokens` | `128` | Output tokens to ask for; enough for a stable tokens/s reading |
| `sampling.maxModels` | `4` | Models per run (cost control); the stalest are sampled first |
| `sampling.gapMs` | `400` | Pause between samples, so one gateway is not probed concurrently |
| `sampling.providers` | `[]` | Providers to sample; empty = `providers`, then the current session's provider |
| `sampling.models` | `[]` | Model ids or `provider/id` to sample; empty = every model of those providers |
| `stats.windowMs` | `21600000` | Rolling window used for the medians in `/speed` and `stats.json` (6 h) (`PI_MODEL_SPEED_STATS_WINDOW_MS`) |
| `stats.recentMs` | = `sampling.intervalMs` | Recency cohort that decides the verdict ranking uses (`PI_MODEL_SPEED_RECENT_MS`; `0` = always use the whole window) |
| `stats.staleMs` | = 2 × `stats.recentMs` | No measurement newer than this means the model is *unknown*, never "fast" (`PI_MODEL_SPEED_STALE_MS`) |
| `probe.command` | — | Legacy external probe, only run by `/speed-probe --external` |
| `probe.file` | — | That probe's output: `{ "ts": 1700000000, "models": { "<id>": { "ok": true, "ttft": 1.2 } } }` (`ttft` in seconds) |
| `probe.maxAgeMs` | `3600000` | A probe file older than this is shown but not ranked (`PI_MODEL_SPEED_PROBE_MAX_AGE_MS`) |

Environment overrides: `PI_MODEL_SPEED=0` (disable), `PI_MODEL_SPEED_SAMPLING=0` (disable only pool sampling), `PI_MODEL_SPEED_DIR` (state dir), `PI_MODEL_SPEED_CONFIG` (config path), `PI_MODEL_SPEED_SLOW_MS`, `PI_MODEL_SPEED_SLOW_LARGE_MS`, `PI_MODEL_SPEED_SLOW_TPOT_MS`, `PI_MODEL_SPEED_SLOW_WALL_MS`, `PI_MODEL_SPEED_STALL_MS`, `PI_MODEL_SPEED_STREAK_MAX_AGE_MS`, `PI_MODEL_SPEED_WINDOW`, `PI_MODEL_SPEED_CONTEXT_GUARD=0`, `PI_MODEL_SPEED_SAMPLING_INTERVAL_MS`, `PI_MODEL_SPEED_STATS_WINDOW_MS`, `PI_MODEL_SPEED_RECENT_MS`, `PI_MODEL_SPEED_STALE_MS`, `PI_MODEL_SPEED_PROBE_MAX_AGE_MS`.

## Choosing a ranking source

Ranking uses, in order: the **verdict** from the rotation window (recency cohort first, whole window second — real turns and synthetic samples alike), then a *fresh* external probe file for models the window has never seen, then "unknown". `stale` and unknown models are never picked as a switch target — the extension says "no faster same-provider model is known yet" and leaves you where you are, which is the correct answer when the only number available describes an hour ago.

Recent measured data deliberately outranks an external probe file: a probe with a cold 2 k prompt can report 0.3 s while the same model serves this session in 6 s, and the rolling window is what users actually felt. Token speed travels with the ranking, so a model that answers quickly but generates at 9 tok/s is visibly unappealing in `/speed`.

## The virtual model: one selection, a physical model per request

A gateway can fail over on its own, but the client has to *stop switching* for that to be useful: pi-subagents verifies every assistant message against the launch candidate and fails the whole run with `model_verification_failed` when a child changed models mid-run (2026-11-24, run `e5a8e44a`: the review was delivered and the run was thrown away). The old answer was to pin children to one model; that is safe but leaves the child on a model the pool has already given up on.

With `virtual.enabled`, the extension registers a **virtual model** (`my-gateway/auto` by default) whose `route()` picks the physical model per request.

> **The shipped `virtual` defaults are placeholders** (`provider: "my-gateway"`, `id: "auto"`) — replace them with your own gateway and models in `~/.pi/agent/model-speed.json`. Example (illustrative, swap in your own values):
>
> ```json
> {
>   "virtual": {
>     "enabled": true,
>     "provider": "my-gateway",
>     "id": "auto",
>     "name": "auto (health-routed)",
>     "chain": ["model-a", "model-b", "model-c", "model-d"]
>   }
> }
> ```

- the **selection** never changes, so the parent's verification, the prompt cache and the thinking signatures stay valid;
- the chain (`model-a → model-b → model-c → model-d`) is the preference order, and a later entry is promoted only on a **clear** win (`virtual.minGainRatio`, 2×) — the chain encodes capability, not just speed;
- a `continuation` keeps the model that answered last; a `retry` steps off the failed model and parks it for `virtual.quarantineMs`;
- the **256k model is never given a request that needs more** than it holds (live context usage when Pi has it, otherwise a character estimate, plus `virtual.headroomTokens`);
- a model whose newest answer was **empty or special-token garbage** is not a target, however fast its TTFT was.

That last rule is the one a stopwatch cannot express. deepseek-flash-2 answered HTTP 200 with `<｜DSML｜>…` bodies on 2026-11-25; four subagent lanes exited 0 with zero output while every latency field said "healthy, fast". Content is now classified on every real turn (`empty`, `garbage`, `chars` in the log) and on every synthetic sample, `stats` counts it (`invalid` / `recentInvalid`), and `verdict()` refuses to rank a model whose newest evidence is garbage. One good answer after the streak clears it — no manual reset.

**Children.** Virtual models are not part of provider registration, and subagent children do not load ambient extensions by default (the resolved-extension list of a launch contains only the subagent runtime). A child launched on the virtual model therefore sends `auto` upstream and the gateway answers `400 Invalid model name` (measured, 2026-11-25). Two ways out:

- give the child this extension explicitly (works for foreground and background children):
  `~/.pi/agent/settings.json` → `"subagents": { "defaultSubagentOnlyExtensions": ["<path>/packages/model-speed/extensions/index.ts"] }`,
  then `"defaultModel": "my-gateway/auto"` resolves inside the child, the request is routed to a physical model, and pi-subagents' model verification still passes (it compares the *virtual selection*, which never changes). Verified end to end with an `async` scout launched on `auto:minimal`;
- or keep children on a physical model and pick it with `/speed-pick` / from `/speed-router` health.  The recommended setup is: the interactive session on the virtual model, subagents on an explicit physical model — pick it with `/speed-pick` instead of guessing, or dispatch a background lane on the virtual one.

`PI_MODEL_SPEED_SAMPLING_ALLOW_CHILD=1` re-enables pool sampling inside a pinned child (off by default: a worker on one model only adds gateway load beside the parent's samples).

## Diagnosing "why didn't it switch?"

`speed-log.jsonl` (in `~/.cache/pi-model-speed/`) carries everything needed after the fact:

| `kind` | Meaning |
| --- | --- |
| `sample` | One timed real request (TTFT/TPOT, prompt/output tokens, `longCall` for hangs) |
| `probe` | One timed synthetic pool sample (TTFT, TPOT, tokens/s, `tokensOut`, `error`/`status` on failure) |
| `stall` | A request produced no first token for `stallMs` (`attempt` 1 = notify+switch, 2 = abort) |
| `switch` | The switch that happened (`from`/`to`, `reason` = `slow` or `stall`, `switches` = budget used) |
| `session-start` | A reload/resume/fork restored memory (`restoredFrom`, `samples`, `switches`, `target`) |
| `model-select` | The user changed the model, so the switch budget was cleared |
| `switch-skip` | Why it did **not** happen: `auto off`, `switch budget spent`, `switch cooldown`, `provider … not in allowlist`, `fabric child` / `subagent child`, `target … missing from registry`, `setModel(…) refused`, or `no clearly faster same-provider target` — the last one also logs the ranking it saw (`ranked`, `excluded`, `needTokens`, `currentMedian`) |

`sampler-state.json` carries the lease (`lastRunAt`) and the last run summary; `stats.json` is the rolling window at the last write; `switch-state.json` holds the global history plus `sessions.<key>` (per-conversation budget, target and abandoned models, pruned to the 20 newest). Every log line carries `session`, so `grep <session-key>` answers "what did this conversation experience, and what did it switch to".

```bash
node --test packages/model-speed/tests/*.test.mjs   # failover decision, verdicts, session memory
```

## Notes and limits

- TTFT depends on prompt size, gateway load and caching; the window median is a heuristic, not a benchmark.
- Synthetic samples cost tokens: ~2 k prompt + up to 128 output per model per interval, capped by `sampling.maxModels`. Set `sampling.enabled: false` (or `PI_MODEL_SPEED_SAMPLING=0`) to keep only real-turn measurements.
- If you used an external cron/systemd probe for freshness, disable it: the extension now samples while Pi is open, and the probe file only remains as a fallback source.
- If your provider names the deployment that answered in a header (`x-litellm-model-name` / `x-litellm-model-id`), real samples record it as `served`, which is often more useful than the requested id.
- The extension never edits model configuration. It calls `setModel` on the live session only when auto failover moves a session off a slow model, and never when the selection is the virtual model or a pinned child (the router owns that decision).
- `virtual.minGainRatio` (default 2) is the whole "is it worth jumping the chain" policy: lower promotes faster, higher keeps the preferred model longer.
