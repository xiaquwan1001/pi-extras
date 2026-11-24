/**
 * Rolling-window aggregation of measured model speed.
 *
 * One place answers "how did each model behave recently": real turns (`kind:"sample"`)
 * and synthetic samples (`kind:"probe"`) land in the same log, and this module turns the
 * tail of that log into per-model medians of
 *
 *   - TTFT (split by prompt size: small vs. `largePromptTokens`),
 *   - token generation speed (tokens/s, from TPOT or from measured output/generation time).
 *
 * Everything is pure so `tests/stats.test.mjs` can replay real log lines without a
 * gateway. The extension only adds I/O (read tail, append, write snapshot).
 */

export type SpeedRecord = {
	kind?: string;
	model?: string;
	provider?: string;
	ttftMs?: number;
	tpotMs?: number;
	tokensOut?: number;
	promptTokens?: number;
	startedAt?: number;
	endedAt?: number;
	ts?: number;
	error?: string;
	longCall?: boolean;
	ok?: boolean;
	status?: string;
};

export type ModelStat = {
	provider: string;
	model: string;
	key: string;
	/** Timed samples inside the window (probe + real turns). */
	n: number;
	/** Synthetic samples inside the window. */
	probeN: number;
	/** Real turns inside the window. */
	turnN: number;
	/** Failed samples inside the window (errors, timeouts). */
	errors: number;
	/** Median TTFT for prompts under `largePromptTokens`, ms. */
	ttftMs?: number;
	/** Median TTFT for prompts at or above `largePromptTokens`, ms. */
	ttftLargeMs?: number;
	/** Median TPOT, ms per output token. */
	tpotMs?: number;
	/** Median token generation speed (tokens/s) across samples that measured it. */
	tokensPerSec?: number;
	/** Arithmetic mean tokens/s — the "average generation speed" over the window. */
	tokensPerSecMean?: number;
	/** Output tokens measured in the window (probe samples carry an exact count). */
	tokensOut?: number;
	/** End time of the newest sample in the window, ms. */
	lastAt: number;
	/** End time of the newest synthetic sample in the window, ms. */
	lastProbeAt?: number;
};

export type AggregateOptions = {
	now: number;
	/** Only samples that ended within this many ms are counted. */
	windowMs: number;
	/** Prompts at or above this token count are reported as "large" TTFT. */
	largePromptTokens: number;
};

export const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Median over the values that exist; undefined when the samples carried no value at all. */
export const definedMedian = (values: Array<number | undefined>): number | undefined => {
	const list = values.filter((v): v is number => typeof v === "number");
	return list.length ? median(list) : undefined;
};

const endOf = (record: SpeedRecord): number =>
	typeof record.endedAt === "number"
		? record.endedAt
		: typeof record.ts === "number"
			? record.ts
			: typeof record.startedAt === "number"
				? record.startedAt
				: 0;

/** Generation speed of one record: explicit TPOT first, otherwise output over generation time. */
export const recordTokensPerSec = (record: SpeedRecord): number | undefined => {
	if (typeof record.tpotMs === "number" && record.tpotMs > 0) return 1000 / record.tpotMs;
	const ttft = record.ttftMs;
	const started = record.startedAt;
	const ended = record.endedAt;
	const out = record.tokensOut;
	if (typeof out !== "number" || out <= 0) return undefined;
	if (typeof ttft !== "number" || typeof started !== "number" || typeof ended !== "number") return undefined;
	const generationMs = ended - started - ttft;
	if (!Number.isFinite(generationMs) || generationMs <= 0) return undefined;
	return (out * 1000) / generationMs;
};

/** Records from the log tail that count as a measurement of `kind` inside the window. */
export function recentRecords(lines: string[], options: AggregateOptions): SpeedRecord[] {
	const cutoff = options.now - options.windowMs;
	const out: SpeedRecord[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let record: SpeedRecord;
		try {
			record = JSON.parse(line) as SpeedRecord;
		} catch {
			continue;
		}
		if (record.kind !== "sample" && record.kind !== "probe") continue;
		if (!record.model || !record.provider) continue;
		if (endOf(record) < cutoff) continue;
		out.push(record);
	}
	return out;
}

/** Per-model medians over the window, keyed by `provider/model`. */
export function aggregate(records: SpeedRecord[], options: AggregateOptions): Map<string, ModelStat> {
	const byKey = new Map<string, SpeedRecord[]>();
	for (const record of records) {
		const key = `${record.provider}/${record.model}`;
		const list = byKey.get(key);
		if (list) list.push(record);
		else byKey.set(key, [record]);
	}
	const stats = new Map<string, ModelStat>();
	for (const [key, list] of byKey) {
		const first = list[0];
		const timed = list.filter((r) => !r.error && !r.longCall && typeof r.ttftMs === "number");
		const small = timed.filter((r) => (r.promptTokens ?? 0) < options.largePromptTokens);
		const large = timed.filter((r) => (r.promptTokens ?? 0) >= options.largePromptTokens);
		const tps = list.map(recordTokensPerSec).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
		const probeTimes = list.filter((r) => r.kind === "probe").map(endOf);
		const allTimes = list.map(endOf);
		const tokensOut = list.reduce((sum, r) => sum + (typeof r.tokensOut === "number" ? r.tokensOut : 0), 0);
		const ttftMs = definedMedian(small.map((r) => r.ttftMs));
		const ttftLargeMs = definedMedian(large.map((r) => r.ttftMs));
		const tpotMs = definedMedian(list.map((r) => (r.error ? undefined : r.tpotMs)));
		stats.set(key, {
			provider: first.provider ?? "?",
			model: first.model ?? "?",
			key,
			n: timed.length,
			probeN: list.filter((r) => r.kind === "probe" && !r.error && typeof r.ttftMs === "number").length,
			turnN: list.filter((r) => r.kind === "sample" && !r.error && typeof r.ttftMs === "number").length,
			errors: list.filter((r) => Boolean(r.error)).length,
			ttftMs,
			ttftLargeMs,
			tpotMs,
			tokensPerSec: definedMedian(tps),
			tokensPerSecMean: tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : undefined,
			tokensOut: tokensOut > 0 ? tokensOut : undefined,
			lastAt: allTimes.length ? Math.max(...allTimes) : 0,
			lastProbeAt: probeTimes.length ? Math.max(...probeTimes) : undefined,
		});
	}
	return stats;
}

/** Stats sorted fastest-first; models without a TTFT measurement go last. */
export function sortedStats(stats: Map<string, ModelStat>, largePromptTokens: number, needTokens = 0): ModelStat[] {
	const value = (stat: ModelStat) =>
		needTokens >= largePromptTokens ? (stat.ttftLargeMs ?? stat.ttftMs) : (stat.ttftMs ?? stat.ttftLargeMs);
	return [...stats.values()].sort((a, b) => (value(a) ?? Number.POSITIVE_INFINITY) - (value(b) ?? Number.POSITIVE_INFINITY));
}
