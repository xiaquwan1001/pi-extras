/**
 * Patch definitions and application for pi-fabric / pi-fold.
 *
 * Every patch is a plain text substitution guarded by a marker comment, so it is
 * idempotent and safe to re-run on every Pi start:
 *
 *   - the file already carries the marker  -> "already", nothing to do
 *   - the file contains the upstream text  -> substitute once, "patched"
 *   - the package/file is absent           -> "missing", silently skipped
 *   - neither marker nor upstream text     -> "unexpected", reported, nothing written
 *
 * Files are found by **content**, not by build hash: pi-fabric's compiled chunks are
 * renamed on every release (`chunk-QUWC6YCN.js` today, something else tomorrow), so a
 * patch keyed to a filename silently stops applying after an upgrade. Discovery walks
 * the declared roots and applies to every file that contains the upstream text.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export type Patch = {
	id: string;
	packageName: string;
	/** Subdirectories (relative to the installed package) to search. */
	roots: string[];
	marker: string;
	original: string;
	patched: string;
	label: string;
};

export type PatchResult = "patched" | "already" | "missing" | "unexpected";

const WATCHDOG_TIMEOUT_PATCH = `var PI_RECOVERY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PI_FABRIC_RECOVERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6e5;
})(); // [pi-fabric-hardening:recovery-watchdog-timeout]`;

export const PATCHES: Patch[] = [
	{
		id: "status-write-guard",
		packageName: "pi-fabric",
		roots: ["dist"],
		marker: "[pi-fabric-hardening:status-write-guard]",
		label: "pi-fabric: status writes degrade instead of crashing the host",
		original: ["var writeRecord = (filePath, record) => {", "  writeJsonAtomic(filePath, record, { space: 2 });", "};"].join("\n"),
		patched: [
			"var writeRecord = (filePath, record) => {",
			"  // [pi-fabric-hardening:status-write-guard] A failed status write (EDQUOT/ENOSPC on a",
			"  // full tmpfs, EACCES, ...) used to escape as an uncaughtException and take the whole",
			"  // Pi process down. Degrade to a stderr note: one status record is lost, the agent",
			"  // manager keeps running.",
			"  try {",
			"    writeJsonAtomic(filePath, record, { space: 2 });",
			"  } catch (error) {",
			"    try {",
			"      process.stderr.write(`[pi-fabric] status write failed (${filePath}): ${error instanceof Error ? error.message : String(error)}\\n`);",
			"    } catch {",
			"    }",
			"  }",
			"};",
		].join("\n"),
	},
	{
		id: "rename-quota-retry",
		packageName: "pi-fabric",
		roots: ["dist"],
		marker: "[pi-fabric-hardening:rename-quota-retry]",
		label: "pi-fabric: atomic rename retries on quota/space/handle exhaustion",
		original: 'var RETRYABLE_RENAME_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EEXIST", "EBUSY"]);',
		patched:
			'var RETRYABLE_RENAME_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EEXIST", "EBUSY", "EDQUOT", "ENOSPC", "EIO", "EMFILE", "ENFILE"]); // [pi-fabric-hardening:rename-quota-retry] transient, retry instead of failing the write',
	},
	{
		id: "recovery-watchdog-timeout",
		packageName: "pi-fabric",
		roots: ["dist"],
		marker: "[pi-fabric-hardening:recovery-watchdog-timeout]",
		label: "pi-fabric: recovery watchdog timeout is configurable (default 10 min, was 60 s)",
		original: "var PI_RECOVERY_TIMEOUT_MS = 6e4;",
		patched: WATCHDOG_TIMEOUT_PATCH,
	},
	// --- exit diagnostics: keep the real cause of death visible ------------------
	{
		id: "exit-signal-decl",
		packageName: "pi-fabric",
		roots: ["dist"],
		marker: "[pi-fabric-hardening:exit-signal-decl]",
		label: "pi-fabric: declare exitSignal",
		original: "  const exitCode = await new Promise((resolve) => {",
		patched: [
			"  // [pi-fabric-hardening:exit-signal-decl] Record the terminating signal; a child killed",
			"  // by a signal otherwise reports only \"code unknown\".",
			"  let exitSignal = null;",
			"  const exitCode = await new Promise((resolve) => {",
		].join("\n"),
	},
	{
		id: "exit-signal-capture",
		packageName: "pi-fabric",
		roots: ["dist"],
		marker: "[pi-fabric-hardening:exit-signal-capture]",
		label: "pi-fabric: capture the child's terminating signal",
		original: '    child.once("close", (code) => resolve(code));',
		patched:
			'    child.once("close", (code, signal) => { exitSignal = signal; resolve(code); }); // [pi-fabric-hardening:exit-signal-capture]',
	},
	{
		id: "exit-signal-record",
		packageName: "pi-fabric",
		roots: ["dist"],
		marker: "[pi-fabric-hardening:exit-signal-record]",
		label: "pi-fabric: persist exitSignal in the run record",
		original: ["  record.exitCode = exitCode;", "  record.stderr = stderr.slice(-MAX_STDERR_CHARS);"].join("\n"),
		patched: [
			"  record.exitCode = exitCode;",
			"  if (exitSignal) record.exitSignal = exitSignal; // [pi-fabric-hardening:exit-signal-record]",
			"  record.stderr = stderr.slice(-MAX_STDERR_CHARS);",
		].join("\n"),
	},
	{
		id: "error-ordering",
		packageName: "pi-fabric",
		roots: ["dist"],
		marker: "[pi-fabric-hardening:error-ordering]",
		label: "pi-fabric: how the child died comes first, stderr becomes a detail",
		original:
			'    record.error = stderr.trim() || (exitCode === 0 ? `${runnerLabel(options.runner)} agent reported an error before exiting` : `${runnerLabel(options.runner)} exited with code ${exitCode ?? "unknown"}`);',
		patched: [
			"    // [pi-fabric-hardening:error-ordering] stderr is often an unrelated extension error",
			"    // (for example pi-fold's \"Evidence ingestion requires an absolute Pi session file\")",
			"    // and used to replace the real cause of death. Put the exit mode first.",
			"    const howDied = exitSignal !== null && exitSignal !== void 0",
			"      ? `${runnerLabel(options.runner)} was killed by ${exitSignal} (no exit code)`",
			"      : `${runnerLabel(options.runner)} exited with code ${exitCode ?? \"unknown\"}`;",
			"    const stderrTail = stderr.trim();",
			"    record.error = stderrTail && exitCode !== 0",
			"      ? `${howDied}; last stderr: ${stderrTail}`",
			"      : (stderrTail || howDied);",
		].join("\n"),
	},
	// --- pi-fold: a --no-session child has nothing to archive -------------------
	{
		id: "evidence-no-session-guard",
		packageName: "pi-fold",
		roots: ["extensions", "dist", "."],
		marker: "[pi-fabric-hardening:evidence-no-session-guard]",
		label: "pi-fold: skip evidence archiving when there is no session file",
		original: [
			'  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) {',
			'    throw new Error("Evidence ingestion requires an absolute Pi session file");',
			"  }",
		].join("\n"),
		patched: [
			'  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) {',
			"    // [pi-fabric-hardening:evidence-no-session-guard] Fabric starts durable children with",
			"    // --no-session, so there is no file to archive to. Skipping loses only evidence folding",
			"    // for oversized tool results; throwing pushed an unrelated error into the child's stderr.",
			"    return;",
			"  }",
		].join("\n"),
	},
];

const MAX_PATCHABLE_FILE_BYTES = 8 * 1024 * 1024;

export const piNpmDir = (): string =>
	process.env.PI_NPM_DIR?.trim() || join(process.env.PI_CODING_AGENT_DIR?.trim() || join(os.homedir(), ".pi", "agent"), "npm", "node_modules");

function jsFiles(dir: string, depth = 0): string[] {
	if (depth > 6) return [];
	let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			files.push(...jsFiles(full, depth + 1));
			continue;
		}
		if (!entry.isFile()) continue;
		if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
		try {
			if (statSync(full).size > MAX_PATCHABLE_FILE_BYTES) continue;
		} catch {
			continue;
		}
		files.push(full);
	}
	return files;
}

/** Every JS file inside the patch's roots of a package installed under the Pi npm dir. */
export function searchableFiles(patch: Patch, npmDir: string = piNpmDir()): string[] {
	const packageDir = join(npmDir, patch.packageName);
	const roots = patch.roots.length ? patch.roots : ["."];
	const seen = new Set<string>();
	for (const root of roots) for (const file of jsFiles(join(packageDir, root))) seen.add(file);
	return [...seen];
}

export type ApplyOptions = {
	npmDir?: string;
	include?: string[];
	exclude?: string[];
	write?: boolean;
};

export type ApplyReport = {
	applied: Array<{ id: string; label: string; files: string[] }>;
	already: Array<{ id: string; label: string; files: string[] }>;
	skipped: Array<{ id: string; label: string; reason: "missing" | "unexpected" | "disabled" }>;
};

/** Apply every selected patch. Idempotent; never throws on a cold or absent install. */
export function applyPatches(options: ApplyOptions = {}): ApplyReport {
	const npmDir = options.npmDir ?? piNpmDir();
	const write = options.write !== false;
	const report: ApplyReport = { applied: [], already: [], skipped: [] };
	for (const patch of PATCHES) {
		if (options.include?.length && !options.include.includes(patch.id)) {
			report.skipped.push({ id: patch.id, label: patch.label, reason: "disabled" });
			continue;
		}
		if (options.exclude?.includes(patch.id)) {
			report.skipped.push({ id: patch.id, label: patch.label, reason: "disabled" });
			continue;
		}
		const files = searchableFiles(patch, npmDir);
		if (files.length === 0) {
			report.skipped.push({ id: patch.id, label: patch.label, reason: "missing" });
			continue;
		}
		const patched: string[] = [];
		const already: string[] = [];
		let unexpected = 0;
		for (const file of files) {
			let content: string;
			try {
				content = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (content.includes(patch.marker)) {
				already.push(file);
				continue;
			}
			if (!content.includes(patch.original)) continue;
			if (write) {
				try {
					writeFileSync(file, content.replace(patch.original, patch.patched));
				} catch {
					unexpected += 1;
					continue;
				}
			}
			patched.push(file);
		}
		if (patched.length) report.applied.push({ id: patch.id, label: patch.label, files: patched });
		if (already.length) report.already.push({ id: patch.id, label: patch.label, files: already });
		if (!patched.length && !already.length) {
			report.skipped.push({
				id: patch.id,
				label: patch.label,
				reason: unexpected > 0 ? "unexpected" : "missing",
			});
		}
	}
	return report;
}
