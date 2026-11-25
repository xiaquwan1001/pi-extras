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
import { mkdtempSync, writeFileSync } from "node:fs";
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
	return {
		commands,
		virtualModels,
		on: () => () => {},
		registerCommand: (name, def) => commands.set(name, def),
		registerVirtualModel: (definition) => virtualModels.set(`${definition.provider}/${definition.id}`, definition),
		registerProvider: () => {},
		appendEntry: () => {},
	};
}

const notifies = [];
const fakeCtx = {
	model: { provider: "test-pool", id: "test-auto" },
	modelRegistry: registry,
	getContextUsage: () => ({ tokens: 1_000 }),
	ui: { notify: (message, level) => notifies.push({ message, level }), setStatus: () => {}, setWidget: () => {} },
	sessionManager: { getSessionFile: () => undefined },
};

test("the virtual model is registered at extension load, not after the first async read", () => {
	const pi = fakePi();
	modelSpeed(pi);
	// Registration is synchronous: a child's first request must not outrun it.
	assert.ok(pi.virtualModels.has("test-pool/test-auto"), "registered before any async config load");
	const definition = pi.virtualModels.get("test-pool/test-auto");
	assert.deepEqual(definition.thinkingLevels.includes("minimal"), true);
});

test("route() picks a physical model from the chain and keeps the selection virtual", () => {
	const pi = fakePi();
	modelSpeed(pi);
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

test("route() refuses the 256k model for a conversation that needs more", () => {
	const pi = fakePi();
	modelSpeed(pi);
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

test("a retry inside the virtual model steps off the model that failed", () => {
	const pi = fakePi();
	modelSpeed(pi);
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

test("/speed-router and /speed-pick answer without throwing and name a chain model", async () => {
	const pi = fakePi();
	modelSpeed(pi);
	const router = pi.commands.get("speed-router");
	assert.ok(router, "speed-router is registered");
	notifies.length = 0;
	await router.handler("", fakeCtx);
	assert.equal(notifies.length, 1);
	assert.match(notifies[0].message, /test-pool\/test-auto/);

	const pick = pi.commands.get("speed-pick");
	assert.ok(pick, "speed-pick is registered");
	notifies.length = 0;
	await pick.handler("", fakeCtx);
	assert.equal(notifies.length, 1);
	// `/speed-pick` must hand out a provider-qualified id: a bare id is what pi-subagents
	// reports as `model_verification_failed`.
	assert.match(notifies[0].message, /dispatch model: test-pool\/[abc]/);
});
