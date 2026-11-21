/**
 * pi-fabric-resume — resumable Fabric children, restored on every Pi start.
 *
 * `pi install` runs with `--ignore-scripts` and a pi-fabric upgrade replaces
 * `node_modules` wholesale, so a patched `dist` never survives on its own (measured
 * 2026-11-21: the 0.138.0 patch set disappeared with the 0.139.0 upgrade and
 * `agents.resume` silently stopped existing). This extension re-installs the prebuilt,
 * tested runtime overlay at startup, but only over the exact pi-fabric release the
 * overlay was built from.
 *
 * What the overlay adds (see patches/ and README.md):
 *   - `agents.childSession: true` gives every Pi child a private session file, so a
 *     terminal or interrupted child can be continued with `agents.resume({ id })`
 *     from its own transcript instead of a text summary
 *   - the run root of such a session lives under the user cache directory, keyed by
 *     the Pi session id, so a crash, a reboot or `pi -c` still finds the settled runs
 *   - a run whose host died mid-flight is adopted as an interrupted attempt once that
 *     host and the child process it launched are gone, so its transcript still counts
 *   - `retention.resumableRunMs` (default 7 days) bounds how long those runs stay
 *
 * Environment:
 *   PI_FABRIC_RESUME_PATCH=0|off   do not apply the overlay
 *   PI_NPM_DIR=<dir>               where Pi's npm packages live
 *   PI_CODING_AGENT_DIR=<dir>      Pi agent dir (default ~/.pi/agent)
 *
 * The overlay is refused, never forced, when the installed pi-fabric version differs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyResumeOverlay } from "./overlay";

const log = (message: string): void => {
	try {
		process.stderr.write(`[fabric-resume] ${message}\n`);
	} catch {
		// Never break startup for a log line.
	}
};

const packageRoot = (): string => fileURLToPath(new URL("..", import.meta.url));

const piNpmDir = (): string =>
	process.env.PI_NPM_DIR?.trim() ||
	join(process.env.PI_CODING_AGENT_DIR?.trim() || join(os.homedir(), ".pi", "agent"), "npm", "node_modules");

export default function fabricResume(_pi: ExtensionAPI): void {
	const raw = process.env.PI_FABRIC_RESUME_PATCH?.trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") {
		log("overlay disabled by PI_FABRIC_RESUME_PATCH");
		return;
	}
	let result: ReturnType<typeof applyResumeOverlay>;
	try {
		result = applyResumeOverlay({ packageRoot: packageRoot(), npmDir: piNpmDir() });
	} catch (error) {
		log(`overlay failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	switch (result.status) {
		case "applied":
			log(
				`patched pi-fabric ${result.detail ?? ""}: ${result.written ?? 0} files written, ${result.unchanged ?? 0} unchanged`,
			);
			break;
		case "already":
			log(`already applied (${result.detail ?? ""})`);
			break;
		case "version-mismatch":
			log(`skipped: ${result.detail}; rebuild the overlay for that release (packages/fabric-resume/README.md)`);
			break;
		case "locked":
			log("skipped: another Pi process is applying the overlay right now");
			break;
		case "integrity":
			log(`refused, nothing written: ${result.detail}`);
			break;
		case "missing":
			// pi-fabric is not installed in this environment; nothing to patch.
			break;
	}
}
