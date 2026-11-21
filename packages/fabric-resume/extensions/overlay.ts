/**
 * Install the prebuilt, patched pi-fabric runtime over the package Pi has installed.
 *
 * Why an overlay instead of a patch script: the resumable-child work is not a handful
 * of text substitutions — it adds a module, changes the agent manager, the config
 * schema, the guest surface and the settings UI. Expressing that as string patches
 * would be fragile, while rebuilding from source on every machine needs network,
 * Bun and several minutes. A full `dist` overlay is the same artifact that was
 * tested, applied in well under a second.
 *
 * The rules that keep it safe:
 *   - the installed `pi-fabric` version must equal the version the overlay was built
 *     from (`manifest.upstream`); any other release is refused, never partially mixed
 *   - every archive entry is verified (size + sha256) against the manifest before a
 *     single byte is written, so a corrupt tarball changes nothing
 *   - writes are per-file atomic (temp + rename) and skipped when the bytes already
 *     match, so a concurrent session never reads a half-written file
 *   - a marker inside `dist` records which build was applied, making the second and
 *     every later run a no-op
 *   - a small lock file keeps two Pi processes from applying at the same time
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export interface OverlayFile {
	path: string;
	bytes: number;
	sha256: string;
}

export interface OverlayManifest {
	format: number;
	/** Exact `pi-fabric` version this build was produced from. */
	upstream: string;
	/** Identifier written into the marker file. */
	build: string;
	/** Marker path, relative to the `pi-fabric` package directory. */
	marker: string;
	/** Tarball path, relative to this package. */
	tar: string;
	files: OverlayFile[];
}

export type OverlayStatus =
	| "applied"
	| "already"
	| "missing"
	| "version-mismatch"
	| "integrity"
	| "locked";

export interface OverlayResult {
	status: OverlayStatus;
	detail?: string;
	written?: number;
	unchanged?: number;
}

const MAX_ENTRIES = 8_192;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const LOCK_STALE_MS = 120_000;

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const readJson = (file: string): Record<string, unknown> | undefined => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
};

const cString = (buffer: Buffer, start: number, length: number): string => {
	const slice = buffer.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
};

/** Minimal ustar reader: regular files and directories, nothing else. */
export const extractDistTarGz = (archive: Buffer): Map<string, Buffer> => {
	const entries = new Map<string, Buffer>();
	const buffer = gunzipSync(archive);
	let offset = 0;
	let total = 0;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = cString(header, 0, 100);
		const prefix = cString(header, 345, 155);
		const path = prefix ? `${prefix}/${name}` : name;
		const sizeField = cString(header, 124, 12).trim();
		const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
		const type = String.fromCharCode(header[156] || 0x30);
		offset += 512;
		if (!Number.isFinite(size) || size < 0 || offset + size > buffer.length) {
			throw new Error(`truncated archive entry ${path}`);
		}
		const body = buffer.subarray(offset, offset + size);
		offset += Math.ceil(size / 512) * 512;
		// "0"/"\0" = regular file, "5" = directory; pax/long-name headers are skipped.
		if (type === "0" || type === "\0") {
			if (entries.size >= MAX_ENTRIES) throw new Error("archive has too many entries");
			total += size;
			if (total > MAX_TOTAL_BYTES) throw new Error("archive is larger than the overlay limit");
			entries.set(path, Buffer.from(body));
		}
	}
	return entries;
};

/** A manifest path is usable only when it stays inside the overlay's own root. */
const safeRelativePath = (path: string): string | undefined => {
	if (!path || path.startsWith("/") || path.includes("\\")) return undefined;
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
	return parts.join("/");
};

const readInstalledVersion = (packageDir: string): string | undefined => {
	const document = readJson(join(packageDir, "package.json"));
	const version = document?.version;
	return typeof version === "string" && version ? version : undefined;
};

const pidIsAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
};

/** Take the overlay lock, or report that another live process owns it. */
const acquireLock = (lockPath: string, now: number): boolean => {
	const existing = readJson(lockPath);
	const pid = typeof existing?.pid === "number" ? existing.pid : undefined;
	const at = typeof existing?.at === "number" ? existing.at : 0;
	if (pid !== undefined && pid !== process.pid && now - at < LOCK_STALE_MS && pidIsAlive(pid)) return false;
	try {
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: now }), { encoding: "utf8", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
};

const releaseLock = (lockPath: string): void => {
	try {
		rmSync(lockPath, { force: true });
	} catch {
		// A lock left behind expires on its own.
	}
};

/**
 * Write the overlay into `npmDir/pi-fabric` when it is missing or outdated.
 *
 * `npmDir` is the directory holding Pi's npm packages (`…/agent/npm/node_modules`).
 */
export const applyResumeOverlay = (options: {
	packageRoot: string;
	npmDir: string;
	now?: number;
}): OverlayResult => {
	const now = options.now ?? Date.now();
	const manifest = readJson(join(options.packageRoot, "overlay", "manifest.json")) as OverlayManifest | undefined;
	if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.files)) {
		return { status: "missing", detail: "overlay manifest" };
	}
	const target = join(options.npmDir, "pi-fabric");
	const version = readInstalledVersion(target);
	if (!version) return { status: "missing", detail: target };
	if (version !== manifest.upstream) {
		return {
			status: "version-mismatch",
			detail: `installed pi-fabric ${version}, overlay built for ${manifest.upstream}`,
		};
	}
	const markerPath = join(target, manifest.marker);
	if (readJson(markerPath)?.build === manifest.build) return { status: "already", detail: manifest.build };

	const lockPath = join(target, ".pi-fabric-resume.lock");
	if (!acquireLock(lockPath, now)) return { status: "locked", detail: lockPath };
	try {
		let entries: Map<string, Buffer>;
		try {
			entries = extractDistTarGz(readFileSync(join(options.packageRoot, manifest.tar)));
		} catch (error) {
			return { status: "integrity", detail: `archive unreadable: ${error instanceof Error ? error.message : String(error)}` };
		}
		const expected = new Map<string, OverlayFile>();
		for (const entry of manifest.files) {
			if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string") {
				return { status: "integrity", detail: "malformed manifest entry" };
			}
			expected.set(entry.path, entry);
		}
		let written = 0;
		let unchanged = 0;
		const pending: Array<{ path: string; data: Buffer }> = [];
		for (const [path, data] of entries) {
			const safe = safeRelativePath(path);
			const want = safe === undefined ? undefined : expected.get(safe);
			if (safe === undefined || !want) return { status: "integrity", detail: `unexpected archive entry ${path}` };
			if (data.length !== want.bytes || sha256(data) !== want.sha256) {
				return { status: "integrity", detail: `checksum mismatch for ${path}` };
			}
			pending.push({ path: safe, data });
		}
		if (pending.length !== expected.size) {
			return { status: "integrity", detail: `archive holds ${pending.length} files, manifest lists ${expected.size}` };
		}
		for (const { path, data } of pending) {
			const destination = join(target, path);
			try {
				if (statSync(destination).size === data.length && sha256(readFileSync(destination)) === sha256(data)) {
					unchanged += 1;
					continue;
				}
			} catch {
				// Missing or unreadable: (re)write it.
			}
			mkdirSync(dirname(destination), { recursive: true });
			const temporary = `${destination}.resume-overlay-${process.pid}`;
			writeFileSync(temporary, data, { mode: 0o644 });
			renameSync(temporary, destination);
			written += 1;
		}
		writeFileSync(
			markerPath,
			JSON.stringify(
				{ format: 1, upstream: manifest.upstream, build: manifest.build, appliedAt: new Date(now).toISOString() },
				null,
				2,
			),
			{ encoding: "utf8", mode: 0o644 },
		);
		return { status: "applied", detail: manifest.build, written, unchanged };
	} finally {
		releaseLock(lockPath);
	}
};
