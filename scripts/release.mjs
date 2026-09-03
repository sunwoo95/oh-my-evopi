#!/usr/bin/env node
/**
 * Release script for pi-mono
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs <target> --dry-run   (preview changelog updates only)
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump (or set) the version with `npm version -ws --include-workspace-root`,
 *    verify every package.json (npm's exit code is advisory, see npmVersionVerified),
 *    then sync inter-package ranges and reinstall to rebuild the lockfile
 * 3. Update CHANGELOG.md files: aggregate .changes/*.md fragments into a
 *    [version] - date section, git rm the consumed fragments
 * 4. Commit and tag
 * 5. Publish to npm
 */

import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { buildReleaseSection } from "./lib/changelog-fragments.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const RELEASE_TARGET = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z> [--dry-run]");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

/** package.json paths `npm version -ws --include-workspace-root` writes: root + every workspace. */
function workspacePackageJsonPaths() {
	const paths = ["package.json"];
	for (const pattern of readJson("package.json").workspaces ?? []) {
		if (pattern.endsWith("/*")) {
			const dir = pattern.slice(0, -2);
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const pkgPath = join(dir, entry.name, "package.json");
				if (entry.isDirectory() && existsSync(pkgPath)) paths.push(pkgPath);
			}
		} else if (existsSync(join(pattern, "package.json"))) {
			paths.push(join(pattern, "package.json"));
		}
	}
	return paths;
}

/**
 * Bump every package.json to `expectedVersion` with `npm version`.
 *
 * npm writes all workspace package.json files first and only then runs an
 * arborist reify to refresh the lockfile. When the bump leaves a caret range
 * behind (0.10.0 → 0.11.0 no longer satisfies a sibling's `^0.10.0`), that reify
 * resolves the sibling from the registry, hits E404 for the unpublished @evopi/*
 * packages and exits 1 — after the versions were already written (NEXT-STEPS E3).
 * The exit code is therefore advisory: the files are the source of truth, and
 * sync-versions + the fresh `npm install` below rebuild the lockfile anyway.
 */
function npmVersionVerified(target, expectedVersion) {
	const npmArgs = ["version", target, "--workspaces", "--include-workspace-root", "--no-git-tag-version"];
	console.log(`$ npm ${npmArgs.join(" ")}`);
	const result = spawnSync("npm", npmArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.error) {
		console.error(`Command failed: npm ${npmArgs.join(" ")}: ${result.error.message}`);
		process.exit(1);
	}

	const paths = workspacePackageJsonPaths();
	const mismatched = paths
		.map((path) => ({ path, version: readJson(path).version }))
		.filter(({ version }) => version !== expectedVersion);
	if (mismatched.length > 0) {
		console.error(`Error: npm version exited ${result.status}; expected every package.json at ${expectedVersion}:`);
		for (const { path, version } of mismatched) console.error(`  ${path}: ${version}`);
		if (result.stderr) console.error(result.stderr.trim());
		process.exit(1);
	}
	if (result.status !== 0) {
		console.warn(
			`Warning: npm version exited ${result.status} but all ${paths.length} package.json files are at ${expectedVersion}; continuing.`,
		);
		if (result.stderr) console.warn(result.stderr.trim());
	} else {
		console.log(`  ${paths.length} package.json files at ${expectedVersion}`);
	}
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}
		console.log(`Setting explicit version (${target})...`);
	}

	npmVersionVerified(target, previewVersion(target));
	run("node scripts/sync-versions.js");
	run("npx shx rm -rf node_modules packages/*/node_modules package-lock.json");
	run("npm install");
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function listFragments(pkgDir) {
	const changesDir = join(pkgDir, ".changes");
	if (!existsSync(changesDir)) {
		return [];
	}

	const files = readdirSync(changesDir)
		.filter((name) => name.endsWith(".md") && name !== "README.md")
		.map((name) => join(changesDir, name));
	return files
		.map((path) => ({ path, key: fragmentSortKey(path) }))
		.sort((a, b) => a.key - b.key || (a.path < b.path ? -1 : 1))
		.map(({ path }) => ({ name: path, content: readFileSync(path, "utf-8") }));
}

function fragmentSortKey(path) {
	const output = run(`git log --diff-filter=A --format=%ct -1 -- ${shellQuote(path)}`, {
		silent: true,
		ignoreError: true,
	});
	const epoch = Number.parseInt((output || "").trim(), 10);
	return Number.isFinite(epoch) ? epoch : Infinity;
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();
	const consumedFragments = [];

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");
		const allFragments = listFragments(dirname(changelog));
		// Empty fragments are skipped, not consumed, so nothing is ever lost silently.
		const empty = allFragments.filter((fragment) => !fragment.content.trim());
		for (const fragment of empty) {
			console.warn(`  Warning: skipping empty fragment ${fragment.name}; delete it or add content.`);
		}
		const fragments = allFragments.filter((fragment) => fragment.content.trim());
		const result = buildReleaseSection(content, fragments, version, date);

		if (!result.changed) {
			console.log(`  Skipping ${changelog}: no fragments`);
			continue;
		}

		if (DRY_RUN) {
			console.log(`\n--- ${changelog} (${fragments.length} fragments) ---`);
			const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const sectionRe = new RegExp(`## \\[${escapedVersion}\\][\\s\\S]*?(?=\\n## \\[|$)`);
			console.log((result.content.match(sectionRe) || ["(no release section)"])[0]);
		} else {
			writeFileSync(changelog, result.content);
			console.log(`  Updated ${changelog} (${fragments.length} fragments)`);
		}
		consumedFragments.push(...fragments.map((fragment) => fragment.name));
	}

	if (consumedFragments.length > 0) {
		if (DRY_RUN) {
			console.log(`\nWould git rm: ${consumedFragments.join(", ")}`);
		} else {
			run(`git rm -q -- ${consumedFragments.map(shellQuote).join(" ")}`);
		}
	}
}

function previewVersion(target) {
	if (!BUMP_TYPES.has(target)) {
		return target;
	}
	const [major, minor, patch] = getVersion().split(".").map(Number);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

console.log("\n=== Release Script ===\n");

if (DRY_RUN) {
	const version = previewVersion(RELEASE_TARGET);
	console.log(`Dry run for v${version}: previewing changelog updates, no files are written.`);
	updateChangelogsForRelease(version);
	console.log("\n=== Dry run complete (no changes made) ===");
	process.exit(0);
}

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

console.log("Publishing to npm...");
run("npm run publish");
console.log();

console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
