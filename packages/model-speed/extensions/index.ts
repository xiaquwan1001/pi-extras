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
 * Commands: `/speed` (table + optional probe run), `/speed-stats`, `/speed on|off`.
 *
 * Config: `~/.pi/agent/model-speed.json` (all fields optional)
 * {
 *   "auto": true,
 *   "providers": [],          // providers where switching is allowed; [] = any provider with 2+ models
 *   "candidates": [],         // model ids or "provider/id" to consider; [] = every model of the provider
 *   "thresholds": { "ttftSmallMs": 12000, "ttftLargeMs": 25000, "largePromptTokens": 30000, "tpotMs": 250 },
 *   "window": 3,
 *   "cooldownMs": 600000,
 *   "sessionBinding": {
 *     "warmTurns": 3,              // turns after which the session counts as bound
 *     "warmAfterMs": 600000,       // ... or this much wall time into the session
 *     "boundThresholdMultiplier": 3,  // bound sessions use thresholds × this
 *     "boundMinTtftMs": 60000,     // ... but never less than this TTFT before switching
 *     "minImprovementRatio": 1.6,  // a target must be this much faster than the current model
 *     "minImprovementMs": 5000     // ... and at least this many ms faster
 *   },
 *   "probe": { "command": ["bash", "/path/probe.sh"], "file": "/path/last-probe.json" }
 * }
 *
 * Environment: PI_MODEL_SPEED=0 disables everything; PI_MODEL_SPEED_DIR changes the
 * state directory; PI_MODEL_SPEED_CONFIG changes the config path.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
const SWITCH_STATE = join(STATE_DIR, "switch-state.json");

type Thresholds = { ttftSmallMs: number; ttftLargeMs: number; largePromptTokens: number; tpotMs: number };
type SessionBinding = {
	warmTurns: number;
	warmAfterMs: number;
	boundThresholdMultiplier: number;
	boundMinTtftMs: number;
	minImprovementRatio: number;
	minImprovementMs: number;
};
type Config = {
	auto: boolean;
	providers: string[];
	candidates: string[];
	thresholds: Thresholds;
	window: number;
	cooldownMs: number;
	sessionBinding: SessionBinding;
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
	thresholds: { ttftSmallMs: 12_000, ttftLargeMs: 25_000, largePromptTokens: 30_000, tpotMs: 250 },
	window: 3,
	cooldownMs: 600_000,
	sessionBinding: {
		warmTurns: 3,
		warmAfterMs: 600_000,
		boundThresholdMultiplier: 3,
		boundMinTtftMs: 60_000,
		minImprovementRatio: 1.6,
		minImprovementMs: 5_000,
	},
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
};

type ProbeFile = {
	ts?: number;
	models: Record<string, { ok?: boolean; status?: string; ttft?: number | null; total?: number | null; err?: string }>;
};

let config: Config = DEFAULT_CONFIG;
let samples: Sample[] = [];
let pending: Array<Sample> = [];
let lastSwitchAt = 0;
let switchedThisSession = false;
let switchTarget: string | undefined;
let sessionStartedAt = 0;
let turnCount = 0;

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
	return {
		auto: disabled ? false : (raw.auto ?? DEFAULT_CONFIG.auto) !== false,
		providers: Array.isArray(raw.providers) ? raw.providers.filter((v: unknown) => typeof v === "string") : [],
		candidates: Array.isArray(raw.candidates) ? raw.candidates.filter((v: unknown) => typeof v === "string") : [],
		thresholds: {
			ttftSmallMs: envThreshold("PI_MODEL_SPEED_SLOW_MS", num(thresholds.ttftSmallMs, 12_000)),
			ttftLargeMs: envThreshold("PI_MODEL_SPEED_SLOW_LARGE_MS", num(thresholds.ttftLargeMs, 25_000)),
			largePromptTokens: num(thresholds.largePromptTokens, 30_000),
			tpotMs: envThreshold("PI_MODEL_SPEED_SLOW_TPOT_MS", num(thresholds.tpotMs, 250)),
		},
		window: Math.max(2, Math.floor(num(process.env.PI_MODEL_SPEED_WINDOW, num(raw.window, 3)))),
		cooldownMs: num(raw.cooldownMs, DEFAULT_CONFIG.cooldownMs),
		sessionBinding: {
			warmTurns: Math.max(1, Math.floor(num(raw.sessionBinding?.warmTurns, DEFAULT_CONFIG.sessionBinding.warmTurns))),
			warmAfterMs: num(raw.sessionBinding?.warmAfterMs, DEFAULT_CONFIG.sessionBinding.warmAfterMs),
			boundThresholdMultiplier: Math.max(1, num(raw.sessionBinding?.boundThresholdMultiplier, DEFAULT_CONFIG.sessionBinding.boundThresholdMultiplier)),
			boundMinTtftMs: num(raw.sessionBinding?.boundMinTtftMs, DEFAULT_CONFIG.sessionBinding.boundMinTtftMs),
			minImprovementRatio: Math.max(1, num(raw.sessionBinding?.minImprovementRatio, DEFAULT_CONFIG.sessionBinding.minImprovementRatio)),
			minImprovementMs: num(raw.sessionBinding?.minImprovementMs, DEFAULT_CONFIG.sessionBinding.minImprovementMs),
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

async function readSwitchState(): Promise<{ lastSwitchAt?: number }> {
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
	} catch {
		/* logging must never break a turn */
	}
}

/** Median TTFT per model from this extension's own history (last 500 samples). */
async function historyTtft(): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	try {
		const lines = (await readFile(LOG, "utf8")).split("\n").filter(Boolean).slice(-500);
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

const fmtMs = (ms?: number | null) => (ms === undefined || ms === null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

type Candidate = { id: string; ttftMs?: number; source: "probe" | "history" | "none" };

/** Same-provider candidates, fastest first; unknown timings last. */
async function rankCandidates(ctx: ExtensionContext): Promise<Candidate[]> {
	const provider = ctx.model?.provider;
	if (!provider) return [];
	const probe = await readProbe();
	const history = await historyTtft();
	const allowed = (id: string) =>
		config.candidates.length === 0 || config.candidates.includes(id) || config.candidates.includes(`${provider}/${id}`);
	const candidates: Candidate[] = ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.provider === provider && allowed(model.id))
		.map((model) => {
			const probeTtft = probe?.models[model.id]?.ttft;
			if (probe && probe.models[model.id]?.ok === false) return { id: model.id, ttftMs: Number.POSITIVE_INFINITY, source: "probe" as const };
			if (typeof probeTtft === "number") return { id: model.id, ttftMs: probeTtft * 1000, source: "probe" as const };
			const hist = history.get(`${provider}/${model.id}`);
			if (typeof hist === "number") return { id: model.id, ttftMs: hist, source: "history" as const };
			return { id: model.id, source: "none" as const };
		});
	return candidates.sort((a, b) => (a.ttftMs ?? Number.POSITIVE_INFINITY) - (b.ttftMs ?? Number.POSITIVE_INFINITY));
}

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

/** The last `window` usable samples, if every one of them was slow and recent. */
function slowStreak(): { tail: Sample[]; bound: boolean } | null {
	const usable = samples.filter((s) => !s.error && s.ttftMs !== undefined);
	if (usable.length < config.window) return null;
	const tail = usable.slice(-config.window);
	const now = Date.now();
	if (tail.some((s) => now - s.startedAt > config.cooldownMs)) return null;
	const bound = sessionBound();
	const multiplier = bound ? config.sessionBinding.boundThresholdMultiplier : 1;
	for (const sample of tail) {
		const prompt = sample.promptTokens ?? 0;
		const promptLimit = prompt >= config.thresholds.largePromptTokens ? config.thresholds.ttftLargeMs : config.thresholds.ttftSmallMs;
		// Bound sessions get a widened band, and an absolute floor: a 14 s TTFT on a warm
		// 200k-token session is normal, a 60 s+ one is not.
		const ttftLimit = bound
			? Math.max(promptLimit * multiplier, config.sessionBinding.boundMinTtftMs)
			: promptLimit * multiplier;
		const tpotLimit = config.thresholds.tpotMs * multiplier;
		const slowTtft = (sample.ttftMs ?? 0) > ttftLimit;
		const slowTpot = (sample.tpotMs ?? 0) > tpotLimit;
		if (!slowTtft && !slowTpot) return null;
	}
	return { tail, bound };
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
	});

	pi.on("message_end", async (event) => {
		const message = (event as any).message;
		if (message?.role !== "assistant") return;
		const sample = pending.shift();
		if (!sample) return;
		sample.endedAt = Date.now();
		const elapsed = sample.endedAt - sample.startedAt;
		if (sample.ttftMs !== undefined && (sample.ttftMs < 50 || sample.ttftMs > elapsed)) delete sample.ttftMs;
		if (elapsed > 15 * 60_000) return; // not a normal call
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
		const current = ctx.model;
		if (!current) return;
		// A manual /model change means the user is driving: forget the session's switch.
		if (switchTarget && current.id !== switchTarget) {
			switchedThisSession = false;
			switchTarget = undefined;
		}
		if (!config.auto || switchedThisSession) return;
		// Hard stop for Fabric children: a switch here is read as model drift by the
		// parent and ends the run (see FABRIC_CHILD above). `/speed-auto on` cannot undo it.
		if (FABRIC_CHILD && !AUTO_IN_CHILD) return;
		if (Date.now() - lastSwitchAt < config.cooldownMs) return;
		const shared = await readSwitchState();
		if (shared.lastSwitchAt && Date.now() - shared.lastSwitchAt < config.cooldownMs) return;
		if (config.providers.length > 0 && !config.providers.includes(current.provider)) return;

		const streak = slowStreak();
		if (!streak) return;

		const ranked = await rankCandidates(ctx);
		const currentMedian = median(streak.tail.map((s) => s.ttftMs!));
		// A barely-faster model is not worth the prefix cache: require a clear win.
		const best = ranked.find(
			(candidate) =>
				candidate.id !== current.id &&
				candidate.ttftMs !== undefined &&
				Number.isFinite(candidate.ttftMs) &&
				candidate.ttftMs * config.sessionBinding.minImprovementRatio <= currentMedian &&
				currentMedian - candidate.ttftMs >= config.sessionBinding.minImprovementMs,
		);
		const ttftMedian = fmtMs(currentMedian);
		const boundNote = streak.bound ? `, session bound (thresholds ×${config.sessionBinding.boundThresholdMultiplier})` : "";
		if (!best) {
			lastSwitchAt = Date.now();
			await writeSwitchState({ lastSwitchAt });
			ctx.ui.notify(
				`[model-speed] ${current.id}: ${config.window} slow turns (median TTFT ${ttftMedian}${boundNote}), but no clearly faster same-provider model is known yet`,
				"warning",
			);
			return;
		}
		const target = ctx.modelRegistry.find(current.provider, best.id);
		if (!target) return;
		const switched = await pi.setModel(target);
		lastSwitchAt = Date.now();
		await writeSwitchState({ lastSwitchAt, lastFrom: current.id, lastTo: best.id });
		if (!switched) return;
		switchedThisSession = true;
		switchTarget = best.id;
		ctx.ui.notify(
			`[model-speed] ${current.id}: ${config.window} slow turns (median TTFT ${ttftMedian}${boundNote}) → switched to ${best.id} (${fmtMs(best.ttftMs)}, via ${best.source})`,
			"warning",
		);
		await appendLog({ kind: "switch", pid: process.pid, from: current.id, to: best.id, reason: "slow", bound: streak.bound, streak: streak.tail });
	});

	// ---- startup ----------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		samples = [];
		pending = [];
		switchedThisSession = false;
		switchTarget = undefined;
		lastSwitchAt = 0;
		turnCount = 0;
		sessionStartedAt = Date.now();
		config = await loadConfig();
		if (event.reason === "reload") return;

		const ranked = await rankCandidates(ctx);
		if (ranked.length > 1) {
			const fastest = ranked[0];
			ctx.ui.setStatus("model-speed", `⚡ ${fastest.id}${fastest.ttftMs ? ` ${fmtMs(fastest.ttftMs)}` : ""}`);
		}
		const probe = await readProbe();
		const current = ctx.model;
		if (probe && current) {
			const ageMin = probe.ts ? Math.max(0, Math.round((Date.now() / 1000 - probe.ts) / 60)) : undefined;
			const slow = Object.entries(probe.models)
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
		const ranked = await rankCandidates(ctx);
		const currentId = ctx.model?.id;
		const lines = ranked.map(
			(candidate) =>
				`${candidate.id === currentId ? "*" : " "} ${candidate.id}: ${fmtMs(candidate.ttftMs)}${candidate.source === "none" ? "" : ` (${candidate.source})`}`,
		);
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
		if (samples.length) await appendLog({ kind: "session-end", samples: samples.length });
	});
}
