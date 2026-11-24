// Rolling-window aggregation: replay real log shapes, no gateway.
// Run: node --test packages/model-speed/tests/

import assert from "node:assert/strict";
import test from "node:test";

import { aggregate, recentRecords, recordTokensPerSec, sortedStats } from "../extensions/stats.ts";

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
