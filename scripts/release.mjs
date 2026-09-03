#!/usr/bin/env node
/**
 * Release script for evopi.
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs <target> --dry-run       (preview changelog updates only)
 *   node scripts/release.mjs <target> --npm-publish   (also publish to the npm registry)
 *
 * Steps:
 * 1. Check for uncommitted changes and that the current branch is `main`;
 *    refuse if the tag vX.Y.Z already exists locally or on origin
 * 2. Bump (or set) the version with `npm version -ws --include-workspace-root`,
 *    verify every package.json (npm's exit code is advisory, see npmVersionVerified),
 *    then sync inter-package ranges and update only the lockfile's workspace version fields
 * 3. Update CHANGELOG.md files: aggregate .changes/*.md fragments into a
 *    [version] - date section, git rm the consumed fragments
 * 4. Commit ("Release vX.Y.Z") and create a plain lightweight tag vX.Y.Z on it
 * 5. npm registry publish is OPT-IN (`--npm-publish` or EVOPI_RELEASE_NPM_PUBLISH=1)
 *    and skipped by default: GitHub Pages is the only distribution channel
 * 6. Push the branch, then push ONLY that tag (`git push origin refs/tags/vX.Y.Z`,
 *    never `--tags`). The tag push triggers .github/workflows/release.yml, which
 *    builds, packs and publishes releases/vX.Y.Z to gh-pages. See docs/release.md.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReleaseSection } from "./lib/changelog-fragments.mjs";

export const NPM_PUBLISH_ENV = "EVOPI_RELEASE_NPM_PUBLISH";
export const NPM_PUBLISH_FLAG = "--npm-publish";
export const DRY_RUN_FLAG = "--dry-run";
export const RELEASE_BRANCH = "main";
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

const KNOWN_FLAGS = new Set([DRY_RUN_FLAG, NPM_PUBLISH_FLAG]);
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const USAGE = `Usage: node scripts/release.mjs <major|minor|patch|x.y.z> [${DRY_RUN_FLAG}] [${NPM_PUBLISH_FLAG}]`;

/** True when the operator explicitly asked for an npm registry publish (flag or env). */
export function npmPublishRequested(argv, env = process.env) {
	if (argv.includes(NPM_PUBLISH_FLAG)) return true;
	const value = (env[NPM_PUBLISH_ENV] ?? "").trim().toLowerCase();
	return value === "1" || value === "true";
}

export function isValidReleaseTarget(target) {
	return typeof target === "string" && (BUMP_TYPES.has(target) || SEMVER_RE.test(target));
}

export function tagNameFor(version) {
	return `v${version}`;
}

/**
 * Parse the CLI: one positional release target plus known `--` flags.
 * Unknown flags are reported (a typo like `--npm-publsh` must not silently
 * fall back to the default behaviour).
 */
export function parseReleaseArgs(argv, env = process.env) {
	const flags = argv.filter((arg) => arg.startsWith("--"));
	const positionals = argv.filter((arg) => !arg.startsWith("--"));
	return {
		target: positionals[0],
		extraPositionals: positionals.slice(1),
		unknownFlags: flags.filter((flag) => !KNOWN_FLAGS.has(flag)),
		dryRun: flags.includes(DRY_RUN_FLAG),
		npmPublish: npmPublishRequested(argv, env),
	};
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (_error) {
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
 * The exit code is therefore advisory: the files are the source of truth; the
 * caller restores the pre-bump lockfile and updates only its workspace versions.
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

	// Keep the committed lockfile as the source of truth: `npm version`'s failed
	// reify (E404, see npmVersionVerified) can leave package-lock.json half
	// rewritten, and a from-scratch `npm install` re-resolves every range (silent
	// dependency upgrades — the 0.12.0 attempt also dropped @oh-my-pi/pi-natives
	// and made `npm ci` fail in the release workflow). Snapshot → bump → restore →
	// update only the workspace version fields with --package-lock-only.
	const lockfile = "package-lock.json";
	const lockfileBefore = readFileSync(lockfile, "utf-8");
	npmVersionVerified(target, previewVersion(target));
	writeFileSync(lockfile, lockfileBefore);
	run("node scripts/sync-versions.js");
	run("npm install --package-lock-only --ignore-scripts --no-audit --no-fund");
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

function updateChangelogsForRelease(version, dryRun) {
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

		if (dryRun) {
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
		if (dryRun) {
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

function currentBranch() {
	return (run("git rev-parse --abbrev-ref HEAD", { silent: true }) || "").trim();
}

/** Refuse to create a tag that already exists locally or on origin (the workflow would refuse it anyway). */
function assertTagAvailable(tag) {
	const local = run(`git rev-parse -q --verify ${shellQuote(`refs/tags/${tag}`)}`, { silent: true, ignoreError: true });
	if (local && local.trim()) {
		console.error(`Error: tag ${tag} already exists locally (${local.trim()}). Releases are immutable; pick a new version.`);
		process.exit(1);
	}
	const remote = run(`git ls-remote --exit-code --tags origin ${shellQuote(`refs/tags/${tag}`)}`, {
		silent: true,
		ignoreError: true,
	});
	if (remote && remote.trim()) {
		console.error(`Error: tag ${tag} already exists on origin. Releases are immutable; pick a new version.`);
		process.exit(1);
	}
}

export function main(argv = process.argv.slice(2), env = process.env) {
	// Paths below are repo-relative; `npm run release:*` already runs from the root.
	process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

	const args = parseReleaseArgs(argv, env);
	if (!isValidReleaseTarget(args.target) || args.extraPositionals.length > 0 || args.unknownFlags.length > 0) {
		if (args.unknownFlags.length > 0) console.error(`Unknown flag(s): ${args.unknownFlags.join(", ")}`);
		console.error(USAGE);
		process.exit(1);
	}

	console.log("\n=== Release Script ===\n");

	if (args.dryRun) {
		const version = previewVersion(args.target);
		console.log(`Dry run for v${version}: previewing changelog updates, no files are written.`);
		updateChangelogsForRelease(version, true);
		console.log(
			`\nnpm registry publish would be ${args.npmPublish ? "RUN" : "SKIPPED"} (${NPM_PUBLISH_FLAG} / ${NPM_PUBLISH_ENV}=1 opt in).`,
		);
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
	console.log("  Working directory clean");

	const branch = currentBranch();
	if (branch !== RELEASE_BRANCH) {
		console.error(
			`Error: releases are cut from ${RELEASE_BRANCH} (current branch: ${branch}). The tag push publishes whatever the tag points at.`,
		);
		process.exit(1);
	}
	console.log(`  On branch ${branch}`);

	const plannedVersion = previewVersion(args.target);
	const tag = tagNameFor(plannedVersion);
	assertTagAvailable(tag);
	console.log(`  Tag ${tag} is available\n`);

	const version = bumpOrSetVersion(args.target);
	if (version !== plannedVersion) {
		console.error(`Error: expected version ${plannedVersion} after bump, found ${version}.`);
		process.exit(1);
	}
	console.log(`  New version: ${version}\n`);

	console.log("Updating CHANGELOG.md files...");
	updateChangelogsForRelease(version, false);
	console.log();

	console.log("Committing and tagging...");
	stageChangedFiles();
	run(`git commit -m "Release v${version}"`);
	// Plain lightweight tag on the bump commit: this is what release.yml matches (v*.*.*).
	run(`git tag ${tag}`);
	console.log();

	if (args.npmPublish) {
		console.log("Publishing to npm (opted in)...");
		run("npm run publish");
	} else {
		console.log(
			`Skipping npm registry publish: distribution channel is GitHub Pages via ${RELEASE_WORKFLOW} ` +
				`(opt in with ${NPM_PUBLISH_FLAG} or ${NPM_PUBLISH_ENV}=1).`,
		);
	}
	console.log();

	console.log("Pushing to remote...");
	run(`git push origin ${RELEASE_BRANCH}`);
	// Push ONLY this tag (never --tags): the tag push is the release trigger.
	run(`git push origin ${shellQuote(`refs/tags/${tag}`)}`);
	console.log();

	console.log(`=== Released v${version} ===`);
	console.log(`The '${RELEASE_WORKFLOW}' workflow now builds, packs and publishes releases/${tag} to GitHub Pages.`);
	console.log("Follow it under Actions -> Release, then verify latest.json and an isolated `curl | sh` install (docs/release.md).");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
	main();
}
