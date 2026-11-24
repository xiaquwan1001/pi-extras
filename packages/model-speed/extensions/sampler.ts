/**
 * Synthetic speed samples, taken through pi's own model registry.
 *
 * The point of sampling *inside* the extension (instead of shelling out to a probe
 * script) is authentication: `registry.streamSimple()` resolves the same provider
 * credentials pi uses, so one sampler works for any provider, including
 * extension-registered ones, without dumping API keys into a config file.
 *
 * A sample asks for a modest prompt (~2k tokens) and a bounded number of output tokens.
 * It records exactly what the user cares about:
 *
 *   - TTFT      time from request start to the first content delta,
 *   - TPOT      ms per output token over the generation window,
 *   - tokens/s  the inverse, derived from the provider's reported output token count.
 *
 * The prompt starts with a random tag, so a gateway prefix cache cannot hand back a
 * suspiciously fast first token; a cached prompt would make every model look instant.
 */

export type SamplerModel = {
	provider: string;
	id: string;
	contextWindow?: number;
};

export type StreamRegistry = {
	streamSimple(
		model: any,
		context: any,
		options?: any,
	): AsyncIterable<any> & { result(): Promise<any> };
};

export type ProbeOutcome = {
	kind: "probe";
	model: string;
	provider: string;
	served?: string;
	ok: boolean;
	status?: string | number;
	ttftMs?: number;
	tpotMs?: number;
	tokensOut?: number;
	tokensPerSec?: number;
	promptTokens?: number;
	startedAt: number;
	endedAt: number;
	error?: string;
};

export type SampleOptions = {
	/** Approximate prompt size in tokens. */
	promptTokens?: number;
	/** Output tokens to ask for; must be large enough for a stable tokens/s reading. */
	maxTokens?: number;
	/** Hard wall-clock cap for one sample. */
	timeoutMs?: number;
	signal?: AbortSignal;
};

const FILLER = "The quick brown fox jumps over the lazy dog. ";

/** Roughly 4 characters per token, tagged so the prefix cache cannot answer for free. */
export function buildPrompt(promptTokens: number, tag: string, maxTokens: number): string {
	const chars = Math.max(256, Math.round(promptTokens * 4));
	const filler = FILLER.repeat(Math.ceil(chars / FILLER.length)).slice(0, chars);
	const words = Math.max(16, Math.min(maxTokens * 2, 400));
	return `[${tag}] Sample request for latency measurement. Reply with about ${words} short words separated by spaces, then stop. No tools, no explanation.\n\n${filler}`;
}

const isPayload = (event: any): boolean =>
	event?.type === "text_delta" ||
	event?.type === "thinking_delta" ||
	event?.type === "toolcall_delta" ||
	event?.type === "toolcall_start";

/** One timed synthetic call. Never throws: a failure is a recorded outcome. */
export async function sampleModel(
	registry: StreamRegistry,
	model: SamplerModel,
	options: SampleOptions = {},
): Promise<ProbeOutcome> {
	const promptTokens = Math.max(256, Math.floor(options.promptTokens ?? 2000));
	const maxTokens = Math.max(32, Math.floor(options.maxTokens ?? 128));
	const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? 45_000));
	const startedAt = Date.now();
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	(timer as { unref?: () => void }).unref?.();
	const onOuterAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onOuterAbort);
	const tag = `${Math.random().toString(16).slice(2, 18)}`;
	let firstAt: number | undefined;
	let result: any;
	let error: string | undefined;
	try {
		const stream = registry.streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: buildPrompt(promptTokens, tag, maxTokens),
						timestamp: startedAt,
					},
				],
			},
			{ maxTokens, reasoning: "minimal", signal: controller.signal },
		);
		for await (const event of stream) {
			if (firstAt === undefined && isPayload(event)) firstAt = Date.now();
		}
		result = await stream.result();
	} catch (cause) {
		error = timedOut ? "timeout" : cause instanceof Error ? cause.name || "error" : String(cause);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onOuterAbort);
	}
	const endedAt = Date.now();
	if (!error && result?.stopReason === "error") error = result.errorMessage ?? "error";
	if (!error && result?.errorMessage) error = result.errorMessage;
	const usage = result?.usage;
	const tokensOut = typeof usage?.output === "number" && usage.output > 0 ? usage.output : undefined;
	const ttftMs = firstAt !== undefined ? firstAt - startedAt : undefined;
	const genMs = ttftMs !== undefined && tokensOut ? endedAt - firstAt! : undefined;
	const tpotMs = genMs && tokensOut ? Math.round(genMs / tokensOut) : undefined;
	const base = {
		kind: "probe" as const,
		model: model.id,
		provider: model.provider,
		served: typeof result?.responseModel === "string" ? result.responseModel : undefined,
		promptTokens,
		startedAt,
		endedAt,
	};
	if (error || ttftMs === undefined) {
		return {
			...base,
			ok: false,
			status: timedOut ? "timeout" : (result?.stopReason ?? "error"),
			ttftMs,
			tokensOut,
			error: error ?? "no first token",
		};
	}
	return {
		...base,
		ok: true,
		ttftMs,
		tpotMs,
		tokensOut,
		tokensPerSec: genMs && tokensOut ? Math.round((tokensOut * 1000) / genMs) : undefined,
	};
}

/** Sample targets one at a time (concurrent calls to one gateway queue and skew TTFT). */
export async function sampleModels(
	registry: StreamRegistry,
	models: SamplerModel[],
	options: SampleOptions & { gapMs?: number; onOutcome?: (outcome: ProbeOutcome) => void | Promise<void> } = {},
): Promise<ProbeOutcome[]> {
	const outcomes: ProbeOutcome[] = [];
	for (const model of models) {
		if (options.signal?.aborted) break;
		const cap = model.contextWindow ? Math.max(256, model.contextWindow - 2048) : undefined;
		const promptTokens = cap ? Math.min(options.promptTokens ?? 2000, cap) : options.promptTokens;
		const outcome = await sampleModel(registry, model, { ...options, promptTokens });
		outcomes.push(outcome);
		// Record each sample as soon as it exists: a run cut short by a user turn or a
		// kill still leaves the measurements it did finish.
		await options.onOutcome?.(outcome);
		const gap = options.gapMs ?? 400;
		if (gap > 0 && models[models.length - 1] !== model) await new Promise((resolve) => setTimeout(resolve, gap));
	}
	return outcomes;
}
