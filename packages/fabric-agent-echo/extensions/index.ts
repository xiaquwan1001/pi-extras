/**
 * fabric-agent-echo — keep completed Fabric subagent conversations in the main transcript.
 *
 * Why: Fabric stores a child run's conversation in its run directory
 * (`<os.tmpdir()>/pi-fabric-runs-<rand>/<runId>/events.jsonl`, retained 24h by default —
 * or `~/.cache/pi-fabric/runs/<pi-session-id>/<runId>/` when children keep their own
 * session so they stay resumable)
 * and exposes it only through `/fabric chat <runId>` / the dashboard / `agents.log()`.
 * The main session keeps just the `fabric_exec` tool card and a one-line completion
 * notice, so once you scroll past it the subagent's work is gone from view.
 *
 * How: read Fabric's own on-disk run artifacts (no private API), turn the child's
 * JSONL event stream back into a conversation, and append it to the session as a
 * collapsible TUI-only entry (`pi.appendEntry`, never sent to the model).
 *
 * Commands:
 *   /agent-echo             backfill any completed run that is not shown yet
 *   /agent-echo all         same, including runs finished before this session
 *   /agent-echo <id prefix> backfill one specific run
 *   /agent-echo on|off      toggle automatic appending (default on)
 *
 * Environment: PI_FABRIC_AGENT_ECHO=0 disables automatic appending.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import { clip, collectRuns, oneLine, type EchoData } from "./core";

const ENTRY_TYPE = "fabric-agent-echo";
const POLL_MS = 4000;

const echoed = new Set<string>();
let auto = process.env.PI_FABRIC_AGENT_ECHO !== "0";
let since = 0;
/** This session's id, so resumable runs kept under the cache are found too. */
let sessionId: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let sweeping = false;

const fmtDur = (ms: number) => {
	if (!Number.isFinite(ms) || ms <= 0) return "?";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
};

const fmtTok = (n?: number) =>
	typeof n === "number" && n > 0 ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : "?";

function renderEntry(
	entry: { data?: EchoData },
	{ expanded }: { expanded: boolean },
	theme: any,
): unknown {
	const data = entry.data;
	const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
	if (!data) {
		box.addChild(new Text(theme.fg("dim", "[agent] (no data)"), 0, 0));
		return box;
	}
	const badge =
		data.status === "completed" ? theme.fg("success", `● ${data.status}`) : theme.fg("error", `● ${data.status}`);
	const meta = [
		data.model,
		fmtDur((data.finishedAt ?? 0) - (data.startedAt ?? 0)),
		typeof data.toolCalls === "number" ? `${data.toolCalls} calls` : undefined,
		`↑${fmtTok(data.usage?.input)} ↓${fmtTok(data.usage?.output)}`,
	].filter(Boolean);
	box.addChild(
		new Text(
			`${theme.fg("accent", "[agent]")} ${badge} ${theme.fg("dim", meta.join(" · "))} ${theme.fg("toolTitle", oneLine(data.name ?? "").slice(0, 80))}`,
			0,
			0,
		),
	);
	if (expanded) {
		for (const line of data.transcript) box.addChild(new Text(line, 0, 0));
		box.addChild(new Text(theme.fg("dim", `run ${data.id} · live view: /fabric chat ${data.id}`), 0, 0));
		return box;
	}
	const tail = [...data.transcript].reverse().find((line) => line.startsWith("\n▸ assistant: "));
	if (tail) box.addChild(new Text(theme.fg("dim", clip(tail.replace(/^\n▸ assistant: /, ""), 400)), 0, 0));
	box.addChild(new Text(theme.fg("dim", "[ctrl+o to expand the full conversation]"), 0, 0));
	return box;
}

/** Append every completed run that has not been appended yet; returns how many. */
function sweep(pi: ExtensionAPI, opts: { since?: number; idFilter?: string } = {}): number {
	let added = 0;
	const runs = collectRuns({
		since: opts.since ?? since,
		idFilter: opts.idFilter,
		skip: (id) => echoed.has(id),
		...(sessionId ? { sessionId } : {}),
	});
	for (const data of runs) {
		try {
			echoed.add(data.id);
			pi.appendEntry<EchoData>(ENTRY_TYPE, data);
			added += 1;
		} catch {
			/* one bad run must not stop the others */
		}
	}
	return added;
}

function guardedSweep(pi: ExtensionAPI, opts: { since?: number; idFilter?: string } = {}): number {
	if (!auto || sweeping) return 0;
	sweeping = true;
	try {
		return sweep(pi, opts);
	} finally {
		sweeping = false;
	}
}

function startTimer(pi: ExtensionAPI) {
	if (timer) clearInterval(timer);
	timer = setInterval(() => guardedSweep(pi), POLL_MS);
	(timer as any)?.unref?.();
}

export default function fabricAgentEcho(pi: ExtensionAPI) {
	pi.registerEntryRenderer<EchoData>(ENTRY_TYPE, renderEntry as any);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Restore "already shown" from persisted entries so /reload and /resume never duplicate.
		echoed.clear();
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
					const id = (entry.data as EchoData | undefined)?.id;
					if (typeof id === "string") echoed.add(id);
				}
			}
		} catch {
			/* treat as empty */
		}
		since = Date.now();
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			sessionId = typeof id === "string" && id ? id : undefined;
		} catch {
			sessionId = undefined;
		}
		startTimer(pi);
	});

	// A fabric_exec call returning is the common case: children usually settle inside it.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "fabric_exec") return;
		guardedSweep(pi);
	});

	// Catch stragglers: background programs and detached spawns settle later.
	pi.on("agent_settled", async () => {
		guardedSweep(pi);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.registerCommand("agent-echo", {
		description:
			"Append completed Fabric subagent conversations to this transcript: /agent-echo [all|on|off|<run-id prefix>]",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "on" || arg === "off") {
				auto = arg === "on";
				ctx.ui.notify(`agent-echo automatic appending ${auto ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (arg === "all") {
				since = 0;
				const added = sweep(pi, { since: 0 });
				ctx.ui.notify(`agent-echo: appended ${added} run(s), including runs from before this session`, "info");
				return;
			}
			const idFilter = arg || undefined;
			// Manual backfill always scans from the beginning; already-shown runs are deduplicated.
			const added = sweep(pi, { since: 0, idFilter });
			ctx.ui.notify(
				added === 0
					? `agent-echo: ${idFilter ? `no matching run not shown yet: ${idFilter}` : "nothing to backfill"}`
					: `agent-echo: appended ${added} subagent conversation(s)`,
				"info",
			);
		},
	});
}
