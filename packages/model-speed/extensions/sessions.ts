/**
 * Per-session memory for the switch machinery.
 *
 * The failover decision is *per session*: how many switches this conversation already
 * spent, which model it stepped onto, and which models it abandoned. That state used to
 * live only in module-level variables, so it evaporated on every `session_start` —
 * `/reload`, `--resume` and fork all restart the extension instance. A resumed session
 * then believed it had never switched: the budget was full again, and the model it had
 * just left (after 6 slow turns) was a legal target again.
 *
 * This module is the pure half: key normalization, read/merge/prune of
 * `switch-state.json`. The extension does the I/O and the notify.
 */

export type AbandonedModel = { from: string; to: string; at: number };

export type SessionSwitchMemory = {
	/** Switches this session has taken. */
	switches: number;
	/** Model the last automatic switch landed on (undefined = never switched). */
	target?: string;
	/** When this session's last switch happened, ms. */
	lastSwitchAt: number;
	/** When this session started, ms — restored so `sessionBinding.warmAfterMs` survives a reload. */
	startedAt: number;
	/** Switches this session made, newest last; the anti ping-pong list. */
	abandoned: AbandonedModel[];
	/** Last write, ms; only used to prune stale sessions. */
	updatedAt: number;
};

export type SwitchStateFile = {
	/** Global, kept for backward compatibility and for `switch-skip` context. */
	lastSwitchAt?: number;
	lastFrom?: string;
	lastTo?: string;
	history?: AbandonedModel[];
	sessions?: Record<string, SessionSwitchMemory>;
};

/**
 * A stable key for one conversation. The session file name survives resume, reload and
 * the "new session from this one" flow, which is exactly the lifetime that matters: the
 * prompt cache behind this conversation is what a switch throws away.
 *
 * Ephemeral sessions (`pi -p`, SDK use) have no file and get a pid-scoped key: two
 * processes never share their switch budget, which is the honest answer when there is
 * no conversation id at all.
 */
export function sessionKeyFromFile(file: string | undefined | null, pid = process.pid): string | undefined {
	if (typeof file !== "string" || file.trim() === "") return undefined;
	const base = file.trim().split(/[\\/]/).pop() ?? "";
	const key = base.replace(/\.jsonl$/i, "").trim();
	return key === "" ? undefined : key;
}

export const ephemeralSessionKey = (pid = process.pid): string => `ephemeral-${pid}`;

/**
 * Which stored key describes "the conversation before this one" — the thing a resumed or
 * forked session inherits. Only those two reasons carry history: `/new` starts a fresh
 * conversation and must not inherit a spent switch budget.
 */
export function inheritedSessionKey(
	reason: string,
	currentKey: string,
	previousFile: string | undefined | null,
): string | undefined {
	if (reason !== "resume" && reason !== "fork") return undefined;
	const previousKey = sessionKeyFromFile(previousFile);
	if (!previousKey || previousKey === currentKey) return undefined;
	return previousKey;
}

export const emptySessionMemory = (now: number): SessionSwitchMemory => ({
	switches: 0,
	lastSwitchAt: 0,
	startedAt: now,
	abandoned: [],
	updatedAt: now,
});

/** Merge a patch into one session's memory, creating it when absent. Never mutates. */
export function mergeSessionMemory(
	state: SwitchStateFile,
	key: string,
	patch: Partial<SessionSwitchMemory>,
	now: number,
): SwitchStateFile {
	const existing = state.sessions?.[key] ?? emptySessionMemory(now);
	const merged: SessionSwitchMemory = {
		...existing,
		...patch,
		abandoned: patch.abandoned ? patch.abandoned.slice(-8) : existing.abandoned,
		updatedAt: now,
	};
	return { ...state, sessions: { ...(state.sessions ?? {}), [key]: merged } };
}

/** Adopt `from`'s memory under `to` (fork/resume) and drop the old key. */
export function rekeySession(state: SwitchStateFile, from: string, to: string, now: number): SwitchStateFile {
	const sessions = { ...(state.sessions ?? {}) };
	const memory = sessions[from];
	if (!memory) return state;
	delete sessions[from];
	sessions[to] = { ...memory, updatedAt: now };
	return { ...state, sessions };
}

/** Keep the file bounded: drop sessions older than `maxAgeMs`, then the oldest overflow. */
export function pruneSessions(
	sessions: Record<string, SessionSwitchMemory>,
	now: number,
	maxAgeMs = 7 * 24 * 3_600_000,
	keep = 20,
): Record<string, SessionSwitchMemory> {
	const fresh = Object.entries(sessions).filter(([, memory]) => now - (memory?.updatedAt ?? 0) <= maxAgeMs);
	fresh.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0));
	return Object.fromEntries(fresh.slice(0, keep));
}

/** Models this session abandoned recently enough that going back is ping-pong. */
export function recentlyAbandoned(
	memory: SessionSwitchMemory | undefined,
	now: number,
	cooldownMs: number,
): string[] {
	if (!memory) return [];
	return memory.abandoned
		.filter((entry) => typeof entry?.at === "number" && now - entry.at < cooldownMs)
		.map((entry) => entry.from);
}
