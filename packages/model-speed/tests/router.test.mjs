// Router decisions for the ustc-auto virtual model: the pure half of "one selection, a
// physical model per request". Replays the incident that motivated it, not invented cases.
// Run: node --test packages/model-speed/tests/

import assert from "node:assert/strict";
import test from "node:test";

import { chooseRoute, estimateNeedTokens } from "../extensions/router.ts";

const now = 1_800_000_000_000;
const chain = ["dsf", "dsf2", "glm", "qwen"];

/** The 2026-11-25 pool: dsf fast, dsf2 fast but its newest answers were DSML garbage, glm slow. */
const pool = () => [
	{ id: "dsf", order: 0, ttftMs: 600 },
	{ id: "dsf2", order: 1, ttftMs: 300, invalid: true },
	{ id: "glm", order: 2, ttftMs: 1_900 },
	{ id: "qwen", order: 3, ttftMs: 380, contextWindow: 262_144 },
];

const route = (over = {}) =>
	chooseRoute({ candidates: pool(), chain, needTokens: 0, reason: "user", now, quarantineMs: 900_000, ...over });

test("garbage content loses to a measured healthy model, whatever the stopwatch says", () => {
	// dsf2 has the best TTFT in the pool. It is also the model that answered four lanes with
	// special-token noise and HTTP 200, so it must not be picked.
	assert.equal(route()?.modelId, "dsf");
});

test("the 256k model never takes a request that needs more than it holds", () => {
	const choice = route({ needTokens: 300_000 });
	assert.notEqual(choice?.modelId, "qwen");
	// With every 1M model quarantined it still refuses to overflow the context.
	const all = pool().map((candidate) => ({ ...candidate, invalid: true }));
	assert.notEqual(chooseRoute({ candidates: all, chain, needTokens: 300_000, reason: "user", now, quarantineMs: 0 })?.modelId, "qwen");
});

test("a continuation keeps the model that answered last, so the cache stays warm", () => {
	// glm is 3x slower than dsf, but mid-turn a switch costs the prompt cache and the
	// thinking signatures: only broken health is a reason to leave.
	assert.equal(route({ reason: "continuation", previousId: "glm" })?.modelId, "glm");
	assert.equal(route({ reason: "continuation", previousId: "dsf2" })?.modelId, "dsf");
});

test("a retry steps off the failed model and parks it", () => {
	const choice = route({ reason: "retry", failedId: "dsf", previousId: "dsf" });
	assert.notEqual(choice?.modelId, "dsf");
	assert.ok((choice?.state.quarantine?.dsf ?? 0) > now);
});

test("a quarantined model stays out until its window expires", () => {
	const state = { quarantine: { dsf: now + 60_000, dsf2: now + 60_000 } };
	// glm is 5x slower than qwen, so the clear-win rule promotes the later chain entry.
	assert.equal(route({ state })?.modelId, "qwen");
	// Expired quarantine is ignored rather than needing cleanup.
	assert.equal(route({ state: { quarantine: { dsf: now - 1 } } })?.modelId, "dsf");
});

test("a marginally faster later entry does not override the chain", () => {
	// 1.3x is not a clear win; the chain encodes capability (1M vision) as well as speed.
	assert.equal(route({ candidates: [{ id: "dsf", order: 0, ttftMs: 780 }, { id: "qwen", order: 1, ttftMs: 600, contextWindow: 262_144 }] })?.modelId, "dsf");
	// 2.5x is.
	assert.equal(route({ candidates: [{ id: "dsf", order: 0, ttftMs: 1_500 }, { id: "qwen", order: 1, ttftMs: 600, contextWindow: 262_144 }] })?.modelId, "qwen");
});

test("everything broken still answers instead of throwing", () => {
	const all = pool().map((candidate) => ({ ...candidate, invalid: true }));
	const choice = chooseRoute({ candidates: all, chain, needTokens: 0, reason: "user", now, quarantineMs: 900_000 });
	assert.ok(choice, "a doubtful model beats no request at all");
	assert.ok(chain.includes(choice.modelId));
});

test("chain order breaks ties between unmeasured models", () => {
	const unmeasured = chain.map((id, order) => ({ id, order }));
	assert.equal(chooseRoute({ candidates: unmeasured, chain, needTokens: 0, reason: "user", now, quarantineMs: 0 })?.modelId, "dsf");
});

test("an empty chain allows every candidate; an unknown candidate list yields nothing", () => {
	assert.equal(chooseRoute({ candidates: pool(), chain: [], needTokens: 0, reason: "user", now, quarantineMs: 0 })?.modelId, "dsf");
	assert.equal(chooseRoute({ candidates: [], chain, needTokens: 0, reason: "user", now, quarantineMs: 0 }), undefined);
});

test("context need is estimated from the conversation, not from a tokenizer", () => {
	const small = estimateNeedTokens([{ role: "user", content: "hi" }], 1_000);
	assert.ok(small >= 1_000 && small < 1_100, `headroom must dominate a tiny conversation, got ${small}`);
	const big = estimateNeedTokens([{ role: "assistant", content: "x".repeat(400_000) }], 0);
	// ~4 chars per token, plus the role label: the guard only needs the right order of magnitude.
	assert.ok(Math.abs(big - 100_000) < 20, `expected ~100k, got ${big}`);
	// Identifiers and timestamps are not conversation: they must not inflate the guard.
	const noisy = estimateNeedTokens([{ id: "a".repeat(10_000), timestamp: 1, content: "x" }], 0);
	assert.ok(noisy < 100);
});

test("CJK text is credited per character, not per four characters", () => {
	// Measured on the gateway 2026-11-25: 840 Chinese characters counted as 967 input tokens.
	// The old `chars / 4` gave 210, which would have handed a long Chinese session the 256k model.
	const cjk = "重复一下这句话以填充上下文。".repeat(60);
	const est = estimateNeedTokens([{ role: "user", content: cjk }], 0);
	assert.ok(est > 800 && est < 1_200, `expected ~1 token/char (gateway said 967), got ${est}`);
	// Mixed text stays between the two weights instead of collapsing to either extreme.
	const mixed = estimateNeedTokens([{ role: "user", content: cjk + "x".repeat(4_000) }], 0);
	assert.ok(mixed > est + 800 && mixed < est + 1_200, `latin part must add ~1000, got ${mixed - est}`);
	// A 300k-token Chinese session must be over the 256k model's window on the estimate alone,
	// with no live usage to fall back on (a resumed session's very first request).
	const long = estimateNeedTokens([{ role: "user", content: "中".repeat(300_000) }], 0);
	const choice = chooseRoute({
		candidates: [
			{ id: "qwen", order: 1, ttftMs: 300, contextWindow: 262_144 },
			{ id: "dsf", order: 0, ttftMs: 900, contextWindow: 1_000_000 },
		],
		chain: ["dsf", "qwen"],
		needTokens: long,
		reason: "user",
		now,
		quarantineMs: 0,
	});
	assert.equal(choice?.modelId, "dsf", `a 300k CJK session must not land on the 256k model (est ${long})`);
});
