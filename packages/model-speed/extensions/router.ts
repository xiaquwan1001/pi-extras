/**
 * Routing for the virtual `ustc-auto` model: one stable selection, a physical model per request.
 *
 * Why a virtual model instead of mid-run `setModel()` (the old failover):
 *
 *   - pi-subagents verifies every assistant message against the launch candidate. A child that
 *     switched models mid-run is reported as `model_verification_failed` and the whole run is
 *     discarded (2026-11-24, run e5a8e44a). A virtual model keeps the *selection* constant, so
 *     a gateway-side change of physical model is invisible to that check and the run survives.
 *   - The session stops paying for "which model am I on": routing is decided per request from
 *     the health history instead of being baked into the conversation.
 *
 * The router itself is pure. Everything it needs — candidate timings, freshness, context fit,
 * the previous model, the failed model — is passed in, so `tests/router.test.mjs` can replay a
 * real incident without a gateway.
 */

export type RouteReason = "user" | "continuation" | "retry" | "direct";

/** One physical candidate, already resolved from the catalog and the health history. */
export type RouterCandidate = {
	/** Model id inside the provider (no provider prefix). */
	id: string;
	/** Catalog context window; undefined = unknown, which never excludes. */
	contextWindow?: number;
	/** TTFT the health history currently credits this model with, ms. Undefined = unmeasured. */
	ttftMs?: number;
	/** The newest thing known about it is garbage/empty output, not a slow answer. */
	invalid?: boolean;
	/** The newest thing known about it is a failure (timeout, HTTP error). */
	failed?: boolean;
	/** Preference order inside the chain, lower wins a tie or an "everything is unmeasured" start. */
	order?: number;
};

export type RouterState = {
	/** modelId → epoch ms until which it stays out of the rotation. */
	quarantine?: Record<string, number>;
};

export type RouteInput = {
	candidates: RouterCandidate[];
	/** Ids in preference order. Empty = every candidate is allowed. */
	chain: string[];
	/** Context this request needs (conversation + reply headroom). 0 = unknown, never excludes. */
	needTokens: number;
	reason: RouteReason;
	/** Physical model that produced the latest successful response, if any. */
	previousId?: string;
	/** For `retry`: the physical model whose request just failed. */
	failedId?: string;
	state?: RouterState;
	now: number;
	/** How long a model the router stepped off stays out of the rotation. 0 = never quarantine. */
	quarantineMs: number;
	/**
	 * How much faster a later chain entry must be before it is promoted over an earlier, healthy
	 * one. The chain encodes preference (and capability: the 256k model sits last); only a clear
	 * win should override it, the same rule `switchToFaster` uses for a mid-run switch.
	 */
	minGainRatio?: number;
};

export type RouteChoice = { modelId: string; state: RouterState };

const isBad = (candidate: RouterCandidate) => Boolean(candidate.invalid || candidate.failed);
const fits = (candidate: RouterCandidate, needTokens: number) =>
	needTokens <= 0 || !candidate.contextWindow || candidate.contextWindow >= needTokens;

/** Best-first: healthy before broken, then the freshest measured TTFT, then the chain order. */
const rank = (list: RouterCandidate[]): RouterCandidate[] =>
	[...list].sort((a, b) => {
		const bad = Number(isBad(a)) - Number(isBad(b));
		if (bad !== 0) return bad;
		const ttft = (a.ttftMs ?? Number.POSITIVE_INFINITY) - (b.ttftMs ?? Number.POSITIVE_INFINITY);
		if (ttft !== 0) return ttft;
		return (a.order ?? 0) - (b.order ?? 0);
	});

/** Chain order, with a measured model ahead of an unmeasured one (unknown is never "fast"). */
const byPreference = (list: RouterCandidate[]): RouterCandidate[] =>
	[...list].sort((a, b) => {
		const measured = Number(a.ttftMs === undefined) - Number(b.ttftMs === undefined);
		if (measured !== 0) return measured;
		return (a.order ?? 0) - (b.order ?? 0);
	});

/**
 * The best healthy candidate: chain preference first, overridden only by a clear speed win.
 *
 * "Clear" is `minGainRatio` (2x by default) because the chain is not just speed — it is also
 * capability and durability. Promoting anything marginily faster would trade a 1M vision model
 * for the 256k text model to save a second.
 */
function bestHealthy(list: RouterCandidate[], minGainRatio: number): RouterCandidate | undefined {
	const healthy = list.filter((candidate) => !isBad(candidate));
	if (healthy.length === 0) return undefined;
	const preferred = byPreference(healthy)[0];
	if (preferred.ttftMs === undefined) return preferred;
	const fastest = healthy.reduce((best, candidate) => ((candidate.ttftMs ?? Number.POSITIVE_INFINITY) < (best.ttftMs ?? Number.POSITIVE_INFINITY) ? candidate : best), preferred);
	if (fastest.ttftMs !== undefined && fastest.ttftMs * minGainRatio < preferred.ttftMs) return fastest;
	return preferred;
}

/**
 * Pick the physical model for one request.
 *
 * Order of the rules matters and each one is a real incident:
 *
 *   1. *Context.* A 300k-token session must never land on the 256k model of the chain — that
 *      comes back as `400 ContextWindowExceededError` for the whole turn.
 *   2. *Continuation keeps the previous model* even when another one is marginally faster: a
 *      model change invalidates the prompt cache and the thinking signatures mid-turn.
 *   3. *Retry steps off the failed model* and parks it for `quarantineMs`, so the next retry
 *      cannot land on it again.
 *   4. *Health beats speed.* A model whose newest answer was empty or DSML garbage is not a
 *      target however fast its TTFT was — that is exactly how three subagent lanes produced
 *      "completed" runs with zero output (2026-11-25).
 *   5. *Nothing healthy left* (single-model chain, or everything quarantined): return the least
 *      bad candidate instead of throwing, because a request on a doubtful model still beats no
 *      request at all.
 */
export function chooseRoute(input: RouteInput): RouteChoice | undefined {
	const now = input.now;
	const quarantine: Record<string, number> = {};
	for (const [id, until] of Object.entries(input.state?.quarantine ?? {})) {
		if (typeof until === "number" && until > now) quarantine[id] = until;
	}
	const inChain = new Set(input.chain.length ? input.chain : input.candidates.map((candidate) => candidate.id));
	const base = input.candidates.filter((candidate) => inChain.has(candidate.id));
	const eligible = base.filter((candidate) => fits(candidate, input.needTokens) && quarantine[candidate.id] === undefined);
	const parked = (id: string) => {
		if (input.quarantineMs > 0) quarantine[id] = now + input.quarantineMs;
	};

	// 1. Same model as the last successful response, unless health says it broke.
	if (input.reason === "continuation" && input.previousId) {
		const previous = eligible.find((candidate) => candidate.id === input.previousId);
		if (previous && !isBad(previous)) return { modelId: previous.id, state: { quarantine } };
	}

	let pool = eligible;
	if (input.reason === "retry" && input.failedId) {
		const without = pool.filter((candidate) => candidate.id !== input.failedId);
		if (without.length > 0) {
			pool = without;
			parked(input.failedId);
		}
	}

	const healthy = bestHealthy(pool, input.minGainRatio ?? 2);
	const chosen = healthy ?? rank(pool)[0] ?? rank(base.filter((candidate) => fits(candidate, input.needTokens)))[0] ?? rank(base)[0];
	if (!chosen) return undefined;
	// Stepping off a model that produced nothing is a router decision worth remembering.
	if (input.previousId && input.previousId !== chosen.id) {
		const previous = base.find((candidate) => candidate.id === input.previousId);
		if (previous && isBad(previous) && pool.length > 1) parked(previous.id);
	}
	return { modelId: chosen.id, state: { quarantine } };
}

/**
 * Rough token count of a conversation, for the context guard in the router.
 *
 * Deliberately cheap: `route()` runs before every request, so it must not tokenize. Four
 * characters per token over-counts CJK and under-counts code, and the headroom absorbs both.
 */
export function estimateNeedTokens(messages: readonly unknown[], headroomTokens = 32_000): number {
	let chars = 0;
	const seen = new Set<unknown>();
	const walk = (value: unknown, depth: number) => {
		if (depth > 8 || chars > 8_000_000) return;
		if (typeof value === "string") {
			chars += value.length;
			return;
		}
		if (!value || typeof value !== "object") return;
		if (seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1);
			return;
		}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			// Identifiers and timestamps are not conversation: counting them would add noise
			// that grows with tool-call count rather than with context.
			if (key === "id" || key === "timestamp" || key === "usage" || key === "callId") continue;
			walk(item, depth + 1);
		}
	};
	walk(messages, 0);
	return Math.round(chars / 4) + Math.max(0, headroomTokens);
}
