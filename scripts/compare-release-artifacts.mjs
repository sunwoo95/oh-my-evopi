#!/usr/bin/env node
/**
 * Compare a locally built release (the release.yml dry-run artifact or a
 * pack-evopi-release.mjs output) with a published version on GitHub Pages.
 *
 * Usage:
 *   node scripts/compare-release-artifacts.mjs <artifact-dir> <version>
 *       [--base-url <url>] [--published-dir <dir>] [--no-content]
 *
 *   <artifact-dir>   either a Pages site tree (contains releases/v<version>/SHA256SUMS,
 *                    as uploaded by the dry run) or a pack `artifacts/` directory
 *                    (contains SHA256SUMS directly)
 *   <version>        the published version to compare against, e.g. 0.11.0 or v0.11.0
 *   --base-url       Pages base URL (default https://sunwoo95.github.io/oh-my-evopi,
 *                    or EVOPI_DOWNLOAD_BASE_URL)
 *   --published-dir  compare against a local copy instead of downloading (e.g. a
 *                    gh-pages checkout, same layout rules as <artifact-dir>)
 *   --no-content     only compare SHA256SUMS; skip the per-entry tarball diff
 *
 * Output: one line per tarball listed in either SHA256SUMS — MATCH, MISMATCH,
 * MISSING (published but not built) or EXTRA (built but not published). For
 * every MISMATCH the two tarballs are unpacked in memory and their entry lists
 * (path, size, mode, sha256) are diffed, and package/package.json is compared
 * key by key, so the nondeterministic input can be named instead of guessed.
 * Byte-identical tarballs are only expected when the build inputs are
 * identical; see docs/release.md ("Reproducibility").
 *
 * Exit code: 0 all tarballs match, 1 any mismatch/missing/extra, 2 usage or I/O error.
 * Node built-ins only.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const DEFAULT_BASE_URL = "https://sunwoo95.github.io/oh-my-evopi";
const USAGE =
	"Usage: node scripts/compare-release-artifacts.mjs <artifact-dir> <version> [--base-url <url>] [--published-dir <dir>] [--no-content]";

export function normalizeVersion(version) {
	const normalized = String(version).replace(/^v/, "");
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) {
		throw new Error(`Invalid version: ${version}`);
	}
	return normalized;
}

export function parseArgs(argv, env = process.env) {
	const parsed = {
		artifactDir: undefined,
		version: undefined,
		baseUrl: env.EVOPI_DOWNLOAD_BASE_URL || DEFAULT_BASE_URL,
		publishedDir: undefined,
		content: true,
	};
	const positionals = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "--base-url":
				parsed.baseUrl = argv[++i];
				if (!parsed.baseUrl) throw new Error("--base-url requires a value");
				break;
			case "--published-dir":
				parsed.publishedDir = argv[++i];
				if (!parsed.publishedDir) throw new Error("--published-dir requires a value");
				break;
			case "--no-content":
				parsed.content = false;
				break;
			case "--help":
			case "-h":
				console.log(USAGE);
				process.exit(0);
				break;
			default:
				if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
				positionals.push(arg);
		}
	}
	if (positionals.length !== 2) throw new Error(USAGE);
	parsed.artifactDir = resolve(positionals[0]);
	parsed.version = normalizeVersion(positionals[1]);
	parsed.baseUrl = parsed.baseUrl.replace(/\/+$/, "");
	return parsed;
}

/** `<sha>  <file>` lines (sha256sum format, as written by pack-evopi-release.mjs). */
export function parseSha256Sums(text) {
	const entries = new Map();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
		if (!match) throw new Error(`Malformed SHA256SUMS line: ${rawLine}`);
		entries.set(match[2].trim(), match[1].toLowerCase());
	}
	return entries;
}

export function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Accept either a Pages site tree (releases/v<version>/SHA256SUMS) or a pack
 * `artifacts/` directory (SHA256SUMS at the top level).
 */
export function resolveReleaseDir(dir, version) {
	const siteLayout = join(dir, "releases", `v${version}`);
	if (existsSync(join(siteLayout, "SHA256SUMS"))) return siteLayout;
	if (existsSync(join(dir, "SHA256SUMS"))) return dir;
	throw new Error(`No SHA256SUMS under ${dir} (expected ${siteLayout}/SHA256SUMS or ${dir}/SHA256SUMS)`);
}

// ---------------------------------------------------------------------------
// Minimal tar reader (ustar + pax `x` path override + GNU `L` long names), enough
// for npm pack output. Returns Map<path, { size, mode, sha256 }> for regular files.
// ---------------------------------------------------------------------------

function readField(block, offset, length) {
	const bytes = block.subarray(offset, offset + length);
	const end = bytes.indexOf(0);
	return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function readOctal(block, offset, length) {
	const bytes = block.subarray(offset, offset + length);
	if (bytes[0] & 0x80) {
		// base-256 (GNU) encoding for sizes that do not fit in octal.
		let value = 0;
		for (let i = 1; i < bytes.length; i += 1) value = value * 256 + bytes[i];
		return value;
	}
	const text = readField(block, offset, length).trim();
	return text ? Number.parseInt(text, 8) : 0;
}

function parsePaxRecords(buffer) {
	const records = {};
	let offset = 0;
	while (offset < buffer.length) {
		const space = buffer.indexOf(0x20, offset);
		if (space === -1) break;
		const length = Number.parseInt(buffer.subarray(offset, space).toString("utf8"), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = buffer.subarray(space + 1, offset + length - 1).toString("utf8");
		const eq = record.indexOf("=");
		if (eq !== -1) records[record.slice(0, eq)] = record.slice(eq + 1);
		offset += length;
	}
	return records;
}

export function listTarballEntries(tgz) {
	const tar = gunzipSync(tgz);
	const entries = new Map();
	let offset = 0;
	let paxPath;
	let longName;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = readField(header, 0, 100);
		const mode = readOctal(header, 100, 8) & 0o777;
		const size = readOctal(header, 124, 12);
		const typeflag = String.fromCharCode(header[156] || 0x30);
		const prefix = readField(header, 345, 155);
		const dataStart = offset + 512;
		const data = tar.subarray(dataStart, dataStart + size);
		offset = dataStart + Math.ceil(size / 512) * 512;

		if (typeflag === "x") {
			paxPath = parsePaxRecords(data).path;
			continue;
		}
		if (typeflag === "L") {
			longName = readField(data, 0, data.length);
			continue;
		}
		if (typeflag === "g") continue;

		const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
		paxPath = undefined;
		longName = undefined;
		if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
			entries.set(path, { size, mode, sha256: sha256(data), data });
		}
	}
	return entries;
}

export function diffEntries(local, published) {
	const onlyLocal = [...local.keys()].filter((path) => !published.has(path)).sort();
	const onlyPublished = [...published.keys()].filter((path) => !local.has(path)).sort();
	const changed = [...local.keys()]
		.filter((path) => published.has(path))
		.filter((path) => {
			const a = local.get(path);
			const b = published.get(path);
			return a.sha256 !== b.sha256 || a.mode !== b.mode;
		})
		.sort();
	const identical = [...local.keys()].filter((path) => published.has(path)).length - changed.length;
	return { onlyLocal, onlyPublished, changed, identical };
}

/** Top-level keys whose JSON differs; nested keys for object-valued fields. */
export function diffPackageJson(localText, publishedText) {
	let local;
	let published;
	try {
		local = JSON.parse(localText);
		published = JSON.parse(publishedText);
	} catch (error) {
		return [`(unparseable package.json: ${error instanceof Error ? error.message : String(error)})`];
	}
	const differences = [];
	for (const key of new Set([...Object.keys(local), ...Object.keys(published)])) {
		const a = local[key];
		const b = published[key];
		if (JSON.stringify(a) === JSON.stringify(b)) continue;
		const bothObjects = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
		if (!bothObjects) {
			differences.push(`${key}: ${JSON.stringify(a)} -> published ${JSON.stringify(b)}`);
			continue;
		}
		for (const nested of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (JSON.stringify(a[nested]) !== JSON.stringify(b[nested])) {
				differences.push(`${key}.${nested}: ${JSON.stringify(a[nested])} -> published ${JSON.stringify(b[nested])}`);
			}
		}
	}
	return differences.sort();
}

// ---------------------------------------------------------------------------
// Sources: a local directory or the Pages URL.
// ---------------------------------------------------------------------------

async function fetchBytes(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

function directorySource(dir, version) {
	const releaseDir = resolveReleaseDir(dir, version);
	return {
		label: releaseDir,
		sums: () => readFileSync(join(releaseDir, "SHA256SUMS"), "utf8"),
		tarball: (file) => {
			const path = join(releaseDir, file);
			return existsSync(path) && statSync(path).isFile() ? readFileSync(path) : undefined;
		},
	};
}

function remoteSource(baseUrl, version) {
	const releaseUrl = `${baseUrl}/releases/v${version}`;
	return {
		label: releaseUrl,
		sums: async () => (await fetchBytes(`${releaseUrl}/SHA256SUMS`)).toString("utf8"),
		tarball: (file) => fetchBytes(`${releaseUrl}/${file}`),
	};
}

function short(sha) {
	return `${sha.slice(0, 16)}…`;
}

function bundleHint(paths) {
	return paths.length > 0 && paths.every((path) => path.startsWith("package/dist/bundle/"))
		? "  hint: all differences are under dist/bundle/ — the esbuild bundle embeds __PI_BUILD_ID__ from `git describe` (packages/coding-agent/scripts/bundle.mjs), so a different commit/tag/dirty state changes chunk names and cli.js even when the sources are identical."
		: undefined;
}

export async function compareRelease(options, log = console.log) {
	const local = directorySource(options.artifactDir, options.version);
	const published = options.publishedDir
		? directorySource(options.publishedDir, options.version)
		: remoteSource(options.baseUrl, options.version);

	log(`Comparing v${options.version}`);
	log(`  local:     ${local.label}`);
	log(`  published: ${published.label}`);
	log("");

	const localSums = parseSha256Sums(await local.sums());
	const publishedSums = parseSha256Sums(await published.sums());
	const files = [...new Set([...publishedSums.keys(), ...localSums.keys()])].sort();
	const width = Math.max(...files.map((file) => file.length), 8);

	const summary = { match: 0, mismatch: 0, missing: 0, extra: 0, stale: 0 };
	for (const file of files) {
		const expected = publishedSums.get(file);
		const localBytes = local.tarball(file);
		if (!expected) {
			summary.extra += 1;
			log(`EXTRA     ${file.padEnd(width)}  built locally but not published`);
			continue;
		}
		if (!localBytes) {
			summary.missing += 1;
			log(`MISSING   ${file.padEnd(width)}  published ${short(expected)} but not built locally`);
			continue;
		}
		const actual = sha256(localBytes);
		const listed = localSums.get(file);
		if (listed && listed !== actual) {
			summary.stale += 1;
			log(`STALE     ${file.padEnd(width)}  local SHA256SUMS says ${short(listed)} but the file hashes to ${short(actual)}`);
		}
		if (actual === expected) {
			summary.match += 1;
			log(`MATCH     ${file.padEnd(width)}  ${actual}`);
			continue;
		}
		summary.mismatch += 1;
		log(`MISMATCH  ${file.padEnd(width)}  local ${short(actual)}  published ${short(expected)}`);
		log(`            local     ${actual}`);
		log(`            published ${expected}`);
		if (!options.content) continue;

		const publishedBytes = await published.tarball(file);
		if (!publishedBytes) {
			log("            (published tarball unavailable; content diff skipped)");
			continue;
		}
		const localEntries = listTarballEntries(localBytes);
		const publishedEntries = listTarballEntries(publishedBytes);
		const diff = diffEntries(localEntries, publishedEntries);
		log(
			`            content: ${diff.identical} identical, ${diff.changed.length} changed, ${diff.onlyLocal.length} only-local, ${diff.onlyPublished.length} only-published`,
		);
		for (const path of diff.changed) {
			const a = localEntries.get(path);
			const b = publishedEntries.get(path);
			const modeNote = a.mode !== b.mode ? ` mode ${a.mode.toString(8)} -> ${b.mode.toString(8)}` : "";
			log(`              changed         ${path}  (${a.size} -> published ${b.size} bytes${modeNote})`);
		}
		for (const path of diff.onlyLocal) log(`              only-local      ${path}`);
		for (const path of diff.onlyPublished) log(`              only-published  ${path}`);
		const hint = bundleHint([...diff.changed, ...diff.onlyLocal, ...diff.onlyPublished]);
		if (hint) log(hint);

		const localPkg = localEntries.get("package/package.json");
		const publishedPkg = publishedEntries.get("package/package.json");
		if (localPkg && publishedPkg) {
			const pkgDiff = diffPackageJson(localPkg.data.toString("utf8"), publishedPkg.data.toString("utf8"));
			if (pkgDiff.length === 0) {
				log("            package.json: identical");
			} else {
				log("            package.json differs:");
				for (const line of pkgDiff) log(`              ${line}`);
			}
		}
	}

	log("");
	log(
		`Summary: ${summary.match} match, ${summary.mismatch} mismatch, ${summary.missing} missing, ${summary.extra} extra` +
			(summary.stale ? `, ${summary.stale} stale local SHA256SUMS entries` : ""),
	);
	const ok = summary.mismatch === 0 && summary.missing === 0 && summary.extra === 0 && summary.stale === 0;
	return { ok, summary };
}

export async function main(argv = process.argv.slice(2)) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	try {
		const { ok } = await compareRelease(options);
		return ok ? 0 : 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
	process.exitCode = await main();
}
