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

**Slow-streak failover.** If the current model is slow — TTFT over the threshold *or* TPOT over the threshold, bucketed by prompt size — for `window` consecutive turns, the extension switches to the fastest **other model of the same provider**. It never crosses providers, because that changes pricing and capabilities behind your back.

Guards: once per `cooldownMs`, at most once per session, skipped while a manual `/model` is driving.

**Never inside a Fabric child.** A process launched by `fabric_exec` (it carries `PI_FABRIC_LINEAGE` / `PI_FABRIC_DEPTH`) keeps the model its parent assigned: Pi Fabric's model admission reads a mid-run switch as drift. Sampling still runs there, so child timings feed the shared ranking. `PI_MODEL_SPEED_ALLOW_CHILD=1` opts back in for debugging.

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
    "tpotMs": 250
  },
  "window": 3,
  "cooldownMs": 600000,
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
| `window` | `3` | Consecutive slow turns before switching |
| `cooldownMs` | `600000` | Do not switch more often than this |
| `probe.command` | — | Optional external probe, run by `/speed` and never automatically |
| `probe.file` | — | That probe's output: `{ "ts": 1700000000, "models": { "<id>": { "ok": true, "ttft": 1.2 } } }` (`ttft` in seconds) |

Environment overrides: `PI_MODEL_SPEED=0` (disable), `PI_MODEL_SPEED_DIR` (state dir), `PI_MODEL_SPEED_CONFIG` (config path), `PI_MODEL_SPEED_SLOW_MS`, `PI_MODEL_SPEED_SLOW_LARGE_MS`, `PI_MODEL_SPEED_SLOW_TPOT_MS`, `PI_MODEL_SPEED_WINDOW`.

## Choosing a ranking source

Ranking uses, in order: the probe file (an out-of-band measurement, e.g. a cron job), then this extension's own sample history (median TTFT per model from `speed-log.jsonl`), then "unknown". Unknown models are never picked as a switch target — the extension says "no faster same-provider model is known yet" and leaves you where you are.

The probe is deliberately *not* part of the package: timing a model means spending tokens at *your* provider, and every gateway has its own way to do that. If you have one, point `probe.command` at it.

## Notes and limits

- TTFT depends on prompt size, gateway load and caching; the history median is a heuristic, not a benchmark.
- If your provider names the deployment that answered in a header (`x-litellm-model-name` / `x-litellm-model-id`), the sample records it as `served`, which is often more useful than the requested id.
- The extension never edits model configuration; it only calls `setModel` on the live session.
