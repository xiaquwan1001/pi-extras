/**
 * Keep Pi's temp directory off a small tmpfs.
 *
 * Fabric creates one run root per Pi process under `os.tmpdir()`, plus per-run status
 * and event logs. On many distributions `/tmp` is a tmpfs sized at 50% of RAM, and a
 * full tmpfs turns every state write into `EDQUOT`/`ENOSPC` — historically enough to
 * take the whole Pi process down (see the status-write guard).
 *
 * Policy:
 *   - `PI_FABRIC_TMPDIR=off` disables this entirely.
 *   - `PI_FABRIC_TMPDIR=<dir>` always relocates to that directory.
 *   - otherwise relocate to `~/.cache/pi-tmp` only when the current temp dir is a
 *     tmpfs with less than `PI_FABRIC_TMPDIR_MIN_FREE_MB` (default 4096) MB free.
 *   - an already-set `TMPDIR` that is not a tmpfs is left alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMPFS_MAGIC = 0x01021994;

export type Relocation = { from: string; to: string; freeMb?: number };

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

export function relocateTmpDir(): Relocation | undefined {
	const explicit = process.env.PI_FABRIC_TMPDIR?.trim();
	if (explicit && /^(off|0|false|no)$/i.test(explicit)) return undefined;

	const current = process.env.TMPDIR?.trim() || os.tmpdir();
	const target = explicit || path.join(os.homedir(), ".cache", "pi-tmp");
	if (path.resolve(current) === path.resolve(target)) return undefined;

	let isTmpfs = false;
	let freeMb: number | undefined;
	try {
		const stats = fs.statfsSync(current);
		isTmpfs = Number(stats.type) === TMPFS_MAGIC;
		freeMb = mb(Number(stats.bavail) * Number(stats.bsize));
	} catch {
		return undefined; // unknown filesystem: do not guess
	}

	if (!explicit) {
		if (!isTmpfs) return undefined; // a real disk: respect the user's choice
		const minFreeMb = Number(process.env.PI_FABRIC_TMPDIR_MIN_FREE_MB ?? 4096);
		if (Number.isFinite(minFreeMb) && freeMb !== undefined && freeMb >= minFreeMb) return undefined;
	}

	try {
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	} catch {
		return undefined;
	}
	process.env.TMPDIR = target;
	return { from: current, to: target, freeMb };
}
