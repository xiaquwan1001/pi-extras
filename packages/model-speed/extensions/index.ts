/**
 * pi-model-speed — measure what you are actually served, and step off a slow model.
 *
 * Two parts:
 *
 * 1. **Sampling.** Every model request is timed from `before_provider_request` to the
 *    first content delta (TTFT) and to `message_end` (TPOT = ms per output token).
 *    Samples are kept in memory for the session and appended to
 *    `~/.cache/pi-model-speed/speed-log.jsonl` so later sessions can rank by history.
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
 * Ranking sources, in order: an optional external probe file (e.g. a cron job that
 * times each model), then this extension's own sample history, then registry order.
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
 *   "probe": { "command": ["bash", "/path/probe.sh"], "file": "/path/last-probe.json" }
 * }
 *
 * Environment: PI_MODEL_SPEED=0 disables everything; PI_MODEL_SPEED_DIR changes the
 * state directory; PI_MODEL_SPEED_CONFIG changes the config path.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Fabric child sessions are launched on a model their parent named, and pi-fabric's
 * strict model admission treats any later drift as a protocol violation and terminates
 * the child ("requested X, but assistant reports Y; terminating child"). A failover
 * switch inside a child therefore destroys work rather than rescuing it, so automatic
 * switching is off whenever this process is a Fabric child. Sampling stays on: the
 * child's samples still feed the shared history that ranking uses.
 *
 * Set PI_MODEL_SPEED_ALLOW_CHILD=1 to opt back in for debugging.
 */
const FABRIC_CHILD = Boolean(
	process.env.PI_FABRIC_LINEAGE ||
		process.env.PI_FABRIC_DEPTH ||
		process.env.PI_FABRIC_AGENT_NAME ||
		process.env.PI_FABRIC_MODEL_PIN,
);
const AUTO_IN_CHILD = process.env.PI_MODEL_SPEED_ALLOW_CHILD === "1";

const CONFIG_PATH = process.env.PI_MODEL_SPEED_CONFIG?.trim() || join(homedir(), ".pi", "agent", "model-speed.json");
const STATE_DIR = process.env.PI_MODEL_SPEED_DIR?.trim() || join(homedir(), ".cache", "pi-model-speed");
const LOG = join(STATE_DIR, "speed-log.jsonl");
/** Keep the sample log small: it is appended to forever and only the tail is read. */
const LOG_MAX_BYTES = 4 * 1024 * 1024;
const LOG_TAIL_BYTES = 512 * 1024;
const SWITCH_STATE = join(STATE_DIR, "switch-state.json");

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
};

const num = (value: unknown, fallback: number) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

const DEFAULT_CONFIG: Config = {
	auto: process.env.PI_MODEL_SPEED !== "0" && !(FABRIC_CHILD && !AUTO_IN_CHILD),
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
};

type Sample = {
	model: string;
	provider: string;
	served?: string;
	promptTokens?: number;
	ttftMs?: number;
	tpotMs?: number;
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
let liveCtx: ExtensionContext | undefined;
let liveApi: ExtensionAPI | undefined;
let disposed = false;

async function loadConfig(): Promise<Config> {
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		/* optional */
	}
	const thresholds = { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds ?? {}) };
	const envThreshold = (name: string, fallback: number) => num(process.env[name], fallback);
	const disabled = process.env.PI_MODEL_SPEED === "0" || (FABRIC_CHILD && !AUTO_IN_CHILD);
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

/** Median TTFT per model from this extension's own history (last 500 samples). */
async function historyTtft(): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	try {
		const lines = (await readTail(LOG)).split("\n").filter(Boolean).slice(-500);
		const byModel = new Map<string, number[]>();
		for (const line of lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.kind !== "sample" || entry.error || typeof entry.ttftMs !== "number") continue;
			const key = `${entry.provider ?? "?"}/${entry.model ?? "?"}`;
			const list = byModel.get(key) ?? [];
			list.push(entry.ttftMs);
			byModel.set(key, list);
		}
		for (const [key, list] of byModel) out.set(key, median(list));
	} catch {
		/* no history yet */
	}
	return out;
}

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Median over the values that exist; undefined when the samples carried no TTFT at all. */
const definedMedian = (values: Array<number | undefined>): number | undefined => {
	const list = values.filter((v): v is number => typeof v === "number");
	return list.length ? median(list) : undefined;
};

const fmtMs = (ms?: number | null) =>
	ms === undefined || ms === null ? "—" : !Number.isFinite(ms) ? "failed" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

type Candidate = { id: string; ttftMs?: number; source: "probe" | "history" | "none"; contextWindow?: number };
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
	const history = await historyTtft();
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
		const entry = probe?.models[model.id];
		if (probe && entry?.ok === false) candidates.push({ id: model.id, ttftMs: Number.POSITIVE_INFINITY, source: "probe", contextWindow });
		else if (entry && pickProbeTtft(entry, needTokens) !== undefined) candidates.push({ id: model.id, ttftMs: pickProbeTtft(entry, needTokens)! * 1000, source: "probe", contextWindow });
		else {
			const hist = history.get(`${provider}/${model.id}`);
			if (typeof hist === "number") candidates.push({ id: model.id, ttftMs: hist, source: "history", contextWindow });
			else candidates.push({ id: model.id, source: "none", contextWindow });
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
	// Hard stop for Fabric children: a switch here is read as model drift by the
	// parent and ends the run (see FABRIC_CHILD above). `/speed-auto on` cannot undo it.
	if (FABRIC_CHILD && !AUTO_IN_CHILD) return skip("fabric child");
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
		await switchToFaster(pi, ctx, { tail: [{ ...sample, ttftMs: waited }], bound: sessionBound() }, "stall");
		armStall();
		return;
	}
	// Still nothing after a second window: stop silently waiting out Pi's HTTP idle timeout
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
		pending.push({ model: ctx.model?.id ?? "", provider: ctx.model?.provider ?? "", startedAt: Date.now() });
		if (pending.length > 8) pending.shift();
		// Arm the stall watchdog: if no token arrives, `turn_end` never fires and nothing else
		// in this extension gets a chance to act on a hung gateway.
		liveCtx = ctx;
		stallFired = 0;
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
			ctx.ui.setStatus("model-speed", `⚡ ${fmtMs(mineMedian)}${mineMedian > limit ? " ⚠" : ""}`);
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
		const probe = await readProbe();
		const current = ctx.model;
		if (probe && current) {
			const ageMin = probe.ts ? Math.max(0, Math.round((Date.now() / 1000 - probe.ts) / 60)) : undefined;
			// The probe measures every model the gateway serves; only the ones this session can
			// actually select are worth a warning.
			const selectable = new Set(
				ctx.modelRegistry
					.getAvailable()
					.filter((model) => model.provider === current.provider)
					.map((model) => model.id),
			);
			const slow = Object.entries(probe.models)
				.filter(([id]) => selectable.has(id))
				.filter(([, value]) => value.ok === false || (value.ttft ?? 0) * 1000 > config.thresholds.ttftSmallMs)
				.map(([id, value]) => (value.ok === false ? `${id}=failed(${value.status ?? "?"})` : `${id}=${fmtMs((value.ttft ?? 0) * 1000)}`));
			const mine = probe.models[current.id];
			const mineSlow = mine && (mine.ok === false || (mine.ttft ?? 0) * 1000 > config.thresholds.ttftSmallMs);
			if (slow.length > 0) {
				ctx.ui.notify(
					`[model-speed] slow models${ageMin === undefined ? "" : ` (measured ${ageMin} min ago)`}: ${slow.join(", ")}` +
						(mineSlow ? ` ⚠ current ${current.id} is one of them; /model to switch` : ""),
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
				`${candidate.id === currentId ? "*" : " "} ${candidate.id}: ${fmtMs(candidate.ttftMs)}${candidate.source === "none" ? "" : ` (${candidate.source})`}`,
		);
		for (const entry of ranking.excluded) {
			lines.push(`  ${entry.id}: skipped, context window ${entry.contextWindow} < session ${ranking.needTokens} tokens`);
		}
		ctx.ui.setWidget("model-speed", [`same-provider candidates (fastest first):`, ...lines.map((line) => `  ${line}`)], {
			placement: "belowEditor",
		});
		return lines;
	};

	pi.registerCommand("speed", {
		description: "Show measured model speed for the current provider, and run the configured probe if any",
		handler: async (_args, ctx) => {
			if (probeSupported()) {
				ctx.ui.notify("[model-speed] running probe…", "info");
				const output = await runProbe();
				if (output) ctx.ui.notify(`[model-speed] probe: ${output.split("\n").slice(-3).join(" | ")}`, "info");
			}
			const lines = await renderRanking(ctx);
			ctx.ui.notify(lines.length ? `[model-speed] ${lines.join(" | ")}` : "[model-speed] no candidates for this provider", "info");
		},
	});

	pi.registerCommand("speed-stats", {
		description: "Show this session's measured TTFT/TPOT per model",
		handler: async (_args, ctx) => {
			if (samples.length === 0) {
				ctx.ui.notify("[model-speed] no samples in this session yet", "info");
				return;
			}
			const byModel = new Map<string, Sample[]>();
			const seen = new Set<number>();
			for (const sample of samples) {
				if (seen.has(sample.startedAt)) continue; // two extension instances can record the same call
				seen.add(sample.startedAt);
				const key = sample.model || "?";
				byModel.set(key, [...(byModel.get(key) ?? []), sample]);
			}
			const lines = [...byModel].map(([model, list]) => {
				const ttft = list.map((s) => s.ttftMs).filter((v): v is number => typeof v === "number");
				const tpot = list.map((s) => s.tpotMs).filter((v): v is number => typeof v === "number");
				return `${model}: n=${list.length} TTFT median=${fmtMs(ttft.length ? median(ttft) : undefined)} TPOT median=${tpot.length ? `${Math.round(median(tpot))}ms` : "—"}`;
			});
			ctx.ui.setWidget("model-speed", ["this session:", ...lines], { placement: "belowEditor" });
			ctx.ui.notify(`[model-speed] ${lines.join(" | ")}`, "info");
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
			const pinned = FABRIC_CHILD && !AUTO_IN_CHILD;
			ctx.ui.notify(
				pinned
					? "[model-speed] auto failover is pinned off in Fabric child sessions (a mid-run switch terminates the run); sampling continues"
					: `[model-speed] auto failover ${config.auto ? "on" : "off"} for this session`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		clearStall();
		if (samples.length) await appendLog({ kind: "session-end", samples: samples.length });
	});
}
