// Per-session switch memory: the pure half of "a resumed session must remember".
// Run: node --test packages/model-speed/tests/

import assert from "node:assert/strict";
import test from "node:test";

import {
	emptySessionMemory,
	inheritedSessionKey,
	mergeSessionMemory,
	pruneSessions,
	recentlyAbandoned,
	rekeySession,
	sessionKeyFromFile,
} from "../extensions/sessions.ts";

const now = 1_800_000_000_000;

test("session keys come from the session file, not from the process", () => {
	assert.equal(sessionKeyFromFile("/home/me/.pi/agent/sessions/x/2026-11-24T12-00_abc.jsonl"), "2026-11-24T12-00_abc");
	assert.equal(sessionKeyFromFile("C:\\sessions\\abc.jsonl"), "abc");
	assert.equal(sessionKeyFromFile(undefined), undefined);
	assert.equal(sessionKeyFromFile("   "), undefined);
	// Same file -> same key, which is what makes resume/reload find their memory.
	assert.equal(sessionKeyFromFile("/a/b.jsonl"), sessionKeyFromFile("/c/b.jsonl"));
});

test("only resume and fork inherit the previous conversation's memory", () => {
	assert.equal(inheritedSessionKey("resume", "new", "/sessions/old.jsonl"), "old");
	assert.equal(inheritedSessionKey("fork", "new", "/sessions/old.jsonl"), "old");
	assert.equal(inheritedSessionKey("startup", "new", "/sessions/old.jsonl"), undefined);
	// `/new` is a different conversation: a spent switch budget must not follow it.
	assert.equal(inheritedSessionKey("new", "new", "/sessions/old.jsonl"), undefined);
	// Same file (a plain resume) -> no rekey needed.
	assert.equal(inheritedSessionKey("resume", "abc", "/sessions/abc.jsonl"), undefined);
});

test("merging a switch keeps the budget, the target and the abandoned list", () => {
	const key = "abc";
	let state = mergeSessionMemory({}, key, { switches: 1, target: "dsf2", lastSwitchAt: now, startedAt: now - 60_000 }, now);
	state = mergeSessionMemory(state, key, { switches: 2, target: "glm", lastSwitchAt: now + 60_000 }, now + 60_000);
	const memory = state.sessions[key];
	assert.equal(memory.switches, 2);
	assert.equal(memory.target, "glm");
	assert.equal(memory.startedAt, now - 60_000, "startedAt survives a partial patch");
	assert.equal(memory.updatedAt, now + 60_000);
});

test("a manual model change clears the budget but keeps the conversation row", () => {
	const key = "abc";
	let state = mergeSessionMemory({}, key, { switches: 2, target: "glm", lastSwitchAt: now }, now);
	state = mergeSessionMemory(state, key, { switches: 0, target: undefined, lastSwitchAt: 0 }, now + 1_000);
	const memory = state.sessions[key];
	assert.equal(memory.switches, 0);
	assert.equal(memory.target, undefined);
	assert.equal(memory.startedAt, now);
});

test("the abandoned list is bounded and remembers what it abandoned", () => {
	let state = {};
	for (let i = 0; i < 12; i += 1) {
		const memory = state.sessions?.abc;
		state = mergeSessionMemory(
			state,
			"abc",
			{ abandoned: [...(memory?.abandoned ?? []), { from: `m${i}`, to: `m${i + 1}`, at: now + i }] },
			now + i,
		);
	}
	const memory = state.sessions.abc;
	assert.equal(memory.abandoned.length, 8);
	assert.equal(memory.abandoned.at(-1).from, "m11");
	assert.deepEqual(recentlyAbandoned(memory, now + 12, 600_000).includes("m11"), true);
	// Outside the ping-pong window the model is a legal target again.
	assert.deepEqual(recentlyAbandoned(memory, now + 700_000, 600_000), []);
});

test("fork moves the memory to the new session and drops the old key", () => {
	let state = mergeSessionMemory({}, "old", { switches: 2, target: "dsf2" }, now);
	state = rekeySession(state, "old", "fork", now + 1);
	assert.equal(state.sessions.old, undefined);
	assert.equal(state.sessions.fork.switches, 2);
	assert.equal(state.sessions.fork.target, "dsf2");
	// Nothing to move: the state is returned untouched.
	assert.equal(rekeySession(state, "missing", "x", now), state);
});

test("pruning keeps the newest sessions and never grows without bound", () => {
	const sessions = {};
	sessions.fresh = { ...emptySessionMemory(now), updatedAt: now };
	sessions.stale = { ...emptySessionMemory(now), updatedAt: now - 8 * 24 * 3_600_000 };
	for (let i = 0; i < 30; i += 1) sessions[`s${i}`] = { ...emptySessionMemory(now), updatedAt: now - i * 1_000 };
	const pruned = pruneSessions(sessions, now);
	assert.equal(pruned.stale, undefined);
	assert.equal(pruned.fresh.switches, 0);
	assert.equal(Object.keys(pruned).length, 20);
	assert.equal(Object.keys(pruned)[0], "fresh", "newest first");
});
