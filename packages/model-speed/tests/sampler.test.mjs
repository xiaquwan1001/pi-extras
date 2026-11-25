// Content sanity of a reply: the failure mode a stopwatch cannot see.
// Run: node --test packages/model-speed/tests/

import assert from "node:assert/strict";
import test from "node:test";

import { classifyOutput, replyShape } from "../extensions/sampler.ts";

// The bodies behind the 2026-11-25 incident: HTTP 200, exit 0, nothing usable.
const dsml = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="filesystem:list"><｜DSML｜parameter name="path">lane_rss800</｜DSML｜parameter></｜DSML｜invoke>';
const fullwidth = "＜｜tool▁sep｜＞ grep ＜｜end▁of▁sentence｜＞";
const noise = "\uFFFD\uFFFD\uFFFD\u0001\u0002\uFFFD\uFFFD";

test("special-token leakage is garbage, not a fast answer", () => {
	assert.equal(classifyOutput(dsml).garbage, true);
	assert.equal(classifyOutput(fullwidth).garbage, true);
	assert.equal(classifyOutput(noise).garbage, true);
});

test("an empty body is empty; an empty body with a tool call is not", () => {
	assert.deepEqual(classifyOutput("   \n\t ").empty, true);
	assert.equal(classifyOutput("", 1).empty, false);
});

test("valid short replies are not suspicious", () => {
	// Banning brevity would ban healthy models: these all pass.
	for (const text of ["OK", "done.", "好的", "{\"ok\":true}", "1 2 3 4 5", "# Heading\n\n- a\n- b"]) {
		const verdict = classifyOutput(text);
		assert.equal(verdict.empty, false, text);
		assert.equal(verdict.garbage, false, text);
	}
});

test("reply shape reads text and tool calls from either content form", () => {
	assert.deepEqual(replyShape({ content: "hi" }), { text: "hi", toolCalls: 0 });
	assert.deepEqual(
		replyShape({ content: [{ type: "text", text: "a" }, { type: "thinking", text: "ignored" }, { type: "toolCall", name: "x" }] }),
		{ text: "a", toolCalls: 1 },
	);
	assert.deepEqual(replyShape(undefined), { text: "", toolCalls: 0 });
});
