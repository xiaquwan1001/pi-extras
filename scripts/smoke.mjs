/**
 * Offline self-checks for the repository. No network, no Pi process, no model calls.
 *
 *   npm run smoke
 *
 * 1. fabric-agent-echo: build a fake Fabric run root (owner file, status.json,
 *    events.jsonl) and assert the parser picks the right runs and rebuilds the
 *    conversation, including nested runs, filters, and dedupe.
 * 2. fabric-hardening: build a fake package tree that contains every upstream
 *    snippet, assert every patch applies, is idempotent on a second pass, and
 *    leaves syntactically valid files (node --check).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { collectRuns, buildTranscript, ownedRoots, statusFiles } = await import(
	"../packages/fabric-agent-echo/extensions/core.ts"
);
const { applyPatches, PATCHES } = await import("../packages/fabric-hardening/extensions/patches.ts");

const root = mkdtempSync(join(tmpdir(), "pi-extras-smoke-"));
const passed = [];
const check = (name, fn) => {
	try {
		fn();
		passed.push(name);
	} catch (error) {
		console.error(`FAIL ${name}\n${error.stack ?? error}`);
		process.exitCode = 1;
	}
};

// ---------------------------------------------------------------- agent-echo
const tmpRoot = join(root, "tmp");
const runsRoot = join(tmpRoot, "pi-fabric-runs-test1");
const fakePid = 4242;

function writeRun(id, record, events) {
	const dir = join(runsRoot, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), JSON.stringify({ id, ...record }));
	writeFileSync(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
}

mkdirSync(runsRoot, { recursive: true });
writeFileSync(join(runsRoot, ".fabric-owner.json"), JSON.stringify({ pid: fakePid }));

writeRun(
	"aaa111",
	{ status: "completed", name: "summarize docs", model: "gw/m1", turns: 2, toolCalls: 1, startedAt: 1000, finishedAt: 2000, usage: { input: 1000, output: 20 } },
	[
		{ type: "extension_ui_request", method: "notify", message: "noise" },
		{ type: "message_end", message: { role: "system", content: "ignored" } },
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "read the docs" }] } },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "not shown" },
					{ type: "text", text: "I will grep." },
					{ type: "toolCall", name: "grep", arguments: { pattern: "TODO", path: "docs" } },
				],
			},
		},
		{ type: "message_end", message: { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "docs/a.md: TODO" }] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done: 1 TODO." }] } },
	],
);
// still running -> must be ignored
writeRun("bbb222", { status: "running", name: "still working", startedAt: 1500 }, []);
// persistent actor -> must be ignored
writeRun("ccc333", { status: "completed", name: "actor", actorId: "actor-1", startedAt: 1000, finishedAt: 2000 }, []);
// failed run -> included
writeRun("ddd444", { status: "failed", name: "broken", startedAt: 1000, finishedAt: 3000, logFile: join(runsRoot, "ddd444", "events.jsonl") }, []);
// nested run (child of a child) with its own status.json
writeRun("eee555", { status: "completed", name: "nested", startedAt: 1000, finishedAt: 2500 }, []);
const nestedDir = join(runsRoot, "aaa111", "nested");
mkdirSync(nestedDir, { recursive: true });
writeFileSync(join(nestedDir, "status.json"), JSON.stringify({ id: "aaa111-nested", status: "completed", name: "leaf", startedAt: 1100, finishedAt: 1200 }));
writeFileSync(join(nestedDir, "events.jsonl"), JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "leaf task" }] } }) + "\n");

check("agent-echo: finds only this pid's run roots", () => {
	assert.deepEqual(ownedRoots(fakePid, tmpRoot), [runsRoot]);
	assert.deepEqual(ownedRoots(fakePid + 1, tmpRoot), []);
});

check("agent-echo: finds nested status files", () => {
	assert.equal(statusFiles(runsRoot).length, 6);
});

check("agent-echo: collects terminal, non-actor runs (nested included), oldest first", () => {
	const runs = collectRuns({ pid: fakePid, tmpRoot, since: 0 });
	const ids = runs.map((run) => run.id);
	assert.deepEqual(ids, ["aaa111-nested", "aaa111", "eee555", "ddd444"]);
	const broken = runs.find((run) => run.id === "ddd444");
	assert.equal(broken.status, "failed");
});

check("agent-echo: rebuilds the conversation and drops thinking", () => {
	const first = collectRuns({ pid: fakePid, tmpRoot, since: 0, idFilter: "aaa111" }).find((run) => run.id === "aaa111");
	const text = first.transcript.join("\n");
	assert.match(text, /▸ user: read the docs/);
	assert.match(text, /⚙ grep\(\{"pattern":"TODO","path":"docs"\}\)/);
	assert.match(text, /← grep: docs\/a\.md: TODO/);
	assert.match(text, /▸ assistant: Done: 1 TODO\./);
	assert.doesNotMatch(text, /not shown/);
	assert.doesNotMatch(text, /noise/);
});

check("agent-echo: honors since / idFilter / skip", () => {
	assert.equal(collectRuns({ pid: fakePid, tmpRoot, since: 2000 }).length, 3); // finishedAt >= 2000
	assert.equal(collectRuns({ pid: fakePid, tmpRoot, since: 0, idFilter: "eee" }).length, 1);
	assert.equal(
		collectRuns({ pid: fakePid, tmpRoot, since: 0, skip: (id) => id !== "ddd444" }).length,
		1,
	);
});

check("agent-echo: falls back when the transcript is gone", () => {
	const record = { id: "x", status: "completed" };
	assert.deepEqual(buildTranscript(record, join(root, "nope", "status.json")), ["(events.jsonl was cleaned up or has expired)"]);
});

// resumable runs (agents.childSession) live under the cache, keyed by Pi session id
const cacheBase = join(root, "cache", "pi-fabric", "runs");
const cacheRun = (session, id, finishedAt) => {
	const dir = join(cacheBase, session, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), JSON.stringify({ id, status: "completed", name: `run ${id}`, startedAt: finishedAt - 1000, finishedAt }));
	writeFileSync(
		join(dir, "events.jsonl"),
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `done ${id}` }] } }) + "\n",
	);
};
const mineId = "1".repeat(32);
const otherId = "2".repeat(32);
cacheRun("session-a", mineId, 5000);
cacheRun("session-b", otherId, 5000);

check("agent-echo: finds resumable runs kept under the cache for this session only", () => {
	const found = collectRuns({ pid: fakePid, tmpRoot, sessionId: "session-a", cacheBase, since: 0 }).map((run) => run.id);
	assert.ok(found.includes(mineId));
	assert.equal(found.includes(otherId), false);
	const other = collectRuns({ pid: fakePid, tmpRoot, sessionId: "session-b", cacheBase, since: 0 }).map((run) => run.id);
	assert.ok(other.includes(otherId));
	assert.equal(other.includes(mineId), false);
	// No session id: the cache root is not scanned at all (other sessions are not ours).
	const none = collectRuns({ pid: fakePid, tmpRoot, cacheBase, since: 0 });
	assert.equal(none.some((run) => run.id === mineId || run.id === otherId), false);
});

// -------------------------------------------------------------- hardening
const npmDir = join(root, "node_modules");
const fabDist = join(npmDir, "pi-fabric", "dist");
const chunkDir = join(fabDist, "chunks");
const foldExt = join(npmDir, "pi-fold", "extensions");
mkdirSync(chunkDir, { recursive: true });
mkdirSync(foldExt, { recursive: true });
mkdirSync(join(fabDist, "worker"), { recursive: true });
writeFileSync(join(npmDir, "pi-fabric", "package.json"), JSON.stringify({ name: "pi-fabric", type: "module" }));
writeFileSync(join(npmDir, "pi-fold", "package.json"), JSON.stringify({ name: "pi-fold", type: "module" }));
// upstream text, spread over renamed chunk files like the real build
writeFileSync(
	join(chunkDir, "chunk-AAA.js"),
	'var writeRecord = (filePath, record) => {\n  writeJsonAtomic(filePath, record, { space: 2 });\n};\nvar x = 1;\n',
);
writeFileSync(
	join(chunkDir, "chunk-BBB.js"),
	'var RETRYABLE_RENAME_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EEXIST", "EBUSY"]);\nexport { RETRYABLE_RENAME_CODES };\n',
);
writeFileSync(
	join(chunkDir, "chunk-CCC.js"),
	'var RETRYABLE_RENAME_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EEXIST", "EBUSY"]);\nexport { RETRYABLE_RENAME_CODES };\n',
);
writeFileSync(join(fabDist, "worker", "recovery-watchdog.js"), "var PI_RECOVERY_TIMEOUT_MS = 6e4;\nexport { PI_RECOVERY_TIMEOUT_MS };\n");
writeFileSync(
	join(fabDist, "worker.js"),
	[
		"const runnerLabel = (r) => r;",
		"export async function run(options) {",
		"  const exitCode = await new Promise((resolve) => {",
		'    child.once("close", (code) => resolve(code));',
		"  });",
		"  record.exitCode = exitCode;",
		"  record.stderr = stderr.slice(-MAX_STDERR_CHARS);",
		'  if (record.status === "failed" && !record.error) {',
		'    record.error = stderr.trim() || (exitCode === 0 ? `${runnerLabel(options.runner)} agent reported an error before exiting` : `${runnerLabel(options.runner)} exited with code ${exitCode ?? "unknown"}`);',
		"  }",
		"}",
	].join("\n"),
);
writeFileSync(
	join(foldExt, "evidence.js"),
	[
		"export function ingest({ sessionFile }) {",
		'  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) {',
		'    throw new Error("Evidence ingestion requires an absolute Pi session file");',
		"  }",
		"  return true;",
		"}",
	].join("\n"),
);
writeFileSync(
	join(fabDist, "worker", "model-control.js"),
	[
		"class PiModelControl {",
		"  #expected;",
		"  #failed = false;",
		'  #admission = "strict";',
		"  observeAssistant(message) {",
		'    if (message.role !== "assistant") return;',
		"    const actual = identity({ provider: message.provider, id: message.model });",
		"    if (actual) this.io.observed(key(actual));",
		"    if (this.#failed) return;",
		"    if (this.requested && !this.ready) {",
		'      this.fail("child emitted an assistant message before model admission");',
		'    } else if (this.#admission === "strict" && this.#expected && (!actual || key(actual) !== key(this.#expected))) {',
		'      this.fail(`requested ${key(this.#expected)}, but assistant reports ${actual ? key(actual) : "missing model attribution"}; terminating child`);',
		"    }",
		"  }",
		"}",
		"export { PiModelControl };",
	].join("\n"),
);

const growDist = join(npmDir, "@llblab", "pi-grow-loop", "dist");
mkdirSync(growDist, { recursive: true });
writeFileSync(
	join(npmDir, "@llblab", "pi-grow-loop", "package.json"),
	JSON.stringify({ name: "@llblab/pi-grow-loop", type: "module" }),
);
// Upstream text of the grow-loop patches: the tool's execute prologue, the two
// checkpoint sentences, and the stop guideline line.
writeFileSync(
	join(growDist, "index.js"),
	[
		"class GrowLoop {",
		"        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {",
		"            lastCtx = ctx;",
		"        return { lastCtx };",
		"    }",
		"}",
		"const guideline = [",
		'            "To stop, do not call grow_loop; finish with a concise stop proof.",',
		"];",
		"const checkpoint = [already",
		'                            ? `\\nTool grow_loop was already called this turn. Iteration #${nextIteration} remains scheduled; delay updated to ${delayMs / 1000}s`',
		'                            : `\\nGrow Loop iteration #${nextIteration} deferred until idle, then scheduled after ${delayMs / 1000}s delay`,',
		"];",
		"export { GrowLoop, guideline, checkpoint };",
	].join("\n"),
);

const first = applyPatches({ npmDir });
const second = applyPatches({ npmDir });

check("hardening: every patch applies to the upstream text", () => {
	assert.deepEqual(
		first.applied.map((entry) => entry.id).sort(),
		PATCHES.map((patch) => patch.id).sort(),
	);
	assert.equal(first.skipped.length, 0);
});

check("hardening: applies to files found by content, not by name", () => {
	const rename = first.applied.find((entry) => entry.id === "rename-quota-retry");
	assert.equal(rename.files.length, 2);
});

check("hardening: second pass is a no-op", () => {
	assert.equal(second.applied.length, 0);
	assert.equal(second.already.length, PATCHES.length);
});

check("hardening: patched files still parse", () => {
	const files = first.applied.flatMap((entry) => entry.files);
	assert.ok(files.length >= PATCHES.length);
	for (const file of files) {
		const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
		assert.equal(result.status, 0, `${file}: ${result.stderr}`);
	}
});

check("hardening: missing package fails soft", () => {
	const report = applyPatches({ npmDir: join(root, "empty-node-modules") });
	assert.equal(report.applied.length, 0);
	assert.ok(report.skipped.every((entry) => entry.reason === "missing"));
});

check("hardening: include/exclude selection", () => {
	const report = applyPatches({ npmDir, include: ["status-write-guard"] });
	assert.ok(report.skipped.every((entry) => entry.reason === "disabled"));
	const excluded = applyPatches({ npmDir, exclude: PATCHES.map((patch) => patch.id) });
	assert.equal(excluded.applied.length, 0);
});

rmSync(root, { recursive: true, force: true });

// -------------------------------------------------------------- model-speed
// A Fabric child that switches model is terminated by the parent's model admission,
// so the extension must refuse the switch even when /speed-auto asks for it.
{
	const name = "model-speed: a Fabric child cannot switch models";
	const previous = process.env.PI_FABRIC_LINEAGE;
	process.env.PI_FABRIC_LINEAGE = '{"version":1,"rootSessionId":"t","runId":"t","depth":1,"childIndex":0,"worker":true}';
	try {
		const modelSpeed = await import("../packages/model-speed/extensions/index.ts");
		const commands = new Map();
		const notices = [];
		modelSpeed.default({ on: () => {}, registerCommand: (id, definition) => commands.set(id, definition) });
		const command = commands.get("speed-auto");
		assert.ok(command, "/speed-auto is registered");
		await command.handler("on", { ui: { notify: (message) => notices.push(message) } });
		assert.match(notices.at(-1) ?? "", /pinned off/);
		passed.push(name);
	} catch (error) {
		console.error(`FAIL ${name}\n${error.stack ?? error}`);
		process.exitCode = 1;
	} finally {
		if (previous === undefined) delete process.env.PI_FABRIC_LINEAGE;
		else process.env.PI_FABRIC_LINEAGE = previous;
	}
}

// A pi-subagents child is launched on a model its parent named, and the run is failed
// with model_verification_failed if the child then reports a different one. Same pin.
check("model-speed: a pi-subagents child cannot switch models", () => {
	const script = `
		const modelSpeed = await import(${JSON.stringify(new URL("../packages/model-speed/extensions/index.ts", import.meta.url).href)});
		const commands = new Map();
		const notices = [];
		modelSpeed.default({ on: () => {}, registerCommand: (id, definition) => commands.set(id, definition) });
		await commands.get("speed-auto").handler("on", { ui: { notify: (m) => notices.push(m) } });
		process.stdout.write(notices.at(-1) ?? "");
	`;
	const env = { ...process.env, PI_SUBAGENT_CHILD: "1" };
	for (const key of ["PI_FABRIC_LINEAGE", "PI_FABRIC_DEPTH", "PI_FABRIC_AGENT_NAME", "PI_FABRIC_MODEL_PIN", "PI_MODEL_SPEED_ALLOW_CHILD"]) delete env[key];
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pinned off/);
	assert.match(result.stdout, /pi-subagents/);
});

// The switch budget and the model a session stepped onto must survive a reload/resume:
// a fresh extension instance that forgets them hands a resumed conversation a new budget
// and a legal path back to the model it just left.
check("model-speed: a reloaded session remembers its switch budget", () => {
	const state = mkdtempSync(join(tmpdir(), "pi-extras-ms-state-"));
	const config = join(state, "config.json");
	writeFileSync(config, JSON.stringify({ auto: true, providers: ["custom.ustc-pool"], probe: {}, sampling: { enabled: false } }));
	const key = "2026-11-24T12-00_sess1";
	const now = Date.now();
	// Recent enough that `evaluateStreak` treats them as a live streak (`streakMaxAgeMs`).
	const slow = (ageMs) => JSON.stringify({ kind: "sample", session: key, model: "ustc-glm", provider: "custom.ustc-pool", ttftMs: 120_000, promptTokens: 4_000, startedAt: now - 120_000 - ageMs, endedAt: now - ageMs });
	writeFileSync(join(state, "speed-log.jsonl"), [slow(300_000), slow(200_000), slow(100_000)].join("\n") + "\n");
	writeFileSync(
		join(state, "switch-state.json"),
		JSON.stringify({
			sessions: {
				[key]: { switches: 3, target: "ustc-dsf2", lastSwitchAt: 1_000, startedAt: 900, abandoned: [{ from: "ustc-dsf", to: "ustc-dsf2", at: 1_000 }], updatedAt: 1_000 },
			},
		}),
	);
	const script = `
		const modelSpeed = await import(${JSON.stringify(new URL("../packages/model-speed/extensions/index.ts", import.meta.url).href)});
		const handlers = new Map();
		const notes = [];
		let switched = null;
		const model = { id: "ustc-dsf2", provider: "custom.ustc-pool" };
		const ctx = {
			model,
			ui: { notify: (m) => notes.push(m), setStatus: () => {}, setWidget: () => {} },
			sessionManager: { getSessionFile: () => "/sessions/${key}.jsonl" },
			modelRegistry: {
				getAvailable: () => [model, { id: "ustc-dsf", provider: "custom.ustc-pool" }, { id: "ustc-dsf2", provider: "custom.ustc-pool" }],
				find: (_p, id) => ({ id, provider: "custom.ustc-pool" }),
			},
			getContextUsage: () => ({ tokens: 4_000 }),
		};
		modelSpeed.default({
			on: (name, fn) => handlers.set(name, fn),
			registerCommand: () => {},
			setModel: async (target) => { switched = target.id; return true; },
		});
		await handlers.get("session_start")({ reason: "reload", previousSessionFile: "/sessions/${key}.jsonl" }, ctx);
		await handlers.get("turn_end")({}, ctx);
		process.stdout.write(JSON.stringify({ switched, notes }));
	`;
	const env = { ...process.env, PI_MODEL_SPEED_DIR: state, PI_MODEL_SPEED_CONFIG: config, PI_MODEL_SPEED_SAMPLING: "0" };
	for (const k of ["PI_FABRIC_LINEAGE", "PI_SUBAGENT_CHILD", "PI_MODEL_SPEED_ALLOW_CHILD"]) delete env[k];
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const out = JSON.parse(result.stdout);
	// The budget was already spent before the reload. A fresh instance would see 0/3 and
	// switch again; the restored session refuses, and never steps onto `ustc-dsf`, which it
	// abandoned one switch ago.
	assert.equal(out.switched, null, "a resumed session keeps its spent switch budget");
	const log = readFileSync(join(state, "speed-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const skip = log.filter((entry) => entry.kind === "switch-skip").at(-1);
	assert.ok(skip, "the refusal is logged");
	assert.match(skip.reason, /switch budget spent \(3\/3\)/);
	rmSync(state, { recursive: true, force: true });
});

// Ranking must read the fresh measurement, not the 6 h median: with long idle gaps the
// median is a museum piece that names a model fast long after it went slow.
check("model-speed: a fresh slow probe outranks an old fast median", () => {
	const state = mkdtempSync(join(tmpdir(), "pi-extras-ms-window-"));
	const config = join(state, "config.json");
	writeFileSync(config, JSON.stringify({ auto: false, probe: {}, sampling: { enabled: false }, stats: { windowMs: 21_600_000, recentMs: 1_800_000, staleMs: 3_600_000 } }));
	const now = Date.now();
	const probe = (ttftMs, ageMs) =>
		JSON.stringify({
			kind: "probe",
			session: "old",
			model: "ustc-glm",
			provider: "custom.ustc-pool",
			ttftMs,
			promptTokens: 2_000,
			startedAt: now - ageMs - ttftMs,
			endedAt: now - ageMs,
		});
	const lines = [probe(1_123, 3 * 3_600_000), probe(1_145, 2 * 3_600_000), probe(1_407, 3_600_000), probe(10_218, 60_000)];
	writeFileSync(join(state, "speed-log.jsonl"), lines.join("\n") + "\n");
	const script = `
		const modelSpeed = await import(${JSON.stringify(new URL("../packages/model-speed/extensions/index.ts", import.meta.url).href)});
		const handlers = new Map();
		const commands = new Map();
		const notes = [];
		const model = { id: "ustc-dsf", provider: "custom.ustc-pool" };
		const ctx = {
			model,
			ui: { notify: (m) => notes.push(m), setStatus: () => {}, setWidget: () => {} },
			sessionManager: { getSessionFile: () => undefined },
			modelRegistry: { getAvailable: () => [model, { id: "ustc-glm", provider: "custom.ustc-pool" }], find: (_p, id) => ({ id, provider: "custom.ustc-pool" }) },
			getContextUsage: () => ({ tokens: 2_000 }),
		};
		modelSpeed.default({ on: (n, f) => handlers.set(n, f), registerCommand: (id, d) => commands.set(id, d), setModel: async () => true });
		await commands.get("speed").handler("", ctx);
		process.stdout.write(notes.join("\\n"));
	`;
	const env = { ...process.env, PI_MODEL_SPEED_DIR: state, PI_MODEL_SPEED_CONFIG: config, PI_MODEL_SPEED_SAMPLING: "0" };
	for (const k of ["PI_FABRIC_LINEAGE", "PI_SUBAGENT_CHILD", "PI_MODEL_SPEED_ALLOW_CHILD"]) delete env[k];
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /ustc-glm: TTFT 10\.2s/, result.stdout);
	assert.doesNotMatch(result.stdout, /ustc-glm: TTFT 1\.4s/, result.stdout);
	rmSync(state, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fabric-resume
{
	const { createHash } = await import("node:crypto");
	const { existsSync, readFileSync: readFile, writeFileSync: writeFile } = await import("node:fs");
	const { gzipSync } = await import("node:zlib");
	const { applyResumeOverlay, extractDistTarGz } = await import("../packages/fabric-resume/extensions/overlay.ts");
	const resumePackage = join(root, "fabric-resume-source");
	const overlayDir = join(resumePackage, "overlay");
	mkdirSync(overlayDir, { recursive: true });
	// Reuse the real overlay shipped with the package: the test proves the artifact,
	// not a fixture that could drift from it.
	const realPackage = new URL("../packages/fabric-resume/", import.meta.url);
	const manifest = JSON.parse(readFile(new URL("overlay/manifest.json", realPackage), "utf8"));
	for (const file of ["overlay/manifest.json", manifest.tar]) {
		writeFile(join(resumePackage, file), readFile(new URL(file, realPackage)));
	}

	const npmDir = join(root, "npm");
	const target = join(npmDir, "pi-fabric");
	mkdirSync(target, { recursive: true });
	writeFile(join(target, "package.json"), JSON.stringify({ name: "pi-fabric", version: manifest.upstream }));
	writeFile(join(target, "dist-sentinel.txt"), "before");
	mkdirSync(join(target, "dist"), { recursive: true });
	writeFile(join(target, "dist", "chunk-old.js"), "stale build\n");

	check("fabric-resume: applies the shipped overlay to the matching upstream release", () => {
		const result = applyResumeOverlay({ packageRoot: resumePackage, npmDir, now: 1 });
		assert.equal(result.status, "applied");
		assert.equal(result.written, manifest.files.length);
		const marker = JSON.parse(readFile(join(target, manifest.marker), "utf8"));
		assert.equal(marker.build, manifest.build);
		const worker = readFile(join(target, "dist", "worker.js"));
		const digest = createHash("sha256").update(worker).digest("hex");
		assert.equal(digest, manifest.files.find((file) => file.path === "dist/worker.js").sha256);
	});

	check("fabric-resume: second run is a no-op", () => {
		const result = applyResumeOverlay({ packageRoot: resumePackage, npmDir, now: 2 });
		assert.equal(result.status, "already");
	});

	check("fabric-resume: refuses another pi-fabric release instead of mixing builds", () => {
		const otherNpm = join(root, "npm-other");
		mkdirSync(join(otherNpm, "pi-fabric", "dist"), { recursive: true });
		writeFile(join(otherNpm, "pi-fabric", "package.json"), JSON.stringify({ name: "pi-fabric", version: "0.140.0" }));
		const result = applyResumeOverlay({ packageRoot: resumePackage, npmDir: otherNpm, now: 3 });
		assert.equal(result.status, "version-mismatch");
		assert.equal(existsSync(join(otherNpm, "pi-fabric", manifest.marker)), false);
	});

	check("fabric-resume: refuses an archive that does not match the manifest", () => {
		const corruptPackage = join(root, "fabric-resume-corrupt");
		mkdirSync(join(corruptPackage, "overlay"), { recursive: true });
		const corruptManifest = structuredClone(manifest);
		corruptManifest.files[0] = { ...corruptManifest.files[0], sha256: "0".repeat(64) };
		writeFile(join(corruptPackage, "overlay", "manifest.json"), JSON.stringify(corruptManifest));
		writeFile(join(corruptPackage, manifest.tar), readFile(new URL(manifest.tar, realPackage)));
		const corruptNpm = join(root, "npm-corrupt");
		mkdirSync(join(corruptNpm, "pi-fabric", "dist"), { recursive: true });
		writeFile(join(corruptNpm, "pi-fabric", "package.json"), JSON.stringify({ name: "pi-fabric", version: manifest.upstream }));
		const result = applyResumeOverlay({ packageRoot: corruptPackage, npmDir: corruptNpm, now: 4 });
		assert.equal(result.status, "integrity");
		assert.equal(existsSync(join(corruptNpm, "pi-fabric", manifest.marker)), false);
		assert.equal(existsSync(join(corruptNpm, "pi-fabric", manifest.files[0].path)), false);
	});

	check("fabric-resume: reader handles only regular files and rejects traversal", () => {
		const body = Buffer.from("hello");
		const header = Buffer.alloc(512, 0);
		header.write("../escape.js", 0, "utf8");
		header.write("0000644", 100, "utf8");
		header.write(body.length.toString(8).padStart(11, "0"), 124, "utf8");
		header.write("0", 156, "utf8");
		header.write("ustar", 257, "utf8");
		const archive = gzipSync(Buffer.concat([header, body, Buffer.alloc(512, 0)]));
		const entries = extractDistTarGz(archive);
		assert.deepEqual([...entries.keys()], ["../escape.js"]);
		const escapeNpm = join(root, "npm-escape");
		mkdirSync(join(escapeNpm, "pi-fabric", "dist"), { recursive: true });
		writeFile(join(escapeNpm, "pi-fabric", "package.json"), JSON.stringify({ name: "pi-fabric", version: manifest.upstream }));
		const escapePackage = join(root, "fabric-resume-escape");
		mkdirSync(join(escapePackage, "overlay"), { recursive: true });
		writeFile(
			join(escapePackage, "overlay", "manifest.json"),
			JSON.stringify({ ...manifest, files: [{ path: "dist/escape.js", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") }] }),
		);
		writeFile(join(escapePackage, manifest.tar), archive);
		const result = applyResumeOverlay({ packageRoot: escapePackage, npmDir: escapeNpm, now: 5 });
		assert.equal(result.status, "integrity");
		assert.equal(existsSync(join(root, "escape.js")), false);
	});
}

if (process.exitCode) {
	console.error(`\n${passed.length} check(s) passed, some failed`);
} else {
	console.log(`all ${passed.length} checks passed`);
}
