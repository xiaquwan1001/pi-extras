/**
 * pi-fabric-hardening — runtime hardening for pi-fabric (and pi-fold), without forking.
 *
 * `pi install` runs with `--ignore-scripts` and an upgrade replaces `node_modules`
 * wholesale, so a manual edit to a dependency never survives. This extension re-applies
 * a small, idempotent, marker-guarded patch set on every Pi start:
 *
 *   1. status-write-guard          a failed status write no longer kills the host process
 *   2. rename-quota-retry          atomic rename retries on EDQUOT/ENOSPC/EIO/EMFILE/ENFILE
 *   3. recovery-watchdog-timeout   60 s -> PI_FABRIC_RECOVERY_TIMEOUT_MS (default 10 min)
 *   4. exit-signal-* + error-ordering
 *                                  a child killed by a signal reports the signal, and the
 *                                  exit mode is no longer hidden behind unrelated stderr
 *   5. evidence-no-session-guard   pi-fold skips evidence archiving for --no-session children
 *   6. tolerate-same-provider-model-drift
 *                                  a child that ends up on another model of the same provider
 *                                  keeps running (recorded on stderr) instead of being killed
 *
 * Plus one process-level fix that needs no patching: when `/tmp` is a small tmpfs, point
 * TMPDIR at a real disk before Fabric creates its run roots.
 *
 * Environment:
 *   PI_FABRIC_HARDENING=0               disable all patches
 *   PI_FABRIC_HARDENING=id1,id2         apply only these patch ids
 *   PI_FABRIC_HARDENING_EXCLUDE=id1     apply everything except these
 *   PI_FABRIC_TMPDIR=off|<dir>          tmpdir policy (see tmpdir.ts)
 *   PI_FABRIC_TMPDIR_MIN_FREE_MB=4096   relocation threshold
 *   PI_FABRIC_RECOVERY_TIMEOUT_MS=…     watchdog timeout used by patch 3
 *   PI_NPM_DIR=<dir>                    where Pi's npm packages live
 *   PI_CODING_AGENT_DIR=<dir>           Pi agent dir (default ~/.pi/agent)
 *
 * Remove this extension to revert; the patches are cosmetic text edits that a
 * `pi update` also overwrites.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyPatches } from "./patches";
import { relocateTmpDir } from "./tmpdir";

const log = (message: string) => {
	try {
		process.stderr.write(`[fabric-hardening] ${message}\n`);
	} catch {
		/* never break startup for a log line */
	}
};

function patchSelection(): { include?: string[]; exclude?: string[]; disabled: boolean } {
	const raw = process.env.PI_FABRIC_HARDENING?.trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return { disabled: true };
	const list = (value?: string) =>
		value
			?.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	const include = raw && !["1", "on", "true", "yes", "all"].includes(raw) ? list(raw) : undefined;
	const exclude = list(process.env.PI_FABRIC_HARDENING_EXCLUDE);
	return { include, exclude, disabled: false };
}

export default function fabricHardening(_pi: ExtensionAPI) {
	// Relocate first: Fabric reads os.tmpdir() when it creates a run root for a child.
	const relocation = relocateTmpDir();
	if (relocation) {
		log(
			`TMPDIR ${relocation.from} -> ${relocation.to}` +
				(relocation.freeMb === undefined ? "" : ` (tmpfs had ${relocation.freeMb} MB free)`),
		);
	}

	const selection = patchSelection();
	if (selection.disabled) {
		log("patches disabled by PI_FABRIC_HARDENING");
		return;
	}

	const report = applyPatches({ include: selection.include, exclude: selection.exclude });
	for (const entry of report.applied) {
		log(`patched ${entry.label} (${entry.files.length} file${entry.files.length === 1 ? "" : "s"})`);
	}
	for (const entry of report.skipped) {
		if (entry.reason === "unexpected") {
			log(`skipped ${entry.label}: upstream text changed (patch needs an update for this release)`);
		}
	}
	if (report.applied.length === 0 && report.already.length > 0) {
		log("already patched");
	}
}
