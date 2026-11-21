/**
 * Pure helpers for fabric-agent-echo (no Pi imports, so this stays unit-testable):
 * locate this Pi process's Fabric run roots and turn a finished run's event stream
 * back into readable conversation lines.
 *
 * Fabric writes runs in one of two places:
 *
 *   1. one temp root per Pi process (the default):
 *        <os.tmpdir()>/pi-fabric-runs-<random>/
 *          .fabric-owner.json        { pid, ... }  -- owner of this root
 *          <runId>/status.json       run record (id, status, usage, logFile, ...)
 *          <runId>/events.jsonl      the child's RPC stream (message_end = full messages)
 *          <runId>/lifecycle.jsonl   pi.agent_start / agent_settled / tokens.usage
 *
 *   2. a persistent, session-keyed root, when `agents.childSession` keeps children
 *      resumable across restarts (pi-fabric-resume / the local resume patch):
 *        <cache>/pi-fabric/runs/<pi-session-id>/<runId>/…
 *      There is no owner file — the directory name *is* the session id — so these
 *      roots are only read for the session id this process was told it owns.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import os from "node:os";

export const RUN_ROOT_RE = /^pi-fabric-runs-[A-Za-z0-9_-]+$/;
export const TERMINAL = new Set(["completed", "failed", "stopped", "timed_out", "cancelled", "canceled"]);
export const MAX_TRANSCRIPT_CHARS = 12_000;

export type RunRecord = {
	id: string;
	name?: string;
	task?: string;
	status: string;
	model?: string;
	turns?: number;
	toolCalls?: number;
	usage?: { input?: number; output?: number; cost?: number };
	startedAt?: number;
	finishedAt?: number;
	actorId?: string;
	logFile?: string;
};

export type EchoData = {
	v: 1;
	id: string;
	name: string;
	status: string;
	model?: string;
	turns?: number;
	toolCalls?: number;
	usage?: { input?: number; output?: number; cost?: number };
	startedAt?: number;
	finishedAt?: number;
	transcript: string[];
};

export const clip = (value: string, limit: number) =>
	value.length <= limit ? value : `${value.slice(0, limit)}…(+${value.length - limit})`;

export const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Base directory of the session-keyed run roots. Mirrors pi-fabric's own resolution:
 * `PI_FABRIC_RESUME_ROOT`, else `$XDG_CACHE_HOME/pi-fabric/runs`, else `~/.cache/...`.
 */
export function resumableRunsBase(): string {
	const configured = process.env.PI_FABRIC_RESUME_ROOT?.trim();
	if (configured && isAbsolute(configured)) return configured;
	const cache = process.env.XDG_CACHE_HOME?.trim();
	const home = cache && isAbsolute(cache) ? cache : join(os.homedir(), ".cache");
	return join(home, "pi-fabric", "runs");
}

/** The run root that holds one Pi session's resumable children. */
export function resumableRunRoot(sessionId: string, base: string = resumableRunsBase()): string {
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
	return join(base, safe);
}

/** Run roots owned by this Pi process (more than one after a reload). */
export function ownedRoots(
	pid: number = process.pid,
	tmpRoot: string = os.tmpdir(),
	extra: string[] = [],
): string[] {
	const roots: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(tmpRoot);
	} catch {
		names = [];
	}
	for (const name of names) {
		if (!RUN_ROOT_RE.test(name)) continue;
		const root = join(tmpRoot, name);
		try {
			const owner = JSON.parse(readFileSync(join(root, ".fabric-owner.json"), "utf8")) as { pid?: number };
			if (owner?.pid === pid) roots.push(root);
		} catch {
			/* not ours, or being written right now */
		}
	}
	for (const root of extra) {
		try {
			if (existsSync(root) && statSync(root).isDirectory()) roots.push(root);
		} catch {
			/* vanished between listing and reading */
		}
	}
	return roots;
}

/** Find every status.json below a run root (nested subagent runs included). */
export function statusFiles(root: string, depth = 0): string[] {
	if (depth > 4) return [];
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			if (entry.name === "status.json") found.push(join(root, entry.name));
			continue;
		}
		found.push(...statusFiles(join(root, entry.name), depth + 1));
	}
	return found;
}

export function readRecord(file: string): RunRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
		if (!record || typeof record.id !== "string" || typeof record.status !== "string") return undefined;
		return record;
	} catch {
		return undefined;
	}
}

/** Rebuild a readable conversation from the run's events.jsonl. */
export function buildTranscript(record: RunRecord, statusFile: string): string[] {
	const log = record.logFile ?? join(statusFile, "..", "events.jsonl");
	let raw: string;
	try {
		raw = readFileSync(log, "utf8");
	} catch {
		return ["(events.jsonl was cleaned up or has expired)"];
	}
	const lines: string[] = [];
	let budget = MAX_TRANSCRIPT_CHARS;
	const push = (line: string) => {
		if (budget <= 0) return;
		const text = clip(line, Math.min(budget, 2000));
		budget -= text.length;
		lines.push(text);
	};
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event?.type !== "message_end") continue;
		const message = event.message;
		if (!message || typeof message !== "object") continue;
		const role = String(message.role ?? "");
		const content = message.content;
		if (role === "user") {
			for (const part of Array.isArray(content) ? content : [{ type: "text", text: content }]) {
				if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
					push(`\n▸ user: ${clip(part.text.trim(), 600)}`);
				}
			}
		} else if (role === "assistant") {
			for (const part of Array.isArray(content) ? content : []) {
				if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
					push(`\n▸ assistant: ${clip(part.text.trim(), 1600)}`);
				} else if (part?.type === "toolCall") {
					push(`\n▸ assistant → ⚙ ${part.name}(${clip(oneLine(JSON.stringify(part.arguments ?? {})), 200)})`);
				}
			}
		} else if (role === "toolResult") {
			const texts: string[] = [];
			for (const part of Array.isArray(content) ? content : []) {
				if (part?.type === "text" && typeof part.text === "string") texts.push(part.text.trim());
			}
			const body = texts.join("\n").trim();
			if (body) push(`  ← ${message.toolName ?? "tool"}: ${clip(body, 500)}`);
		}
	}
	return lines.length ? lines : ["(empty conversation)"];
}

export type SweepOptions = {
	pid?: number;
	tmpRoot?: string;
	/** This Pi session's id, when children keep resumable runs under the cache. */
	sessionId?: string;
	/** Override the resumable base directory (tests, unusual layouts). */
	cacheBase?: string;
	since?: number;
	idFilter?: string;
	skip?: (id: string) => boolean;
};

/** Every finished run that is not skipped, oldest first. */
export function collectRuns(options: SweepOptions = {}): EchoData[] {
	const cutoff = options.since ?? 0;
	const out: EchoData[] = [];
	const seen = new Set<string>();
	const extra = options.sessionId ? [resumableRunRoot(options.sessionId, options.cacheBase)] : [];
	for (const root of ownedRoots(options.pid, options.tmpRoot, extra)) {
		for (const statusFile of statusFiles(root)) {
			const record = readRecord(statusFile);
			if (!record) continue;
			if (record.actorId) continue; // persistent actors have their own conversation view
			if (!TERMINAL.has(record.status)) continue;
			const finished = Number(record.finishedAt ?? 0);
			if (!finished || finished < cutoff) continue;
			if (seen.has(record.id) || options.skip?.(record.id)) continue;
			if (options.idFilter && !record.id.startsWith(options.idFilter)) continue;
			seen.add(record.id);
			out.push({
				v: 1,
				id: record.id,
				name: record.name ?? record.task ?? record.id,
				status: record.status,
				model: record.model,
				turns: record.turns,
				toolCalls: record.toolCalls,
				usage: record.usage,
				startedAt: record.startedAt,
				finishedAt: record.finishedAt,
				transcript: buildTranscript(record, statusFile),
			});
		}
	}
	return out.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
}
