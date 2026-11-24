// Rolling-window aggregation: replay real log shapes, no gateway.
// Run: node --test packages/model-speed/tests/

import assert from "node:assert/strict";
import test from "node:test";

import { aggregate, recentRecords, recordTokensPerSec, sortedStats, sortedVerdicts, verdict } from "../extensions/stats.ts";

const now = 1_800_000_000_000;
const opts = { now, windowMs: 6 * 3_600_000, largePromptTokens: 30_000 };

const line = (entry) => JSON.stringify(entry);

const sample = (overrides) => ({
	kind: "sample",
	model: "ustc-dsf2",
	provider: "custom.ustc-pool",
	startedAt: now - 10_000,
	endedAt: now - 5_000,
	ttftMs: 4_000,
	tpotMs: 20,
	promptTokens: 1_000,
	tokensOut: 200,
	...overrides,
});

test("real turns and probe samples land in one window", () => {
	const lines = [
		line(sample({})),
		line(sample({ kind: "probe", ttftMs: 2_000, tpotMs: 10, tokensOut: 128 })),
		line(JSON.stringify({ kind: "session-end", samples: 3 })),
		line(JSON.stringify({ kind: "switch", from: "a", to: "b" })),
	];
	const records = recentRecords(lines, opts);
	assert.equal(records.length, 2);
	const stats = aggregate(records, opts);
	const stat = stats.get("custom.ustc-pool/ustc-dsf2");
	assert.equal(stat.n, 2);
	assert.equal(stat.turnN, 1);
	assert.equal(stat.probeN, 1);
	assert.equal(stat.ttftMs, 3_000); // median of 4000 and 2000
	assert.equal(stat.tokensPerSec, 75); // median of 50 and 100
	assert.equal(stat.tokensPerSecMean, 75);
	assert.equal(stat.lastProbeAt, now - 5_000);
});

test("the window drops old samples instead of averaging them in", () => {
	const old = sample({ startedAt: now - 7 * 3_600_000, endedAt: now - 7 * 3_600_000 + 5_000, ttftMs: 90_000 });
	const fresh = sample({ ttftMs: 1_000 });
	const stats = aggregate(recentRecords([line(old), line(fresh)], opts), opts);
	const stat = stats.get("custom.ustc-pool/ustc-dsf2");
	assert.equal(stat.n, 1);
	assert.equal(stat.ttftMs, 1_000);
});

test("TTFT is split by prompt size", () => {
	const small = sample({ ttftMs: 1_000, promptTokens: 2_000 });
	const large = sample({ ttftMs: 18_000, promptTokens: 120_000 });
	const stat = aggregate(recentRecords([line(small), line(large)], opts), opts).get("custom.ustc-pool/ustc-dsf2");
	assert.equal(stat.ttftMs, 1_000);
	assert.equal(stat.ttftLargeMs, 18_000);
	assert.equal(sortedStats(new Map([["k", stat]]), 30_000, 200_000)[0].ttftLargeMs, 18_000);
});

test("errors are counted but never become a median", () => {
	const ok = sample({ ttftMs: 3_000 });
	const failed = { kind: "probe", model: "ustc-dsf2", provider: "custom.ustc-pool", startedAt: now - 2_000, endedAt: now - 1_000, error: "timeout", status: "timeout" };
	const stat = aggregate(recentRecords([line(ok), line(failed)], opts), opts).get("custom.ustc-pool/ustc-dsf2");
	assert.equal(stat.n, 1);
	assert.equal(stat.errors, 1);
	assert.equal(stat.ttftMs, 3_000);
});

test("tokens/s falls back to measured output over generation time", () => {
	assert.equal(recordTokensPerSec({ startedAt: 1_000, endedAt: 4_000, ttftMs: 1_000, tokensOut: 200 }), 100);
	assert.equal(recordTokensPerSec({ tpotMs: 0, tokensOut: 10 }), undefined);
	assert.equal(recordTokensPerSec({ startedAt: 1_000, endedAt: 1_500, ttftMs: 600, tokensOut: 10 }), undefined);
});

// --- verdict: a stale fast number must not outvote a fresh slow one -------------
test("the recent cohort wins over an older, larger set of fast samples", () => {
	// The real shape behind the 2026-11-24 bug: glm got one 10.2 s probe after a long idle
	// gap, while the 6 h window still held four ~1.3 s probes from earlier hours.
	const recency = { ...opts, recentMs: 1_800_000 };
	const lines = [
		line(sample({ kind: "probe", ttftMs: 1_123, endedAt: now - 3 * 3_600_000, startedAt: now - 3 * 3_600_000 - 5_000 })),
		line(sample({ kind: "probe", ttftMs: 1_145, endedAt: now - 2 * 3_600_000, startedAt: now - 2 * 3_600_000 - 5_000 })),
		line(sample({ kind: "probe", ttftMs: 1_407, endedAt: now - 70 * 60_000, startedAt: now - 70 * 60_000 - 5_000 })),
		line(sample({ kind: "probe", ttftMs: 10_218, endedAt: now - 60_000, startedAt: now - 60_000 - 11_000 })),
	];
	const stat = aggregate(recentRecords(lines, recency), recency).get("custom.ustc-pool/ustc-dsf2");
	// The window median still exists and still says "fast"...
	assert.equal(stat.ttftMs, 1_276);
	// ... but the verdict is what ranking and /speed use, and it says slow.
	assert.equal(stat.recentN, 1);
	const fresh = verdict(stat, { now, largePromptTokens: 30_000, staleMs: 3_600_000 });
	assert.equal(fresh.source, "recent");
	assert.equal(fresh.ttftMs, 10_218);
});

test("without a recent sample the verdict falls back to the window, then refuses to rank", () => {
	const recency = { ...opts, recentMs: 1_800_000 };
	const old = line(sample({ ttftMs: 1_200, endedAt: now - 45 * 60_000, startedAt: now - 45 * 60_000 - 6_000 }));
	const stat = aggregate(recentRecords([old], recency), recency).get("custom.ustc-pool/ustc-dsf2");
	const windowed = verdict(stat, { now, largePromptTokens: 30_000, staleMs: 3_600_000 });
	assert.equal(windowed.source, "window");
	assert.equal(windowed.ttftMs, 1_200);
	// Past `staleMs` an old number is history, not evidence: no TTFT at all.
	const stale = verdict(stat, { now, largePromptTokens: 30_000, staleMs: 60_000 });
	assert.equal(stale.source, "stale");
	assert.equal(stale.ttftMs, undefined);
	assert.equal(
		verdict({ key: "x", provider: "p", model: "m", n: 0, probeN: 0, turnN: 0, errors: 0, lastAt: 0, recentN: 0, recentErrors: 0 }, { now, largePromptTokens: 30_000 }).source,
		"none",
	);
});

test("a fresh failure disqualifies a model that used to be fast", () => {
	const recency = { ...opts, recentMs: 1_800_000 };
	const ok = line(sample({ ttftMs: 900, endedAt: now - 40 * 60_000, startedAt: now - 40 * 60_000 - 2_000 }));
	const failed = JSON.stringify({
		kind: "probe",
		model: "ustc-dsf2",
		provider: "custom.ustc-pool",
		promptTokens: 2_000,
		startedAt: now - 46_000,
		endedAt: now - 1_000,
		error: "timeout",
		status: "timeout",
	});
	const stat = aggregate(recentRecords([ok, failed], recency), recency).get("custom.ustc-pool/ustc-dsf2");
	assert.equal(stat.recentErrors, 1);
	const current = verdict(stat, { now, largePromptTokens: 30_000, staleMs: 3_600_000 });
	assert.equal(current.source, "stale");
	assert.equal(current.ttftMs, undefined);
});

test("the verdict reads the prompt-size bucket the session will use", () => {
	const stick = aggregate(recentRecords([line(sample({ ttftMs: 1_000, promptTokens: 1_000 })), line(sample({ ttftMs: 18_000, promptTokens: 200_000 }))], opts), opts).get(
		"custom.ustc-pool/ustc-dsf2",
	);
	assert.equal(verdict(stick, { now, largePromptTokens: 30_000, needTokens: 2_000 }).ttftMs, 1_000);
	assert.equal(verdict(stick, { now, largePromptTokens: 30_000, needTokens: 200_000 }).ttftMs, 18_000);
});

test("sorted verdicts put fresh fast models first and unknown models last", () => {
	const recency = { ...opts, recentMs: 1_800_000 };
	const stats = aggregate(
		recentRecords(
			[
				line(sample({ model: "fresh-slow", ttftMs: 9_000 })),
				line(sample({ model: "fresh-fast", ttftMs: 900 })),
				line(sample({ model: "ancient", ttftMs: 400, endedAt: now - 5 * 3_600_000, startedAt: now - 5 * 3_600_000 - 2_000 })),
			],
			recency,
		),
		recency,
	);
	// Widen the window so the ancient sample is inside it, then let `staleMs` disqualify it.
	const order = sortedVerdicts(stats, { now, largePromptTokens: 30_000, staleMs: 6 * 3_600_000 }).map((entry) => entry.stat.model);
	assert.deepEqual(order, ["ancient", "fresh-fast", "fresh-slow"]);
	const staleOrder = sortedVerdicts(stats, { now, largePromptTokens: 30_000, staleMs: 60_000 }).map((entry) => entry.stat.model);
	assert.equal(staleOrder.at(-1), "ancient", "a stale model is unknown, not fast");
});
