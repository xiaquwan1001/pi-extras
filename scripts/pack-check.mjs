#!/usr/bin/env node
// pack-check: for each package under packages/, run `npm pack --dry-run --json`
// and assert:
//   1. no sensitive paths/secrets in the file list or file contents
//   2. required files are present in the tarball listing
//   3. package has no runtime "dependencies"
// Exits non-zero on any failure.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const REQUIRED_FILES = ["package.json", "README.md", "LICENSE"];
const FORBIDDEN_PATTERNS = [
	/node_modules\//,
	/^\//, // absolute paths
	/\.\./, // path traversal
	/\/home\//,
	/xuqianhui/i,
	/ustc/i,
	/114\.214\.240/,
	/127\.0\.0\.1/,
	/USTC_KEY/,
	/os\.environ/,
	/xiaquwan(?!1001)/, // GitHub org "xiaquwan1001" in repo URLs is fine
];

// Content-level scan: these substrings must not appear in any packed text file.
// Note: bare "ustc" in incident comments is allowed (public product/incident names);
// real hosts, keys and personal paths are not.
const FORBIDDEN_CONTENT = [
	/xuqianhui/i,
	/\/home\/xu/,
	/114\.214\.240/,
	/USTC_KEY/,
	/os\.environ.*USTC/,
	/api\.llm\.ustc\.edu\.cn/,
	/sk-[A-Za-z0-9]{8,}/,
	/npm_[A-Za-z0-9]{8,}/,
	/glpat-[A-Za-z0-9]{8,}/,
];
const TEXT_EXTENSIONS = [".ts", ".mjs", ".js", ".json", ".md", ".patch", ".txt", ".mjs"];

let failures = 0;
const fail = (pkg, msg) => {
	failures++;
	console.error(`FAIL [${pkg}] ${msg}`);
};

for (const entry of readdirSync(packagesDir).sort()) {
	const pkgDir = join(packagesDir, entry);
	if (!statSync(pkgDir).isDirectory()) continue;
	const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	const name = manifest.name;

	// 3. dependencies must be empty
	if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
		fail(name, `dependencies is not empty: ${JSON.stringify(manifest.dependencies)}`);
	}

	// 1. pack dry-run listing
	let listing;
	try {
		listing = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
		)[0];
	} catch (err) {
		fail(name, `npm pack --dry-run --json failed: ${err.message}`);
		continue;
	}

	const files = listing.files.map((f) => f.path);
	console.log(`[${name}] ${files.length} files in pack`);

	for (const path of files) {
		for (const pattern of FORBIDDEN_PATTERNS) {
			if (pattern.test(path)) fail(name, `sensitive path pattern ${pattern} matched: ${path}`);
		}
	}

	// 2. required files
	for (const required of REQUIRED_FILES) {
		if (!files.includes(required)) fail(name, `required file missing from pack: ${required}`);
	}

	// pi.extensions targets must exist in the pack
	for (const ext of manifest.pi?.extensions ?? []) {
		const target = ext.replace(/^\.\//, "");
		if (!files.includes(target)) fail(name, `pi.extensions target not in pack: ${target}`);
	}

	// content scan of packed text files
	for (const path of files) {
		if (!TEXT_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
		let content;
		try {
			content = readFileSync(join(pkgDir, path), "utf8");
		} catch {
			continue;
		}
		for (const pattern of FORBIDDEN_CONTENT) {
			if (pattern.test(content)) fail(name, `sensitive content ${pattern} in ${relative(root, join(pkgDir, path))}`);
		}
	}
}

if (failures > 0) {
	console.error(`\npack-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\npack-check: all packages OK");
