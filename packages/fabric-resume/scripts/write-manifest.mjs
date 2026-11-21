#!/usr/bin/env node
/**
 * Rewrite overlay/manifest.json from a built pi-fabric `dist` tree.
 *
 *   node scripts/write-manifest.mjs --dist /tmp/pf-src/dist --upstream 0.139.0 --build resume-v2
 *
 * The tarball must already exist at overlay/dist.tar.gz, built from the same tree with
 * deterministic flags:
 *
 *   tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=ustar \
 *     -czf overlay/dist.tar.gz dist
 *
 * The manifest is what the startup applier trusts: it lists every file with its size and
 * sha256, so an archive that does not match it is refused before anything is written.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const arg = (name) => {
	const index = process.argv.indexOf(`--${name}`);
	return index < 0 ? undefined : process.argv[index + 1];
};

const distArg = arg("dist");
const upstream = arg("upstream");
const build = arg("build");
if (!distArg || !upstream || !build) {
	console.error("usage: write-manifest.mjs --dist <built dist> --upstream <pi-fabric version> --build <short id>");
	process.exit(2);
}

const dist = resolve(distArg);
const packageRoot = resolve(import.meta.dirname, "..");
const manifestPath = join(packageRoot, "overlay", "manifest.json");
const tarPath = join(packageRoot, "overlay", "dist.tar.gz");
try {
	statSync(tarPath);
} catch {
	console.error(`missing ${tarPath}: build the deterministic tarball first`);
	process.exit(2);
}

const files = [];
const walk = (directory) => {
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			walk(full);
			continue;
		}
		if (!entry.isFile()) continue;
		const data = readFileSync(full);
		files.push({
			path: `dist/${relative(dist, full).split(sep).join("/")}`,
			bytes: data.length,
			sha256: createHash("sha256").update(data).digest("hex"),
		});
	}
};
walk(dist);
if (files.length === 0) {
	console.error(`no files under ${dist}`);
	process.exit(1);
}

const manifest = {
	format: 1,
	upstream,
	build,
	marker: "dist/.pi-fabric-resume.json",
	tar: "overlay/dist.tar.gz",
	files,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`wrote ${manifestPath}: ${files.length} files, upstream ${upstream}, build ${build}`);
