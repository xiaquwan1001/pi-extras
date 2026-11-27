// The extension's own wiring, offline: a fake Pi API, a fake registry, no gateway.
//
// This is the layer the other tests do not reach — registration happens at extension load,
// `route()` is called by Pi, and the two commands are called from the TUI. Both were exercised
// only by hand before, which is how the async-registration race shipped (a child's first
// request beat `loadConfig()` and sent `ustc-auto` upstream: 400 Invalid model name).
//
// Run: node --test packages/model-speed/tests/

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configPath = join(mkdtempSync(join(tmpdir(), "pi-model-speed-")), "model-speed.json");
writeFileSync(
	configPath,
	JSON.stringify({
		virtual: {
			enabled: true,
			provider: "test-pool",
			id: "test-auto",
			name: "test-auto",
			chain: ["a", "b", "c"],
			contextWindow: 1_000_000,
			maxTokens: 100_000,
			quarantineMs: 60_000,
		},
	}),
);
process.env.PI_MODEL_SPEED_CONFIG = configPath;
process.env.PI_MODEL_SPEED_DIR = join(tmpdir(), `pi-model-speed-state-${process.pid}`);
process.env.PI_MODEL_SPEED_SAMPLING = "0";

const { default: modelSpeed } = await import("../extensions/index.ts");

const physical = (id, contextWindow = 1_000_000) => ({ provider: "test-pool", id, contextWindow, api: "openai-completions" });
const registry = {
	models: [physical("a"), physical("b"), physical("c"), physical("c", 262_144), { provider: "test-pool", id: "test-auto", api: "pi-virtual" }],
	getAvailable() {
		return this.models;
	},
	find(provider, id) {
		return this.models.find((model) => model.provider === provider && model.id === id && model.api !== "pi-virtual");
	},
};

/** Minimal ExtensionAPI stand-in: record what the extension registers. */
function fakePi() {
	const commands = new Map();
	const virtualModels = new Map();
	const tools = new Map();
	const handlers = new Map();
	return {
		commands,
		virtualModels,
		tools,
		handlers,
		on: (name, handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
		registerCommand: (name, def) => commands.set(name, def),
		registerVirtualModel: (definition) => virtualModels.set(`${definition.provider}/${definition.id}`, definition),
		registerTool: (definition) => tools.set(definition.name, definition),
		registerProvider: () => {},
		appendEntry: () => {},
	};
}

const STATE = process.env.PI_MODEL_SPEED_DIR;
mkdirSync(STATE, { recursive: true });
const LOG_PATH = join(STATE, "speed-log.jsonl");
/** One real-turn sample, in the shape the extension writes. */
function logSample(overrides = {}) {
	const now = Date.now();
	const entry = {
		kind: "sample",
		provider: "test-pool",
		model: "a",
		promptTokens: 1_000,
		startedAt: now - 2_000,
		endedAt: now - 500,
		ttftMs: 900,
		tokensOut: 50,
		...overrides,
	};
	writeFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, { flag: "a" });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const notifies = [];
const fakeCtx = {
	model: { provider: "test-pool", id: "test-auto" },
	modelRegistry: registry,
	getContextUsage: () => ({ tokens: 1_000 }),
	ui: { notify: (message, level) => notifies.push({ message, level }), setStatus: () => {}, setWidget: () => {} },
	sessionManager: { getSessionFile: () => undefined },
};

test("the virtual model is registered at extension load, not after the first async read", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	// Registration is synchronous: a child's first request must not outrun it.
	assert.ok(pi.virtualModels.has("test-pool/test-auto"), "registered before any async config load");
	const definition = pi.virtualModels.get("test-pool/test-auto");
	assert.deepEqual(definition.thinkingLevels.includes("minimal"), true);
});

test("route() picks a physical model from the chain and keeps the selection virtual", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	const definition = pi.virtualModels.get("test-pool/test-auto");
	const request = {
		model: { provider: "test-pool", id: "test-auto", api: "pi-virtual" },
		thinkingLevel: "minimal",
		reason: "user",
		messages: [{ role: "user", content: "hi" }],
	};
	const routed = definition.route(request, fakeCtx);
	assert.equal(routed.model.provider, "test-pool");
	assert.notEqual(routed.model.id, "test-auto", "never routes to the virtual model itself");
	assert.ok(["a", "b", "c"].includes(routed.model.id));
	assert.equal(routed.thinkingLevel, "minimal");
});

test("route() refuses the 256k model for a conversation that needs more", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	const definition = pi.virtualModels.get("test-pool/test-auto");
	const big = {
		model: { provider: "test-pool", id: "test-auto", api: "pi-virtual" },
		thinkingLevel: "minimal",
		reason: "user",
		messages: [{ role: "user", content: "x".repeat(1_200_000) }],
	};
	const routed = definition.route(big, { ...fakeCtx, getContextUsage: () => ({ tokens: 400_000 }) });
	assert.notEqual(routed.model.id, "c");
});

test("a retry inside the virtual model steps off the model that failed", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	const definition = pi.virtualModels.get("test-pool/test-auto");
	const request = {
		model: { provider: "test-pool", id: "test-auto", api: "pi-virtual" },
		thinkingLevel: "minimal",
		reason: "retry",
		previous: { model: physical("a"), thinkingLevel: "minimal" },
		failed: { model: physical("a"), thinkingLevel: "minimal", message: { stopReason: "error" } },
		messages: [{ role: "user", content: "hi" }],
	};
	const routed = definition.route(request, fakeCtx);
	assert.notEqual(routed.model.id, "a");
	assert.ok(routed.state?.quarantine?.a > Date.now());
});

test("/speed router and /speed pick answer without throwing and name a chain model", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	const speed = pi.commands.get("speed");
	assert.ok(speed, "speed is registered");
	// One command, not five: the old /speed-* spellings must be gone from the command list.
	assert.deepEqual([...pi.commands.keys()], ["speed"], "no leftover /speed-* commands");

	notifies.length = 0;
	await speed.handler("router", fakeCtx);
	assert.equal(notifies.length, 1);
	assert.match(notifies[0].message, /test-pool\/test-auto/);

	notifies.length = 0;
	await speed.handler("pick", fakeCtx);
	assert.equal(notifies.length, 1);
	// `pick` must hand out a provider-qualified id: a bare id is what pi-subagents
	// reports as `model_verification_failed`.
	assert.match(notifies[0].message, /dispatch model: test-pool\/[abc]/);
});

test("/speed autocompletes its subcommands with whole-argument values", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	const complete = pi.commands.get("speed").getArgumentCompletions;
	assert.equal(typeof complete, "function", "subcommands must be discoverable in the TUI");

	// Level 1: prefix filter, and a trailing space so arguments can follow.
	const all = complete("");
	assert.ok(all.some((item) => item.value === "stats " && item.label === "stats"));
	const pro = complete("pro");
	assert.deepEqual(pro.map((item) => item.value), ["probe "], "values keep the trailing space");
	assert.equal(complete("zzz"), null);

	// Level 2: arguments of one subcommand, still whole-argument values.
	const auto = complete("auto ");
	assert.deepEqual(auto.map((item) => item.value), ["auto on", "auto off"]);
	const forced = complete("probe --f");
	assert.deepEqual(forced.map((item) => item.value), ["probe --force"]);
	// Every level-2 value repeats its subcommand: pi replaces the whole argument text.
	const pick = complete("pick ");
	assert.deepEqual(pick.map((item) => item.value), ["pick retry"]);

	// An unknown word gets no invented suggestions.
	assert.equal(complete("stats "), null);
});

// ---- agent-facing health (audit 2026-11-27) ------------------------------
// The window used to reach only humans: `/speed pick` is a slash command, so agents kept
// dispatching on the hardcoded rotation. `model_health` and the injected prompt line are
// how the measured pool reaches a dispatch decision.

test("model_health is registered and answers with a recency-first pick", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	await tick();
	const tool = pi.tools.get("model_health");
	assert.ok(tool, "model_health registered");
	assert.match(tool.promptSnippet, /TTFT/);
	assert.ok(tool.promptGuidelines.some((line) => line.includes("model_health")), "guidelines must name the tool");

	logSample({ model: "a", ttftMs: 2_400 });
	logSample({ model: "b", ttftMs: 300 });
	logSample({ model: "c", ttftMs: 900 });
	const result = await tool.execute("call", { rank: "recent" }, undefined, undefined, fakeCtx);
	const text = result.content.map((part) => part.text).join("\n");
	assert.match(text, /pick\(recent\) = test-pool\/b/, "slowest-first chain must not beat a measured faster model");
	assert.equal(result.details.pick.id, "b");
	assert.equal(result.details.models.find((model) => model.id === "b").source, "recent");
	// The decision is logged with the evidence, so "the pick was right" stays checkable.
	const log = readFileSync(LOG_PATH, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const pick = log.filter((entry) => entry.kind === "pick").at(-1);
	assert.equal(pick.pick, "test-pool/b");
	assert.ok(pick.models.some((entry) => entry.startsWith("b=300/recent")));
});

test("before_agent_start injects one pool-health line from the measured window", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	const handler = pi.handlers.get("before_agent_start")?.at(-1);
	assert.ok(handler, "the awareness hook is registered");
	// An empty state dir has no measurements: the hook must add nothing rather than say
	// "no fresh samples" on every turn.
	// A real turn first: it appends through the extension's own logger, which is what
	// invalidates the 30 s stats cache (the hook itself should read the cache, not the disk).
	const before = pi.handlers.get("before_provider_request").at(-1);
	const end = pi.handlers.get("message_end").at(-1);
	await before({}, fakeCtx);
	await end({ message: { role: "assistant", stopReason: "end", content: [{ type: "text", text: "ok" }] } });
	logSample({ model: "b", ttftMs: 300 });
	const sections = {};
	await handler({ systemPromptOptions: { sections } }, fakeCtx);
	assert.match(sections["model-health"], /^\[model-health\] recent TTFT: /);
	assert.match(sections["model-health"], /pick=test-pool\/b/);
	assert.match(sections["model-health"], /dispatch: test-pool\/<pick>/);
});

test("a request that never reached message_end cannot steal the next request's timing", async () => {
	const pi = fakePi();
	await modelSpeed(pi);
	const before = pi.handlers.get("before_provider_request").at(-1);
	const end = pi.handlers.get("message_end").at(-1);
	const beforeCount = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean).length;
	// Two requests in flight: the first never sees `message_end` (aborted turn / watchdog park).
	const a = { ...fakeCtx, model: { provider: "test-pool", id: "a" } };
	const b = { ...fakeCtx, model: { provider: "test-pool", id: "b" } };
	await before({}, a);
	await before({}, b);
	const message = { role: "assistant", stopReason: "end", content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1_050, output: 50 } };
	await end({ message });
	await end({ message });
	const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").slice(beforeCount).map((line) => JSON.parse(line));
	const samples = lines.filter((entry) => entry.kind === "sample");
	assert.equal(samples.length, 2);
	// Newest request first: `pop()` pairs with the same entry `message_update` read.
	assert.equal(samples[0].model, "b");
	assert.equal(samples[1].model, "a");
});
