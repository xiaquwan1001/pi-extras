/**
 * pi-model-speed — measure what you are actually served, and step off a slow model.
 *
 * Two parts:
 *
 * 1. **Sampling.** Every model request is timed from `before_provider_request` to the
 *    first content delta (TTFT) and to `message_end` (TPOT = ms per output token).
 *    Samples are appended to `~/.cache/pi-model-speed/speed-log.jsonl`, and the tail of
 *    that log is aggregated into a rolling per-model window (`stats.ts`): median TTFT
 *    (small and large prompts) and median/mean token generation speed (tokens/s).
 *
 *    Real turns only measure the model in use, so the extension also **samples the pool
 *    itself**: when the session has been idle and a model's newest synthetic sample is
 *    older than `sampling.intervalMs`, it sends one small timed request through
 *    `ctx.modelRegistry.streamSimple()` (same credentials, no probe script) and records
 *    TTFT + tokens/s as a `kind:"probe"` line. A lease file (`sampler-state.json`) and
 *    the idle check keep several open sessions from double-sampling, and a real turn
 *    aborts in-flight samples so user latency always wins. The rolling window is written
 *    to `stats.json`; `/speed` shows it, `/speed-probe` refreshes it on demand.
 *
 * 2. **Slow-streak failover.** When the current model is clearly slow for `window`
 *    consecutive turns, switch to the fastest *other model of the same provider*
 *    (never across providers — that changes pricing and capabilities). Once per
 *    cooldown, at most once per session, and a manual `/model` resets everything.
 *
 * 3. **A warm session is expensive to leave.** Switching models throws away the
 *    gateway's prefix cache and re-pays for the whole prompt, so once the session is
 *    *bound* (after `sessionBinding.warmTurns` turns or `warmAfterMs`, or as soon as a
 *    turn's prompt is past `thresholds.largePromptTokens`) the slow thresholds are
 *    multiplied and no target is taken unless it is clearly faster
 *    (`minImprovementRatio` / `minImprovementMs`). A warm session only steps off a
 *    model that is genuinely broken, not one that is 20% slower.
 *
 * Ranking sources, in order: the rolling window (recent measured TTFT/TPOT, real turns
 * plus synthetic samples), then an optional external probe file (e.g. a legacy cron
 * job), then registry order.
 *
 * **A hung request is not a slow turn.** `turn_end` never fires while a request is
 * stuck, so a gateway that accepts the call and then streams nothing used to hang the
 * session until Pi's HTTP idle timeout (20 min here) — twice, because the retry lands on
 * the same model. A stall timer armed at `before_provider_request` fires after
 * `thresholds.stallMs` without a first token: it logs the stall, switches to the
 * fastest measured model (same rules as a slow streak), and aborts the turn when a
 * second window also passes with nothing. Aborting ends the turn instead of silence,
 * which is also what wakes an async subagent's parent up.
 *
 * **Speed is only half of "is this model a valid target".** A candidate must also be
 * able to hold the context the session already has: a provider that offers a fast
 * 256k model next to a slow 1M one will otherwise hand a 300k-token session the 256k
 * model, and the whole turn comes back as a 400 ContextWindowExceededError (in a
 * Fabric child that is the entire run). Candidates whose declared `contextWindow` is
 * below the session's current tokens plus `contextGuard.headroomTokens` are skipped
 * and reported as such.
 *
 * Commands: `/speed` (table + optional probe run), `/speed-stats`, `/speed on|off`.
 *
 * Config: `~/.pi/agent/model-speed.json` (all fields optional)
 * {
 *   "auto": true,
 *   "providers": [],          // providers where switching is allowed; [] = any provider with 2+ models
 *   "candidates": [],         // model ids or "provider/id" to consider; [] = every model of the provider
 *   "thresholds": { "ttftSmallMs": 12000, "ttftLargeMs": 25000, "largePromptTokens": 30000, "tpotMs": 250, "turnWallMs": 90000, "stallMs": 180000 },
 *   "window": 3,
 *   "minSlowInWindow": 2,        // how many of the last `window` samples must be slow
 *   "streakMaxAgeMs": 1800000,  // a sample older than this (by end time) leaves the streak
 *   "switchCooldownMs": 180000,  // min gap between switches *in one session*
 *   "maxSwitchesPerSession": 3,  // a session may step off more than once
 *   "cooldownMs": 600000,        // ping-pong window: don't go back to a model just left
 *   "sessionBinding": {
 *     "warmTurns": 3,              // turns after which the session counts as bound
 *     "warmAfterMs": 600000,       // ... or this much wall time into the session
 *     "boundThresholdMultiplier": 3,  // bound sessions use thresholds × this
 *     "boundMinTtftMs": 60000,     // ... but never less than this TTFT before switching
 *     "minImprovementRatio": 1.6,  // a target must be this much faster than the current model
 *     "minImprovementMs": 5000     // ... and at least this many ms faster
 *   },
 *   "contextGuard": { "enabled": true, "headroomTokens": 32000 },
 *   "sampling": {
 *     "enabled": true, "intervalMs": 1800000, "idleMs": 60000, "startDelayMs": 15000,
 *     "timeoutMs": 45000, "promptTokens": 2000, "maxTokens": 128,
 *     "maxModels": 4, "gapMs": 400, "providers": [], "models": []
 *   },
 *   "stats": { "windowMs": 21600000 },
 *   "probe": { "command": ["bash", "/path/probe.sh"], "file": "/path/last-probe.json" }
 * }
 *
 * Environment: PI_MODEL_SPEED=0 disables everything; PI_MODEL_SPEED_SAMPLING=0 disables
 * only the synthetic pool sampling; PI_MODEL_SPEED_DIR changes the state directory;
 * PI_MODEL_SPEED_CONFIG changes the config path.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sampleModels, type ProbeOutcome, type SamplerModel, type StreamRegistry } from "./sampler.ts";
import { aggregate, definedMedian, median, recentRecords, sortedStats, type ModelStat } from "./stats.ts";

/**
 * A child session is launched on the model its parent named, and the parent treats any
 * later drift as a protocol violation and fails the run. So automatic switching is off
 * whenever this process is a child. Sampling stays on: the child's samples still feed
 * the shared history that ranking uses.
 *
 * Native pi-subagents children (`PI_SUBAGENT_CHILD=1`, set by the background runner)
 * are the live case: pi-subagents verifies every assistant message against the launch
 * candidate and fails the whole run with `model_verification_failed` ("Expected
 * 'custom.ustc-pool/ustc-glm:high' but observed 'ustc-dsf2'") even though the work
 * finished. That is exactly what a mid-run failover produces (2026-11-24, run
 * e5a8e44a: child switched glm→dsf2 at 15:59:31, review delivered, run failed).
 *
 * Pi Fabric was uninstalled on 2026-11-24; its `PI_FABRIC_*` lineage markers are kept
 * only as a no-op guard in case it ever comes back (same failure mode: strict model
 * admission terminates the child).
 *
 * Set PI_MODEL_SPEED_ALLOW_CHILD=1 to opt back in for debugging.
 */
const FABRIC_CHILD = Boolean(
	process.env.PI_FABRIC_LINEAGE ||
		process.env.PI_FABRIC_DEPTH ||
		process.env.PI_FABRIC_AGENT_NAME ||
		process.env.PI_FABRIC_MODEL_PIN,
);
/** Set by pi-subagents' background runner and by nested native children. */
const SUBAGENT_CHILD = Boolean(
	process.env.PI_SUBAGENT_CHILD === "1" || Number(process.env.PI_SUBAGENT_DEPTH || 0) >= 1,
);
const PINNED_CHILD = FABRIC_CHILD || SUBAGENT_CHILD;
const AUTO_IN_CHILD = process.env.PI_MODEL_SPEED_ALLOW_CHILD === "1";

const CONFIG_PATH = process.env.PI_MODEL_SPEED_CONFIG?.trim() || join(homedir(), ".pi", "agent", "model-speed.json");
const STATE_DIR = process.env.PI_MODEL_SPEED_DIR?.trim() || join(homedir(), ".cache", "pi-model-speed");
const LOG = join(STATE_DIR, "speed-log.jsonl");
/** Keep the sample log small: it is appended to forever and only the tail is read. */
const LOG_MAX_BYTES = 4 * 1024 * 1024;
const LOG_TAIL_BYTES = 1024 * 1024;
const SWITCH_STATE = join(STATE_DIR, "switch-state.json");
/** Lease + last-run summary, so two open sessions do not sample the pool twice. */
const SAMPLER_STATE = join(STATE_DIR, "sampler-state.json");
/** Snapshot of the rolling window, for scripts and for `/speed` after a fresh run. */
const STATS_SNAPSHOT = join(STATE_DIR, "stats.json");

type Thresholds = { ttftSmallMs: number; ttftLargeMs: number; largePromptTokens: number; tpotMs: number; turnWallMs: number; stallMs: number };
type SessionBinding = {
	warmTurns: number;
	warmAfterMs: number;
	boundThresholdMultiplier: number;
	boundMinTtftMs: number;
	minImprovementRatio: number;
	minImprovementMs: number;
};
type ContextGuard = { enabled: boolean; headroomTokens: number };
/**
 * Automatic background sampling: every model of the chosen providers gets a synthetic
 * timed request now and then, so "how fast is the pool" does not depend on the user
 * remembering to run a probe, nor on the only measured model being the one in use.
 */
type Sampling = {
	enabled: boolean;
	/** A model is re-sampled at most once per interval. */
	intervalMs: number;
	/** Only sample when no provider request has run for this long. */
	idleMs: number;
	/** Wait after session start before the first sample, so startup is not slowed. */
	startDelayMs: number;
	timeoutMs: number;
	promptTokens: number;
	maxTokens: number;
	/** Cap on models per run (cost control): the stalest ones are sampled first. */
	maxModels: number;
	gapMs: number;
	providers: string[];
	models: string[];
};
type StatsConfig = { windowMs: number };
type Config = {
	auto: boolean;
	providers: string[];
	candidates: string[];
	thresholds: Thresholds;
	window: number;
	minSlowInWindow: number;
	streakMaxAgeMs: number;
	switchCooldownMs: number;
	maxSwitchesPerSession: number;
	cooldownMs: number;
	sessionBinding: SessionBinding;
	contextGuard: ContextGuard;
	probe: { command?: string[]; file?: string };
	sampling: Sampling;
	stats: StatsConfig;
};

const num = (value: unknown, fallback: number) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

const DEFAULT_CONFIG: Config = {
	auto: process.env.PI_MODEL_SPEED !== "0" && !(PINNED_CHILD && !AUTO_IN_CHILD),
	providers: [],
	candidates: [],
	thresholds: { ttftSmallMs: 12_000, ttftLargeMs: 25_000, largePromptTokens: 30_000, tpotMs: 250, turnWallMs: 90_000, stallMs: 180_000 },
	window: 3,
	minSlowInWindow: 2,
	streakMaxAgeMs: 1_800_000,
	switchCooldownMs: 180_000,
	maxSwitchesPerSession: 3,
	cooldownMs: 600_000,
	sessionBinding: {
		warmTurns: 3,
		warmAfterMs: 600_000,
		boundThresholdMultiplier: 3,
		boundMinTtftMs: 60_000,
		minImprovementRatio: 1.6,
		minImprovementMs: 5_000,
	},
	contextGuard: { enabled: true, headroomTokens: 32_000 },
	probe: {},
	sampling: {
		enabled: process.env.PI_MODEL_SPEED_SAMPLING !== "0",
		intervalMs: 1_800_000,
		idleMs: 60_000,
		startDelayMs: 15_000,
		timeoutMs: 45_000,
		promptTokens: 2_000,
		maxTokens: 128,
		maxModels: 4,
		gapMs: 400,
		providers: [],
		models: [],
	},
	stats: { windowMs: 21_600_000 },
};

type Sample = {
	model: string;
	provider: string;
	served?: string;
	promptTokens?: number;
	ttftMs?: number;
	tpotMs?: number;
	/** Output tokens reported by the provider; lets the window compute pooled tokens/s. */
	tokensOut?: number;
	startedAt: number;
	endedAt?: number;
	error?: string;
	/** The call took absurdly long (hung / upstream meltdown); kept, but never treated as a normal turn. */
	longCall?: boolean;
};

type ProbeEntry = {
	ok?: boolean;
	status?: string;
	ttft?: number | null;
	ttftLarge?: number | null;
	total?: number | null;
	err?: string;
};

type ProbeFile = { ts?: number; models: Record<string, ProbeEntry> };

let config: Config = DEFAULT_CONFIG;
let samples: Sample[] = [];
let pending: Array<Sample> = [];
let lastSwitchAt = 0;
let switchCount = 0;
let switchTarget: string | undefined;
let lastNoTargetAt = 0;
let sessionStartedAt = 0;
let turnCount = 0;
/** Stall watchdog state: one timer for the request in flight, one context for its session. */
let stallTimer: ReturnType<typeof setTimeout> | undefined;
let stallFired = 0;
/**
 * True when this in-flight request already triggered a failover switch. The switch
 * cannot rescue the hung request itself, and aborting it is a hard exit — pi's retry
 * machinery only runs on *errors*, not aborts — so the second stall window must not
 * abort a request we already moved away from. limbus, 2026-11-25: stall → switch
 * dsf→glm at 3 min, then the watchdog aborted the same dead dsf request at 6 min,
 * killing the turn the switch was supposed to save.
 */
let switchedDuringStall = false;
let liveCtx: ExtensionContext | undefined;
let liveApi: ExtensionAPI | undefined;
let disposed = false;
/** Aggregated rolling window; invalidated whenever a sample is appended. */
let statsCache: { at: number; windowMs: number; map: Map<string, ModelStat> } | undefined;
let sessionCtx: ExtensionContext | undefined;
let samplerTimer: ReturnType<typeof setInterval> | undefined;
let samplerStartTimer: ReturnType<typeof setTimeout> | undefined;
let sampling = false;
/** In-flight synthetic samples; a real turn preempts them (same gateway, one queue). */
let samplerAbort: AbortController | undefined;
/** Last time a provider request started or finished; sampling waits for quiet. */
let lastActivityAt = 0;

async function loadConfig(): Promise<Config> {
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		/* optional */
	}
	const thresholds = { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds ?? {}) };
	const envThreshold = (name: string, fallback: number) => num(process.env[name], fallback);
	const disabled = process.env.PI_MODEL_SPEED === "0" || (PINNED_CHILD && !AUTO_IN_CHILD);
	const window = Math.max(2, Math.floor(num(process.env.PI_MODEL_SPEED_WINDOW, num(raw.window, 3))));
	return {
		auto: disabled ? false : (raw.auto ?? DEFAULT_CONFIG.auto) !== false,
		providers: Array.isArray(raw.providers) ? raw.providers.filter((v: unknown) => typeof v === "string") : [],
		candidates: Array.isArray(raw.candidates) ? raw.candidates.filter((v: unknown) => typeof v === "string") : [],
		thresholds: {
			ttftSmallMs: envThreshold("PI_MODEL_SPEED_SLOW_MS", num(thresholds.ttftSmallMs, 12_000)),
			ttftLargeMs: envThreshold("PI_MODEL_SPEED_SLOW_LARGE_MS", num(thresholds.ttftLargeMs, 25_000)),
			largePromptTokens: num(thresholds.largePromptTokens, 30_000),
			tpotMs: envThreshold("PI_MODEL_SPEED_SLOW_TPOT_MS", num(thresholds.tpotMs, 250)),
			turnWallMs: envThreshold("PI_MODEL_SPEED_SLOW_WALL_MS", num(thresholds.turnWallMs, 90_000)),
			// Unlike the slow thresholds, 0 is meaningful here: it disables the watchdog.
			stallMs: (() => {
				const n = Number(process.env.PI_MODEL_SPEED_STALL_MS ?? raw.thresholds?.stallMs ?? thresholds.stallMs);
				return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG.thresholds.stallMs;
			})(),
		},
		window,
		minSlowInWindow: Math.min(window, Math.max(1, Math.floor(num(raw.minSlowInWindow, DEFAULT_CONFIG.minSlowInWindow)))),
		streakMaxAgeMs: num(process.env.PI_MODEL_SPEED_STREAK_MAX_AGE_MS, num(raw.streakMaxAgeMs, DEFAULT_CONFIG.streakMaxAgeMs)),
		switchCooldownMs: num(raw.switchCooldownMs, DEFAULT_CONFIG.switchCooldownMs),
		maxSwitchesPerSession: Math.max(1, Math.floor(num(raw.maxSwitchesPerSession, DEFAULT_CONFIG.maxSwitchesPerSession))),
		cooldownMs: num(raw.cooldownMs, DEFAULT_CONFIG.cooldownMs),
		sessionBinding: {
			warmTurns: Math.max(1, Math.floor(num(raw.sessionBinding?.warmTurns, DEFAULT_CONFIG.sessionBinding.warmTurns))),
			warmAfterMs: num(raw.sessionBinding?.warmAfterMs, DEFAULT_CONFIG.sessionBinding.warmAfterMs),
			boundThresholdMultiplier: Math.max(1, num(raw.sessionBinding?.boundThresholdMultiplier, DEFAULT_CONFIG.sessionBinding.boundThresholdMultiplier)),
			boundMinTtftMs: num(raw.sessionBinding?.boundMinTtftMs, DEFAULT_CONFIG.sessionBinding.boundMinTtftMs),
			minImprovementRatio: Math.max(1, num(raw.sessionBinding?.minImprovementRatio, DEFAULT_CONFIG.sessionBinding.minImprovementRatio)),
			minImprovementMs: num(raw.sessionBinding?.minImprovementMs, DEFAULT_CONFIG.sessionBinding.minImprovementMs),
		},
		contextGuard: {
			enabled: process.env.PI_MODEL_SPEED_CONTEXT_GUARD !== "0" && raw.contextGuard?.enabled !== false,
			headroomTokens: Math.max(0, num(raw.contextGuard?.headroomTokens, DEFAULT_CONFIG.contextGuard.headroomTokens)),
		},
		probe: {
			command: Array.isArray(raw.probe?.command) && raw.probe.command.length ? raw.probe.command.map(String) : undefined,
			file: typeof raw.probe?.file === "string" ? raw.probe.file : undefined,
		},
		sampling: {
			// Sampling stays on in pinned children (their measurements are still real); only a
			// global PI_MODEL_SPEED=0 or an explicit false disables it.
			enabled: process.env.PI_MODEL_SPEED !== "0" && raw.sampling?.enabled !== false,
			intervalMs: num(
				process.env.PI_MODEL_SPEED_SAMPLING_INTERVAL_MS,
				num(raw.sampling?.intervalMs, DEFAULT_CONFIG.sampling.intervalMs),
			),
			idleMs: Math.max(0, num(raw.sampling?.idleMs, DEFAULT_CONFIG.sampling.idleMs)),
			startDelayMs: Math.max(0, num(raw.sampling?.startDelayMs, DEFAULT_CONFIG.sampling.startDelayMs)),
			timeoutMs: num(raw.sampling?.timeoutMs, DEFAULT_CONFIG.sampling.timeoutMs),
			promptTokens: num(raw.sampling?.promptTokens, DEFAULT_CONFIG.sampling.promptTokens),
			maxTokens: num(raw.sampling?.maxTokens, DEFAULT_CONFIG.sampling.maxTokens),
			maxModels: Math.max(1, Math.floor(num(raw.sampling?.maxModels, DEFAULT_CONFIG.sampling.maxModels))),
			gapMs: Math.max(0, num(raw.sampling?.gapMs, DEFAULT_CONFIG.sampling.gapMs)),
			providers: Array.isArray(raw.sampling?.providers) ? raw.sampling.providers.filter((v: unknown) => typeof v === "string") : [],
			models: Array.isArray(raw.sampling?.models) ? raw.sampling.models.filter((v: unknown) => typeof v === "string") : [],
		},
		stats: { windowMs: num(process.env.PI_MODEL_SPEED_STATS_WINDOW_MS, num(raw.stats?.windowMs, DEFAULT_CONFIG.stats.windowMs)) },
	};
}

async function readProbe(): Promise<ProbeFile | null> {
	if (!config.probe.file) return null;
	try {
		const probe = JSON.parse(await readFile(config.probe.file, "utf8")) as ProbeFile;
		return probe?.models ? probe : null;
	} catch {
		return null;
	}
}

type SwitchHistoryEntry = { from: string; to: string; at: number };

async function readSwitchState(): Promise<{ lastSwitchAt?: number; history?: SwitchHistoryEntry[] }> {
	try {
		return JSON.parse(await readFile(SWITCH_STATE, "utf8"));
	} catch {
		return {};
	}
}

async function writeSwitchState(patch: Record<string, unknown>) {
	try {
		await mkdir(STATE_DIR, { recursive: true });
		const current = await readSwitchState();
		await writeFile(SWITCH_STATE, JSON.stringify({ ...current, ...patch }));
	} catch {
		/* coordination only */
	}
}

async function appendLog(entry: Record<string, unknown>) {
	try {
		await mkdir(STATE_DIR, { recursive: true });
		await appendFile(LOG, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
		// A measured sample changes the rolling window, so the cached aggregate is stale.
		if (entry.kind === "sample" || entry.kind === "probe") statsCache = undefined;
		// A log that only grows would make every history read slower forever. One
		// rotation is enough: ranking only looks at the newest few hundred samples.
		const size = (await stat(LOG)).size;
		if (size > LOG_MAX_BYTES) await rename(LOG, `${LOG}.1`).catch(() => undefined);
	} catch {
		/* logging must never break a turn */
	}
}

/** Last `LOG_TAIL_BYTES` of a text file, without reading the whole thing. */
async function readTail(file: string): Promise<string> {
	let size: number;
	try {
		size = (await stat(file)).size;
	} catch {
		return "";
	}
	if (size <= LOG_TAIL_BYTES) return readFile(file, "utf8");
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(LOG_TAIL_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, LOG_TAIL_BYTES, size - LOG_TAIL_BYTES);
		return buffer.subarray(0, bytesRead).toString("utf8").replace(/^[^\n]*\n/, "");
	} finally {
		await handle.close();
	}
}

/** Rolling-window stats: both real turns and synthetic samples, one cache for all readers. */
async function recentStats(force = false): Promise<Map<string, ModelStat>> {
	const windowMs = config.stats.windowMs;
	const now = Date.now();
	if (!force && statsCache && statsCache.windowMs === windowMs && now - statsCache.at < 30_000) return statsCache.map;
	try {
		const lines = (await readTail(LOG)).split("\n");
		const records = recentRecords(lines, { now, windowMs, largePromptTokens: config.thresholds.largePromptTokens });
		const map = aggregate(records, { now, windowMs, largePromptTokens: config.thresholds.largePromptTokens });
		statsCache = { at: now, windowMs, map };
		return map;
	} catch {
		return new Map<string, ModelStat>();
	}
}

/** Which TTFT describes this session: the large-prompt median once the prompt is large. */
function statTtft(stat: ModelStat, needTokens: number): number | undefined {
	return needTokens > config.thresholds.largePromptTokens ? (stat.ttftLargeMs ?? stat.ttftMs) : (stat.ttftMs ?? stat.ttftLargeMs);
}

/** Compact one-line view of a model inside the rolling window. */
function fmtStat(stat: ModelStat): string {
	const parts = [`TTFT ${fmtMs(stat.ttftMs ?? stat.ttftLargeMs)}`];
	if (stat.ttftLargeMs !== undefined && stat.ttftMs !== undefined) parts.push(`large ${fmtMs(stat.ttftLargeMs)}`);
	if (stat.tokensPerSec !== undefined) parts.push(`${Math.round(stat.tokensPerSec)} tok/s`);
	parts.push(`n=${stat.n}${stat.probeN ? ` (${stat.probeN} probe)` : ""}`);
	if (stat.errors) parts.push(`err=${stat.errors}`);
	parts.push(fmtAge(stat.lastProbeAt ?? stat.lastAt));
	return parts.join(" · ");
}

function fmtAge(at: number | undefined): string {
	if (!at) return "never";
	const age = Math.max(0, Date.now() - at);
	if (age < 60_000) return "just now";
	if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`;
	return `${(age / 3_600_000).toFixed(1)}h ago`;
}

async function writeStatsSnapshot(map: Map<string, ModelStat>) {
	try {
		await mkdir(STATE_DIR, { recursive: true });
		const payload = {
			ts: Date.now(),
			windowMs: config.stats.windowMs,
			models: Object.fromEntries([...map.values()].map((stat) => [stat.key, stat])),
		};
		await writeFile(STATS_SNAPSHOT, JSON.stringify(payload, null, 1));
	} catch {
		/* snapshot is a convenience, never a dependency */
	}
}

const fmtMs = (ms?: number | null) =>
	ms === undefined || ms === null ? "—" : !Number.isFinite(ms) ? "failed" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

type Candidate = { id: string; ttftMs?: number; tokensPerSec?: number; source: "probe" | "history" | "none"; contextWindow?: number };
/** A candidate that is fast enough but cannot hold the session's context. */
type ExcludedCandidate = { id: string; contextWindow: number };
type Ranking = { candidates: Candidate[]; excluded: ExcludedCandidate[]; needTokens: number };

/**
 * Context the session needs right now, plus headroom for the reply and the next few
 * turns. 0 means "unknown / guard off", which skips the window check entirely.
 */
function contextNeed(ctx: ExtensionContext): number {
	if (!config.contextGuard.enabled) return 0;
	let tokens = 0;
	let live = false;
	try {
		const usage = ctx.getContextUsage?.();
		// Live usage is authoritative: it reflects compaction, unlike the sample history.
		if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
			tokens = usage.tokens;
			live = true;
		}
	} catch {
		/* not every mode exposes it */
	}
	if (!live) {
		for (let i = samples.length - 1; i >= 0; i -= 1) {
			if (samples[i].error) continue;
			tokens = samples[i].promptTokens ?? 0;
			break;
		}
	}
	return tokens > 0 ? tokens + config.contextGuard.headroomTokens : 0;
}

/**
 * Which probe number describes "how fast do I get an answer" for this session? A
 * 200k-token session feels the large-context number, a fresh one the small one. Falling
 * back to whichever exists beats discarding a model because one size timed out.
 */
function pickProbeTtft(entry: ProbeEntry, needTokens: number): number | undefined {
	const small = typeof entry.ttft === "number" ? entry.ttft : undefined;
	const large = typeof entry.ttftLarge === "number" ? entry.ttftLarge : undefined;
	if (needTokens > config.thresholds.largePromptTokens && large !== undefined) return large;
	return small ?? large;
}

/** Same-provider candidates, fastest first; unknown timings last. */
async function rankCandidates(ctx: ExtensionContext): Promise<Ranking> {
	const provider = ctx.model?.provider;
	if (!provider) return { candidates: [], excluded: [], needTokens: 0 };
	const probe = await readProbe();
	const stats = await recentStats();
	const allowed = (id: string) =>
		config.candidates.length === 0 || config.candidates.includes(id) || config.candidates.includes(`${provider}/${id}`);
	const needTokens = contextNeed(ctx);
	const currentId = ctx.model?.id;
	const candidates: Candidate[] = [];
	const excluded: ExcludedCandidate[] = [];
	for (const model of ctx.modelRegistry.getAvailable()) {
		if (model.provider !== provider || !allowed(model.id)) continue;
		const contextWindow = typeof model.contextWindow === "number" ? model.contextWindow : undefined;
		// Never hide the model you are already on: the session is its own problem then.
		if (model.id !== currentId && needTokens > 0 && contextWindow !== undefined && contextWindow < needTokens) {
			excluded.push({ id: model.id, contextWindow });
			continue;
		}
		const stat = stats.get(`${provider}/${model.id}`);
		const entry = probe?.models[model.id];
		// Recent measured data wins over an out-of-band probe file: the rolling window is
		// what this session and its neighbours actually experienced, including token speed.
		const hist = stat ? statTtft(stat, needTokens) : undefined;
		if (typeof hist === "number") {
			candidates.push({ id: model.id, ttftMs: hist, tokensPerSec: stat?.tokensPerSec, source: "history", contextWindow });
		} else if (probe && entry?.ok === false) {
			candidates.push({ id: model.id, ttftMs: Number.POSITIVE_INFINITY, source: "probe", contextWindow });
		} else if (entry && pickProbeTtft(entry, needTokens) !== undefined) {
			candidates.push({
				id: model.id,
				ttftMs: pickProbeTtft(entry, needTokens)! * 1000,
				tokensPerSec: typeof (entry as { tokensPerSec?: number }).tokensPerSec === "number" ? (entry as { tokensPerSec: number }).tokensPerSec : undefined,
				source: "probe",
				contextWindow,
			});
		} else {
			candidates.push({ id: model.id, source: "none", contextWindow, tokensPerSec: stat?.tokensPerSec });
		}
	}
	candidates.sort((a, b) => (a.ttftMs ?? Number.POSITIVE_INFINITY) - (b.ttftMs ?? Number.POSITIVE_INFINITY));
	return { candidates, excluded, needTokens };
}

const describeExcluded = (excluded: ExcludedCandidate[], needTokens: number) =>
	excluded.length === 0
		? ""
		: `; skipped for context: ${excluded.map((entry) => `${entry.id} (${entry.contextWindow} < ${needTokens})`).join(", ")}`;

/**
 * A session is *bound* when leaving it costs more than the slowdown: the prefix cache
 * is already paid for, the prompt has grown past `largePromptTokens`, or enough turns
 * have gone by that a switch would re-bill the whole context. Bound sessions keep their
 * model unless it is catastrophically slow.
 */
function sessionBound(): boolean {
	if (turnCount >= config.sessionBinding.warmTurns) return true;
	if (sessionStartedAt > 0 && Date.now() - sessionStartedAt >= config.sessionBinding.warmAfterMs) return true;
	for (let i = samples.length - 1; i >= 0; i -= 1) {
		const sample = samples[i];
		if (sample.error) continue;
		return (sample.promptTokens ?? 0) >= config.thresholds.largePromptTokens;
	}
	return false;
}

/**
 * Evaluate a slow streak. Pure so the failover decision stays testable:
 * `tests/streak.test.mjs` replays the samples of a real stuck lane.
 */
export function evaluateStreak(
	usable: Sample[],
	cfg: Config,
	bound: boolean,
	now = Date.now(),
): { tail: Sample[]; slowCount: number } | null {
	// Age is measured from when a sample *ended*, and per sample rather than per streak.
	// The old rule (`any startedAt older than cooldownMs` ⇒ no streak at all) disabled
	// failover on exactly the gateways it was written for: three slow turns there span
	// more than ten minutes, so every streak looked stale. limbus lane U, 2026-11-23:
	// TTFT 147s/130s/904s/303s/328s on ustc-dsf — never switched, 73 minutes burned.
	const recent = usable.filter((s) => now - (s.endedAt ?? s.startedAt) <= cfg.streakMaxAgeMs);
	if (recent.length < cfg.window) return null;
	const tail = recent.slice(-cfg.window);
	const multiplier = bound ? cfg.sessionBinding.boundThresholdMultiplier : 1;
	let slowCount = 0;
	for (const sample of tail) {
		const prompt = sample.promptTokens ?? 0;
		const promptLimit = prompt >= cfg.thresholds.largePromptTokens ? cfg.thresholds.ttftLargeMs : cfg.thresholds.ttftSmallMs;
		// Bound sessions get a widened band, and an absolute floor: a 14 s TTFT on a warm
		// 200k-token session is normal, a 60 s+ one is not.
		const ttftLimit = bound
			? Math.max(promptLimit * multiplier, cfg.sessionBinding.boundMinTtftMs)
			: promptLimit * multiplier;
		const tpotLimit = cfg.thresholds.tpotMs * multiplier;
		const slowTtft = (sample.ttftMs ?? 0) > ttftLimit;
		const slowTpot = (sample.tpotMs ?? 0) > tpotLimit;
		// Wall clock is what the user actually waits for: a streaming reply at 40 tok/s that
		// takes four minutes is slow even though its TTFT looked fine. Not multiplied — this
		// is the "I am still waiting" signal, not a per-token nicety.
		const wall = sample.endedAt !== undefined ? sample.endedAt - sample.startedAt : 0;
		const slowWall = wall > cfg.thresholds.turnWallMs;
		if (slowTtft || slowTpot || slowWall) slowCount += 1;
	}
	if (slowCount < cfg.minSlowInWindow) return null;
	return { tail, slowCount };
}

/** The last `window` usable samples, if enough of them were slow and recent. */
function slowStreak(): { tail: Sample[]; bound: boolean } | null {
	const usable = samples.filter((s) => !s.error && (s.ttftMs !== undefined || s.endedAt !== undefined));
	if (usable.length < config.window) return null;
	const bound = sessionBound();
	const result = evaluateStreak(usable, config, bound);
	return result ? { tail: result.tail, bound } : null;
}

/**
 * Move to a clearly faster same-provider model. Shared by the slow-streak path
 * (`turn_end`) and the stall path (a request that sent no first token at all), so both
 * obey the same guards: auto on, per-session switch budget, switch cooldown, provider
 * allowlist, anti ping-pong, and "clearly faster" — plus the context-window check that
 * `rankCandidates` already applied.
 */
async function switchToFaster(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	streak: { tail: Sample[]; bound: boolean },
	reason: "slow" | "stall" = "slow",
): Promise<boolean> {
	const current = ctx.model;
	// Every exit is logged: "the failover did not fire" is the question asked after every
	// slow session, and answering it from the log beats re-reading the code.
	const skip = async (why: string, extra: Record<string, unknown> = {}): Promise<false> => {
		await appendLog({ kind: "switch-skip", pid: process.pid, reason: why, trigger: reason, model: current?.id ?? "?", ...extra });
		return false;
	};
	if (!current) return skip("no current model");
	if (!config.auto) return skip("auto off");
	if (switchCount >= config.maxSwitchesPerSession) return skip(`switch budget spent (${switchCount}/${config.maxSwitchesPerSession})`);
	// Hard stop for pinned children: a switch here is read as model drift by the
	// parent and ends the run (see PINNED_CHILD above). `/speed-auto on` cannot undo it.
	if (PINNED_CHILD && !AUTO_IN_CHILD) return skip(SUBAGENT_CHILD ? "subagent child" : "fabric child");
	// Per *session* pacing: one session's switch must not freeze every other session,
	// which is what the shared lastSwitchAt file used to do.
	if (Date.now() - lastSwitchAt < config.switchCooldownMs) return skip("switch cooldown");
	if (config.providers.length > 0 && !config.providers.includes(current.provider)) return skip(`provider ${current.provider} not in allowlist`);

	const ranked = await rankCandidates(ctx);
	const currentMedian = definedMedian(streak.tail.map((s) => s.ttftMs));
	const shared = await readSwitchState();
	const history = Array.isArray(shared.history) ? shared.history : [];
	// Anti ping-pong: do not jump back to a model this session just abandoned.
	const recentlyLeft = (id: string) =>
		history.some((entry) => entry?.from === id && typeof entry.at === "number" && Date.now() - entry.at < config.cooldownMs);
	// A barely-faster model is not worth the prefix cache: require a clear win.
	const clearlyFaster = (candidate: Candidate) => {
		if (candidate.id === current.id || typeof candidate.ttftMs !== "number" || !Number.isFinite(candidate.ttftMs)) return false;
		if (recentlyLeft(candidate.id)) return false;
		if (currentMedian === undefined) return true; // no TTFT to compare with: a measured fast model still wins
		// A stall has no TTFT to beat — the current model produced nothing for `waited`. Any
		// model with a measured first token *inside* that wait is already the better bet, and
		// the usual ratio gates would compare a wait against a TTFT and reject everything.
		if (reason === "stall") return candidate.ttftMs < currentMedian;
		return (
			candidate.ttftMs * config.sessionBinding.minImprovementRatio <= currentMedian &&
			currentMedian - candidate.ttftMs >= config.sessionBinding.minImprovementMs
		);
	};
	const best = ranked.candidates.find(clearlyFaster);
	const wallNote = streak.tail.some((s) => s.longCall)
		? `, ${streak.tail.filter((s) => s.longCall).length}/${streak.tail.length} hung (>15 min)`
		: "";
	const boundNote = streak.bound ? `, session bound (thresholds ×${config.sessionBinding.boundThresholdMultiplier})` : "";
	const state =
		reason === "stall"
			? `stalled (no first token for ${fmtMs(currentMedian)}${boundNote})`
			: `slow turns (median TTFT ${fmtMs(currentMedian)}${wallNote}${boundNote})`;
	if (!best) {
		// Do NOT burn the switch cooldown when nothing was switched: that used to silence
		// failover for ten minutes after a mere notification.
		if (Date.now() - lastNoTargetAt >= config.switchCooldownMs) {
			lastNoTargetAt = Date.now();
			ctx.ui.notify(
				`[model-speed] ${current.id}: ${state}, but no clearly faster same-provider model is known yet` +
					describeExcluded(ranked.excluded, ranked.needTokens),
				"warning",
			);
		}
		return skip("no clearly faster same-provider target", {
			ranked: ranked.candidates.map((c) => `${c.id}=${c.ttftMs === undefined ? "?" : Math.round(c.ttftMs)}ms/${c.source}`),
			excluded: ranked.excluded.map((e) => `${e.id}<${e.contextWindow}`),
			needTokens: ranked.needTokens,
			currentMedian,
		});
	}
	const target = ctx.modelRegistry.find(current.provider, best.id);
	if (!target) return skip(`target ${best.id} missing from registry`);
	const switched = await pi.setModel(target);
	if (!switched) return skip(`setModel(${best.id}) refused`);
	lastSwitchAt = Date.now();
	const at = lastSwitchAt;
	await writeSwitchState({
		lastSwitchAt: at,
		lastFrom: current.id,
		lastTo: best.id,
		history: [...history, { from: current.id, to: best.id, at }].slice(-8),
	});
	switchCount += 1;
	switchTarget = best.id;
	ctx.ui.notify(
		`[model-speed] ${current.id}: ${state} → switched to ${best.id} (${fmtMs(best.ttftMs)}, via ${best.source})` +
			(switchCount > 1 ? ` [#${switchCount}/${config.maxSwitchesPerSession}]` : ""),
		"warning",
	);
	await appendLog({ kind: "switch", pid: process.pid, from: current.id, to: best.id, reason, bound: streak.bound, streak: streak.tail });
	return true;
}

/** No first token for `thresholds.stallMs` is a hung gateway, and `turn_end` will never fire. */
function clearStall(): void {
	if (stallTimer !== undefined) {
		clearTimeout(stallTimer);
		stallTimer = undefined;
	}
}

function armStall(): void {
	clearStall();
	if (disposed || config.thresholds.stallMs <= 0) return;
	stallTimer = setTimeout(() => {
		stallTimer = undefined;
		void onStall();
	}, config.thresholds.stallMs);
	// Never hold the process open for a watchdog.
	(stallTimer as { unref?: () => void }).unref?.();
}

async function onStall(): Promise<void> {
	const ctx = liveCtx;
	const pi = liveApi;
	const sample = pending[pending.length - 1];
	if (disposed || !ctx || !pi || !sample || sample.ttftMs !== undefined) return;
	const waited = Date.now() - sample.startedAt;
	stallFired += 1;
	await appendLog({ kind: "stall", pid: process.pid, model: sample.model, provider: sample.provider, waitedMs: waited, attempt: stallFired });
	if (stallFired === 1) {
		ctx.ui.notify(`[model-speed] ${sample.model}: no first token for ${fmtMs(waited)} (hung gateway, not slow)`, "warning");
		// A hung request cannot be sped up, but the next one can move: switch now so the
		// retry (or the following turn) leaves the dead model instead of re-paying the wait.
		const switched = await switchToFaster(pi, ctx, { tail: [{ ...sample, ttftMs: waited }], bound: sessionBound() }, "stall");
		switchedDuringStall = switched;
		armStall();
		return;
	}
	// Already failed over mid-stall: aborting here is a hard exit that pi's retry machinery
	// does not run on, so it would throw away the turn the switch was meant to save. Park
	// the watchdog instead — pi's own HTTP idle timeout turns the dead request into a real
	// error, which *is* retried, and the retry lands on the model we switched to.
	if (switchedDuringStall) {
		ctx.ui.notify(
			`[model-speed] still no first token after ${fmtMs(waited)} on the hung request; already switched models — leaving it to pi's idle timeout + retry instead of aborting`,
			"warning",
		);
		await appendLog({ kind: "stall-parked", pid: process.pid, model: sample.model, waitedMs: waited });
		clearStall();
		return;
	}
	// Still nothing after a second window and no way out: stop silently waiting out Pi's HTTP idle timeout
	// (20 min here). Aborting ends the turn — for an async subagent that is also what wakes
	// the parent up, instead of an hour of silence.
	ctx.ui.notify(`[model-speed] ${sample.model}: still no first token after ${fmtMs(waited)}; aborting this turn so the run reports instead of hanging`, "error");
	clearStall();
	try {
		ctx.abort();
	} catch {
		/* not every mode allows it */
	}
}

/** Lease + last-run summary shared by every open session. */
type SamplerState = { lastRunAt?: number; lastRun?: { at: number; models: number; ok: number; by?: string } };

async function readSamplerState(): Promise<SamplerState> {
	try {
		return JSON.parse(await readFile(SAMPLER_STATE, "utf8")) as SamplerState;
	} catch {
		return {};
	}
}

async function patchSamplerState(patch: SamplerState) {
	try {
		await mkdir(STATE_DIR, { recursive: true });
		const current = await readSamplerState();
		await writeFile(SAMPLER_STATE, JSON.stringify({ ...current, ...patch }));
	} catch {
		/* coordination only */
	}
}

/** Providers whose pool should be sampled: explicit lists first, else the session's provider. */
function samplingProviders(ctx: ExtensionContext): string[] {
	const configured = config.sampling.providers.length ? config.sampling.providers : config.providers;
	if (configured.length) return configured;
	return ctx.model?.provider ? [ctx.model.provider] : [];
}

/** Models whose newest synthetic sample is older than `sampling.intervalMs`, stalest first. */
async function staleSamplerTargets(ctx: ExtensionContext): Promise<SamplerModel[]> {
	const providers = new Set(samplingProviders(ctx));
	if (providers.size === 0) return [];
	const stats = await recentStats();
	const now = Date.now();
	const matches = (model: { id: string; provider: string }) =>
		config.sampling.models.length === 0 ||
		config.sampling.models.includes(model.id) ||
		config.sampling.models.includes(`${model.provider}/${model.id}`);
	return ctx.modelRegistry
		.getAvailable()
		.filter((model) => providers.has(model.provider) && matches(model))
		// A model that cannot hold the sample prompt would only record a context error.
		.filter((model) => !model.contextWindow || model.contextWindow >= config.sampling.promptTokens + 2048)
		.map((model) => ({ model, lastAt: stats.get(`${model.provider}/${model.id}`)?.lastProbeAt }))
		.filter((entry) => !entry.lastAt || now - entry.lastAt >= config.sampling.intervalMs)
		.sort((a, b) => (a.lastAt ?? 0) - (b.lastAt ?? 0))
		.slice(0, config.sampling.maxModels)
		// Keep the registry object itself: `streamSimple()` needs the full model definition.
		.map(({ model }) => model as unknown as SamplerModel);
}

/**
 * Take one synthetic sample per stale model and append the results to the shared log.
 *
 * Skipped when the session is mid-request (`idleMs`) or when another session already
 * sampled recently (`sampler-state.json` lease): a second open Pi must not double the
 * spend, and a sample taken while a turn is streaming would measure queueing, not the
 * model.
 */
async function maybeSample(
	ctx: ExtensionContext,
	options: { force?: boolean; notify?: boolean; why?: string } = {},
): Promise<ProbeOutcome[]> {
	if (disposed || !config.sampling.enabled || sampling) return [];
	if (!options.force) {
		if (Date.now() - lastActivityAt < config.sampling.idleMs) return [];
		const state = await readSamplerState();
		if (state.lastRunAt && Date.now() - state.lastRunAt < config.sampling.intervalMs) return [];
	}
	const targets = await staleSamplerTargets(ctx);
	if (targets.length === 0) return [];
	sampling = true;
	const at = Date.now();
	const controller = new AbortController();
	samplerAbort = controller;
	try {
		await patchSamplerState({ lastRunAt: at, lastRun: { at, models: targets.length, ok: 0, by: options.why } });
		// A sample cancelled because the user started a turn is not an error of the model:
		// record it nowhere, and leave the next run to fill the gap.
		const recorded: ProbeOutcome[] = [];
		const outcomes = await sampleModels(ctx.modelRegistry as unknown as StreamRegistry, targets, {
			promptTokens: config.sampling.promptTokens,
			maxTokens: config.sampling.maxTokens,
			timeoutMs: config.sampling.timeoutMs,
			gapMs: config.sampling.gapMs,
			signal: controller.signal,
			onOutcome: async (outcome) => {
				if (outcome.error === "AbortError") return;
				recorded.push(outcome);
				await appendLog({ pid: process.pid, ...outcome });
			},
		});
		statsCache = undefined;
		const map = await recentStats(true);
		await writeStatsSnapshot(map);
		const ok = recorded.filter((outcome) => outcome.ok).length;
		// Do not burn the interval when the run was cut short (user turn or a timeout): the
		// next tick should retry what is still stale.
		const incomplete = controller.signal.aborted || recorded.length < targets.length;
		await patchSamplerState({ lastRunAt: incomplete ? 0 : at, lastRun: { at, models: targets.length, ok, by: options.why } });
		if (options.notify && recorded.length > 0) {
			const lines = recorded.map((outcome) =>
				outcome.ok
					? `${outcome.model}: ${fmtMs(outcome.ttftMs)}${outcome.tokensPerSec ? ` · ${outcome.tokensPerSec} tok/s` : ""}`
					: `${outcome.model}: failed (${outcome.status ?? outcome.error ?? "?"})`,
			);
			ctx.ui.notify(`[model-speed] sampled ${targets.length} model(s) in the background: ${lines.join(" | ")}`, "info");
		}
		return outcomes;
	} catch {
		return [];
	} finally {
		sampling = false;
		samplerAbort = undefined;
	}
}

function stopSampler() {
	if (samplerTimer !== undefined) clearInterval(samplerTimer);
	if (samplerStartTimer !== undefined) clearTimeout(samplerStartTimer);
	samplerTimer = undefined;
	samplerStartTimer = undefined;
}

/** Start the background cadence; the actual run only happens when the session is idle. */
function startSampler(ctx: ExtensionContext) {
	stopSampler();
	sessionCtx = ctx;
	if (!config.sampling.enabled) return;
	const tick = () => {
		if (!sessionCtx) return;
		void maybeSample(sessionCtx, { why: "auto" }).catch(() => undefined);
	};
	samplerStartTimer = setTimeout(tick, config.sampling.startDelayMs);
	(samplerStartTimer as { unref?: () => void }).unref?.();
	// Check often enough to notice staleness, but never more often than once a minute.
	samplerTimer = setInterval(tick, Math.max(60_000, Math.min(config.sampling.intervalMs, 300_000)));
	(samplerTimer as { unref?: () => void }).unref?.();
}

function probeSupported(): boolean {
	return Array.isArray(config.probe.command) && config.probe.command.length > 0;
}

/** Run the configured external probe in the background; never blocks the TUI. */
function runProbe(): Promise<string> {
	const [command, ...args] = config.probe.command ?? [];
	return new Promise((resolve) => {
		if (!command) return resolve("no probe.command configured");
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout?.on("data", (chunk) => (out += chunk.toString()));
		child.stderr?.on("data", (chunk) => (out += chunk.toString()));
		child.on("close", () => resolve(out.trim()));
		child.on("error", (error) => resolve(`probe failed: ${error.message}`));
	});
}

export default function modelSpeed(pi: ExtensionAPI) {
	// The watchdog runs from a timer, outside every hook closure, so it needs the API too.
	liveApi = pi;
	// Load config immediately so pre-session events already see it; session_start reloads it.
	void loadConfig().then((loaded) => {
		config = loaded;
	});

	// ---- sampling ---------------------------------------------------------
	// Anchor on before_provider_request: message_start fires after response headers,
	// which would make TTFT look like ~0. A queue, not a single variable, because
	// retries and nested calls overlap.
	pi.on("before_provider_request", async (_event, ctx) => {
		lastActivityAt = Date.now();
		// A real turn beats a synthetic sample: the gateway is one queue and the user is waiting.
		samplerAbort?.abort();
		pending.push({ model: ctx.model?.id ?? "", provider: ctx.model?.provider ?? "", startedAt: Date.now() });
		if (pending.length > 8) pending.shift();
		// Arm the stall watchdog: if no token arrives, `turn_end` never fires and nothing else
		// in this extension gets a chance to act on a hung gateway.
		liveCtx = ctx;
		stallFired = 0;
		switchedDuringStall = false;
		armStall();
	});

	pi.on("after_provider_response", async (event) => {
		const current = pending[pending.length - 1];
		if (!current) return;
		// LLM gateways often name the deployment that actually answered.
		const headers = (event.headers ?? {}) as Record<string, string>;
		const served = headers["x-litellm-model-name"] ?? headers["x-litellm-model-id"];
		if (typeof served === "string" && served.length > 0) current.served = served;
		if (typeof event.status === "number" && event.status >= 400) current.error = `HTTP ${event.status}`;
	});

	pi.on("message_update", async (event) => {
		const current = pending[pending.length - 1];
		if (!current || current.ttftMs !== undefined) return;
		const delta = (event as any).assistantMessageEvent;
		const isPayload =
			delta?.type === "text_delta" ||
			delta?.type === "thinking_delta" ||
			delta?.type === "toolcall_delta" ||
			delta?.type === "toolcall_start";
		if (!isPayload) return;
		const elapsed = Date.now() - current.startedAt;
		if (elapsed >= 20) current.ttftMs = elapsed; // <20ms is hook ordering, not a real TTFT
		if (current.ttftMs !== undefined) clearStall();
	});

	pi.on("message_end", async (event) => {
		const message = (event as any).message;
		if (message?.role !== "assistant") return;
		clearStall();
		const sample = pending.shift();
		if (!sample) return;
		sample.endedAt = Date.now();
		lastActivityAt = sample.endedAt;
		const elapsed = sample.endedAt - sample.startedAt;
		if (sample.ttftMs !== undefined && (sample.ttftMs < 50 || sample.ttftMs > elapsed)) delete sample.ttftMs;
		// A hung call is still a slow call. Mark it instead of dropping it, so the streak
		// logic sees the very turns that made the user complain.
		if (elapsed > 15 * 60_000) sample.longCall = true;
		const usage = message?.usage;
		if (usage) {
			// Some gateways report only cache misses in `input`; totalTokens - output is the real prompt.
			const output = usage.output ?? 0;
			const promptTokens =
				typeof usage.totalTokens === "number"
					? usage.totalTokens - output
					: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			if (promptTokens > 0) sample.promptTokens = promptTokens;
			if (output > 0) sample.tokensOut = output;
			if (sample.ttftMs !== undefined && output > 0) {
				sample.tpotMs = Math.round((sample.endedAt - sample.startedAt - sample.ttftMs) / output);
			}
		}
		if (message?.stopReason === "error" || message?.errorMessage) sample.error = sample.error ?? message?.errorMessage ?? "error";
		samples.push(sample);
		if (samples.length > 50) samples = samples.slice(-50);
		await appendLog({ kind: "sample", pid: process.pid, ...sample });
	});

	// ---- slow-streak failover --------------------------------------------
	pi.on("turn_end", async (_event, ctx) => {
		turnCount += 1;
		clearStall();
		stallFired = 0;
		const current = ctx.model;
		if (!current) return;
		// Status line = this model's own recent TTFT, no id: the footer already names the
		// model, so repeating it was duplication. `⚠` means slower than the applicable
		// slow threshold for the prompt size seen most recently.
		const mine = samples.filter((s) => s.model === current.id && typeof s.ttftMs === "number").slice(-5);
		const mineMedian = definedMedian(mine.map((s) => s.ttftMs));
		if (mineMedian !== undefined) {
			const lastPrompt = mine[mine.length - 1]?.promptTokens ?? 0;
			const limit = lastPrompt >= config.thresholds.largePromptTokens ? config.thresholds.ttftLargeMs : config.thresholds.ttftSmallMs;
			// Newer samples carry `tokensOut`; older ones only TPOT. Either way this is the
			// generation speed the user actually experienced in this session.
			const tps = definedMedian(
				mine.map((s) =>
					typeof s.tpotMs === "number" && s.tpotMs > 0
						? 1000 / s.tpotMs
						: typeof s.tokensOut === "number" && s.tokensOut > 0 && typeof s.ttftMs === "number"
							? (s.tokensOut * 1000) / Math.max(1, (s.endedAt ?? s.startedAt) - s.startedAt - s.ttftMs)
							: undefined,
				),
			);
			ctx.ui.setStatus(
				"model-speed",
				`⚡ ${fmtMs(mineMedian)}${mineMedian > limit ? " ⚠" : ""}${tps !== undefined ? ` · ${Math.round(tps)} tok/s` : ""}`,
			);
		}
		// A manual /model change means the user is driving: forget the session's switch.
		if (switchTarget && current.id !== switchTarget) {
			switchCount = 0;
			switchTarget = undefined;
		}
		const streak = slowStreak();
		if (!streak) return;
		await switchToFaster(pi, ctx, streak, "slow");
	});

	// ---- startup ----------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		samples = [];
		pending = [];
		switchCount = 0;
		switchTarget = undefined;
		lastSwitchAt = 0;
		lastNoTargetAt = 0;
		turnCount = 0;
		sessionStartedAt = Date.now();
		disposed = false;
		stallFired = 0;
		clearStall();
		config = await loadConfig();
		lastActivityAt = 0;
		// The sampler is armed for every session (parent or child): whichever session is open
		// keeps the pool's rolling window fresh, and the lease file stops duplicates.
		if (event.reason !== "reload") startSampler(ctx);
		if (event.reason === "reload") return;

		const ranked = await rankCandidates(ctx);
		if (ranked.candidates.length > 1) {
			const fastest = ranked.candidates[0];
			// The footer already prints the current model id. Naming it again here was pure
			// duplication; only a *different*, faster candidate is worth the pixels.
			if (fastest.id !== ctx.model?.id && fastest.ttftMs) {
				ctx.ui.setStatus("model-speed", `⚡ ${fastest.id} ${fmtMs(fastest.ttftMs)}`);
			} else {
				ctx.ui.setStatus("model-speed", undefined);
			}
		}
		const current = ctx.model;
		if (current) {
			const stats = await recentStats();
			const mine = stats.get(`${current.provider}/${current.id}`);
			const probe = await readProbe();
			const ageMin = probe?.ts ? Math.max(0, Math.round((Date.now() / 1000 - probe.ts) / 60)) : undefined;
			// The probe measures every model the gateway serves; only the ones this session can
			// actually select are worth a warning.
			const selectable = new Set(
				ctx.modelRegistry
					.getAvailable()
					.filter((model) => model.provider === current.provider)
					.map((model) => model.id),
			);
			// Prefer the rolling window for the warning: a stale external probe can name a model
			// "failed" minutes after the window saw it answer fine.
			const slowStats = [...stats.values()]
				.filter((stat) => stat.provider === current.provider && selectable.has(stat.model) && (stat.ttftMs ?? 0) > config.thresholds.ttftSmallMs)
				.map((stat) => `${stat.model}=${fmtMs(stat.ttftMs)}${stat.errors ? ` (${stat.errors} err)` : ""}`);
			const covered = new Set([...stats.values()].filter((stat) => stat.provider === current.provider).map((stat) => stat.model));
			const slowProbe = Object.entries(probe?.models ?? {})
				.filter(([id]) => selectable.has(id) && !covered.has(id))
				.filter(([, value]) => value.ok === false || (value.ttft ?? 0) * 1000 > config.thresholds.ttftSmallMs)
				.map(([id, value]) => (value.ok === false ? `${id}=failed(${value.status ?? "?"})` : `${id}=${fmtMs((value.ttft ?? 0) * 1000)}`));
			const slow = [...slowStats, ...slowProbe];
			const mineSlow = mine && ((mine.ttftMs ?? 0) > config.thresholds.ttftSmallMs || mine.errors > mine.n);
			if (slow.length > 0) {
				ctx.ui.notify(
					`[model-speed] slow models${ageMin === undefined ? "" : ` (measured ${ageMin} min ago)`}: ${slow.join(", ")}` +
						(mineSlow ? ` ⚠ current ${current.id} is one of them; /model to switch` : ""),
					"warning",
				);
			} else if (mineSlow) {
				ctx.ui.notify(
					`[model-speed] current ${current.id}: ${fmtStat(mine)} — over the slow threshold; /speed for the pool`,
					"warning",
				);
			}
		}
	});

	// ---- commands ---------------------------------------------------------
	const renderRanking = async (ctx: ExtensionContext) => {
		const ranking = await rankCandidates(ctx);
		const currentId = ctx.model?.id;
		const lines = ranking.candidates.map(
			(candidate) =>
				`${candidate.id === currentId ? "*" : " "} ${candidate.id}: ${fmtMs(candidate.ttftMs)}${candidate.tokensPerSec !== undefined ? ` · ${Math.round(candidate.tokensPerSec)} tok/s` : ""}${candidate.source === "none" ? "" : ` (${candidate.source})`}`,
		);
		for (const entry of ranking.excluded) {
			lines.push(`  ${entry.id}: skipped, context window ${entry.contextWindow} < session ${ranking.needTokens} tokens`);
		}
		ctx.ui.setWidget("model-speed", [`same-provider candidates (fastest first):`, ...lines.map((line) => `  ${line}`)], {
			placement: "belowEditor",
		});
		return lines;
	};

	/** Rolling window for every provider with recent data; current provider first. */
	const renderRecent = async (ctx: ExtensionContext) => {
		const stats = await recentStats();
		const currentProvider = ctx.model?.provider;
		const list = sortedStats(stats, config.thresholds.largePromptTokens).sort((a, b) => {
			const mine = (a.provider === currentProvider ? 0 : 1) - (b.provider === currentProvider ? 0 : 1);
			if (mine !== 0) return mine;
			return (a.ttftMs ?? a.ttftLargeMs ?? Number.POSITIVE_INFINITY) - (b.ttftMs ?? b.ttftLargeMs ?? Number.POSITIVE_INFINITY);
		});
		const windowH = Math.round(config.stats.windowMs / 360_000) / 10;
		const lines = list.map((stat) => `${stat.provider === currentProvider ? "*" : " "} ${stat.model}: ${fmtStat(stat)}`);
		ctx.ui.setWidget("model-speed", [`recent ${windowH}h (fastest first):`, ...lines.map((line) => `  ${line}`)], {
			placement: "belowEditor",
		});
		return lines;
	};

	pi.registerCommand("speed", {
		description: "Show recent measured TTFT / tokens-per-second per model (rolling window), and rank candidates",
		handler: async (_args, ctx) => {
			const lines = await renderRecent(ctx);
			ctx.ui.notify(
				lines.length ? `[model-speed] recent: ${lines.join(" | ")}` : "[model-speed] no samples in the recent window yet — /speed-probe to take some now",
				"info",
			);
			const ranked = await renderRanking(ctx);
			if (ranked.length) ctx.ui.notify(`[model-speed] candidates: ${ranked.join(" | ")}`, "info");
			// `/speed` is now history-first: refresh in the background instead of blocking the TUI
			// on a synchronous probe.
			void maybeSample(ctx, { why: "speed" }).catch(() => undefined);
		},
	});

	pi.registerCommand("speed-probe", {
		description: "Sample the pool now (background by default): /speed-probe [--force] [model ...]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const force = tokens.includes("--force");
			const only = tokens.filter((token) => token !== "--force" && token !== "--external");
			// Legacy escape hatch: some setups keep an out-of-band probe script. Refresh it on
			// demand, but the native sampler is what keeps the window fresh otherwise.
			if (tokens.includes("--external")) {
				if (!probeSupported()) {
					ctx.ui.notify("[model-speed] no probe.command configured", "warning");
					return;
				}
				ctx.ui.notify("[model-speed] running external probe…", "info");
				const output = await runProbe();
				if (output) ctx.ui.notify(`[model-speed] probe: ${output.split("\n").slice(-3).join(" | ")}`, "info");
				return;
			}
			if (only.length > 0) {
				// Explicit ids get a forced run of exactly those models: a one-off question
				// should not wait for the interval.
				const models = only
					.map((id) => (id.includes("/") ? id.split("/") : [ctx.model?.provider ?? "", id]))
					.map(([provider, id]) => ctx.modelRegistry.find(provider, id))
					.filter((model): model is NonNullable<typeof model> => Boolean(model));
				if (models.length === 0) {
					ctx.ui.notify(`[model-speed] no such model: ${only.join(", ")}`, "warning");
					return;
				}
				const outcomes = await sampleModels(ctx.modelRegistry as unknown as StreamRegistry, models, {
					promptTokens: config.sampling.promptTokens,
					maxTokens: config.sampling.maxTokens,
					timeoutMs: config.sampling.timeoutMs,
					gapMs: config.sampling.gapMs,
					onOutcome: async (outcome) => {
						if (outcome.error === "AbortError") return;
						await appendLog({ pid: process.pid, ...outcome });
					},
				});
				statsCache = undefined;
				await writeStatsSnapshot(await recentStats(true));
				const lines = outcomes.map((outcome) =>
					outcome.ok ? `${outcome.model}: ${fmtMs(outcome.ttftMs)} · ${outcome.tokensPerSec ?? "?"} tok/s` : `${outcome.model}: failed (${outcome.error ?? outcome.status})`,
				);
				ctx.ui.notify(`[model-speed] ${lines.join(" | ")}`, "info");
				return;
			}
			if (force) {
				const outcomes = await maybeSample(ctx, { force: true, notify: true, why: "command" });
				if (outcomes.length === 0) ctx.ui.notify("[model-speed] nothing to sample (disabled, busy, or every model is fresh)", "info");
				return;
			}
			ctx.ui.notify("[model-speed] sampling the stale models in the background…", "info");
			void maybeSample(ctx, { force: true, notify: true, why: "command" }).catch(() => undefined);
		},
	});

	pi.registerCommand("speed-stats", {
		description: "This session's TTFT/TPOT medians plus the rolling recent window",
		handler: async (_args, ctx) => {
			const recent = await renderRecent(ctx);
			const session: string[] = [];
			if (samples.length > 0) {
				const byModel = new Map<string, Sample[]>();
				const seen = new Set<number>();
				for (const sample of samples) {
					if (seen.has(sample.startedAt)) continue; // two extension instances can record the same call
					seen.add(sample.startedAt);
					const key = sample.model || "?";
					byModel.set(key, [...(byModel.get(key) ?? []), sample]);
				}
				session.push(...[...byModel].map(([model, list]) => {
					const ttft = list.map((s) => s.ttftMs).filter((v): v is number => typeof v === "number");
					const tps = list
						.map((s) => (typeof s.tpotMs === "number" && s.tpotMs > 0 ? 1000 / s.tpotMs : undefined))
						.filter((v): v is number => typeof v === "number");
					return `${model}: n=${list.length} TTFT median=${fmtMs(ttft.length ? median(ttft) : undefined)} ${tps.length ? `${Math.round(median(tps))} tok/s` : "—"}`;
				}));
			}
			ctx.ui.notify(`[model-speed] ${[...recent, ...session].join(" | ") || "no samples yet"}`, "info");
		},
	});

	pi.registerCommand("speed-auto", {
		description: "Turn slow-model failover on or off: /speed-auto on|off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg !== "on" && arg !== "off") {
				ctx.ui.notify(`[model-speed] auto failover is ${config.auto ? "on" : "off"} (usage: /speed-auto on|off)`, "info");
				return;
			}
			config = { ...config, auto: arg === "on" };
			const pinned = PINNED_CHILD && !AUTO_IN_CHILD;
			ctx.ui.notify(
				pinned
					? `[model-speed] auto failover is pinned off in ${SUBAGENT_CHILD ? "pi-subagents" : "Fabric"} child sessions (a mid-run switch makes the parent report model drift and fails the run); sampling continues`
					: `[model-speed] auto failover ${config.auto ? "on" : "off"} for this session`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		clearStall();
		stopSampler();
		sessionCtx = undefined;
		if (samples.length) await appendLog({ kind: "session-end", samples: samples.length });
	});
}
