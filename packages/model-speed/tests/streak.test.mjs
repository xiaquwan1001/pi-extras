// Regression test for the failover decision, replaying real samples.
// Run: node --test packages/model-speed/tests/
//
// The samples below are lane U from ~/.cache/pi-model-speed/speed-log.jsonl
// (pid 1029769, custom.ustc-pool/ustc-dsf, 2026-11-23 20:56–22:10). That lane burned
// 73 minutes and produced nothing: four consecutive turns had TTFT 147s/130s/904s/303s
// and the extension never switched. Cause: the old streak check dropped the whole streak
// when *any* sample had started more than `cooldownMs` ago — with minute-long turns that
// is always true, so failover was dead exactly on the gateway it exists for.

import assert from "node:assert/strict";
import test from "node:test";

import { evaluateStreak } from "../extensions/index.ts";

const sample = (endedAt, startedAt, ttftMs, promptTokens) => ({
	model: "ustc-dsf",
	provider: "custom.ustc-pool",
	startedAt,
	endedAt,
	ttftMs,
	promptTokens,
});

// endedAt values are the log write times; startedAt = endedAt - ttftMs.
const laneU = [
	sample(1795438717244, 1795438717244 - 146950, 146950, 5022),
	sample(1795438854938, 1795438854938 - 129981, 129981, 8026),
	sample(1795439760353, 1795439760353 - 904348, 904348, 9187),
	sample(1795440091732, 1795440091732 - 303426, 303426, 10601),
	sample(1795440462321, 1795440462321 - 328442, 328442, 12536),
];

const config = (overrides = {}) => ({
	auto: true,
	providers: ["custom.ustc-pool"],
	candidates: ["ustc-dsf2", "ustc-glm"],
	thresholds: {
		ttftSmallMs: 12_000,
		ttftLargeMs: 25_000,
		largePromptTokens: 30_000,
		tpotMs: 250,
		turnWallMs: 90_000,
		stallMs: 180_000,
		...overrides.thresholds,
	},
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
	...overrides,
});

test("lane U: four slow turns on a warm session must yield a streak", () => {
	// The moment the third turn ended (21:16:00) — the first point where switching was due.
	const now = laneU[2].endedAt;
	assert.notEqual(evaluateStreak(laneU.slice(0, 3), config(), true, now), null);
	// And one turn later it must still hold: this is where the old rule had already died.
	assert.notEqual(evaluateStreak(laneU.slice(0, 4), config(), true, laneU[3].endedAt), null);
});

test("the old rule would have declared the same streak stale", () => {
	// Keeps the regression honest: this is exactly what used to return early.
	const now = laneU[2].endedAt;
	const tail = laneU.slice(0, 3);
	assert.equal(tail.some((s) => now - s.startedAt > 600_000), true);
});

test("an idle session's ancient samples do not switch anything", () => {
	const now = laneU[4].endedAt + 3_600_000; // an hour with no activity
	assert.equal(evaluateStreak(laneU, config(), true, now), null);
});

test("recent samples outside the streak window are dropped, not fatal", () => {
	// Fresh fast turns after a long pause: nothing slow remains recent enough.
	const now = 1795450000000;
	const fresh = [
		sample(now - 3000, now - 6000, 3000, 1000),
		sample(now - 2000, now - 4000, 2000, 1200),
		sample(now - 1000, now - 2500, 1500, 1400),
	];
	assert.equal(evaluateStreak(fresh, config(), true, now), null);
});

test("a single slow turn is not a streak", () => {
	assert.equal(evaluateStreak(laneU.slice(0, 1), config(), true, laneU[0].endedAt), null);
});

test("unbound small prompts trip at the plain thresholds", () => {
	const base = 1795460000000;
	const slow = [
		sample(base - 40_000, base - 53_000, 13_000, 2_000),
		sample(base - 30_000, base - 43_000, 13_000, 2_200),
		sample(base - 20_000, base - 33_000, 13_000, 2_400),
	];
	assert.notEqual(evaluateStreak(slow, config(), false, base), null);
	// A 60 s+ TTFT on a bound session is still over the absolute floor.
	assert.equal(evaluateStreak(slow, config(), true, base), null);
});
