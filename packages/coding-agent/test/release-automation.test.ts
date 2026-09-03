/**
 * Release automation contracts (NEXT-STEPS E2): the tag-push workflow guards,
 * the opt-in npm publish in scripts/release.mjs, and the dry-run comparison
 * script scripts/compare-release-artifacts.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "..", "..", "..");
const releaseWorkflow = join(repoRoot, ".github", "workflows", "release.yml");
const releaseScript = join(repoRoot, "scripts", "release.mjs");
const compareScript = join(repoRoot, "scripts", "compare-release-artifacts.mjs");

function runNode(args: string[], cwd = repoRoot) {
	return spawnSync(process.execPath, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVOPI_RELEASE_NPM_PUBLISH: "" },
	});
}

describe("release.yml (tag path)", () => {
	const yaml = readFileSync(releaseWorkflow, "utf8");

	test("triggers on plain vX.Y.Z tags and exposes a dry_run boolean input", () => {
		expect(yaml).toMatch(/tags:\s*\n\s*- "v\*\.\*\.\*"/);
		expect(yaml).toMatch(/dry_run:[\s\S]*?type: boolean/);
		expect(yaml).toMatch(/if: steps\.meta\.outputs\.dry_run == 'true'[\s\S]*?actions\/upload-artifact@[0-9a-f]{40}/);
		expect(yaml).toMatch(/if: steps\.meta\.outputs\.dry_run != 'true'[\s\S]*?git push origin gh-pages/);
	});

	test("guards: plain semver, tag == package.json, no overwrite, single concurrency group", () => {
		expect(yaml).toContain("grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
		expect(yaml).toContain("node -p \"require('./package.json').version\"");
		expect(yaml).toMatch(/if \[ -e "\$GH_PAGES_DIR\/releases\/v\$\{VERSION\}" \]/);
		expect(yaml).toMatch(/concurrency:\s*\n\s*group: release-pages\s*\n\s*cancel-in-progress: false/);
	});

	test("publishes only the stable channel to GitHub Pages: no npm publish, no beta, no force push", () => {
		expect(yaml).toContain("EVOPI_RELEASE_CHANNEL: stable");
		expect(yaml).not.toMatch(/npm publish/);
		expect(yaml).not.toMatch(/gh release/);
		expect(yaml).not.toMatch(/beta/);
		expect(yaml).not.toMatch(/push\s+(-f|--force)/);
		expect(yaml).not.toMatch(/--tags/);
	});

	test("the upstream build-binaries workflow is gone (it also fired on v* tags)", () => {
		expect(existsSync(join(repoRoot, ".github", "workflows", "build-binaries.yml"))).toBe(false);
	});
});

describe("scripts/release.mjs", () => {
	// Dynamic import of a computed URL keeps TypeScript from needing a .d.ts for the .mjs.
	let mod: {
		npmPublishRequested: (argv: string[], env?: Record<string, string | undefined>) => boolean;
		parseReleaseArgs: (
			argv: string[],
			env?: Record<string, string | undefined>,
		) => {
			target?: string;
			dryRun: boolean;
			npmPublish: boolean;
			unknownFlags: string[];
			extraPositionals: string[];
		};
		isValidReleaseTarget: (target: unknown) => boolean;
		tagNameFor: (version: string) => string;
		NPM_PUBLISH_ENV: string;
		NPM_PUBLISH_FLAG: string;
	};

	beforeAll(async () => {
		mod = await import(pathToFileURL(releaseScript).href);
	});

	test("npm publish is opt-in: default off, enabled by --npm-publish or EVOPI_RELEASE_NPM_PUBLISH=1", () => {
		expect(mod.NPM_PUBLISH_ENV).toBe("EVOPI_RELEASE_NPM_PUBLISH");
		expect(mod.NPM_PUBLISH_FLAG).toBe("--npm-publish");
		expect(mod.npmPublishRequested(["patch"], {})).toBe(false);
		expect(mod.npmPublishRequested(["patch"], { EVOPI_RELEASE_NPM_PUBLISH: "" })).toBe(false);
		expect(mod.npmPublishRequested(["patch"], { EVOPI_RELEASE_NPM_PUBLISH: "0" })).toBe(false);
		expect(mod.npmPublishRequested(["patch"], { EVOPI_RELEASE_NPM_PUBLISH: "1" })).toBe(true);
		expect(mod.npmPublishRequested(["patch"], { EVOPI_RELEASE_NPM_PUBLISH: "true" })).toBe(true);
		expect(mod.npmPublishRequested(["patch", "--npm-publish"], {})).toBe(true);
	});

	test("parses target + known flags and reports unknown flags", () => {
		expect(mod.parseReleaseArgs(["patch", "--dry-run"], {})).toMatchObject({
			target: "patch",
			dryRun: true,
			npmPublish: false,
			unknownFlags: [],
			extraPositionals: [],
		});
		expect(mod.parseReleaseArgs(["1.2.3", "--npm-publsh"], {}).unknownFlags).toEqual(["--npm-publsh"]);
		expect(mod.isValidReleaseTarget("minor")).toBe(true);
		expect(mod.isValidReleaseTarget("1.2.3")).toBe(true);
		expect(mod.isValidReleaseTarget("1.2.3-rc.1")).toBe(false);
		expect(mod.isValidReleaseTarget(undefined)).toBe(false);
		expect(mod.tagNameFor("0.11.1")).toBe("v0.11.1");
	});

	test("CLI: no target or an unknown flag exits 1 with usage, before touching git", () => {
		const noArgs = runNode([releaseScript]);
		expect(noArgs.status).toBe(1);
		expect(noArgs.stderr).toContain("Usage: node scripts/release.mjs");

		const typo = runNode([releaseScript, "patch", "--npm-publsh"]);
		expect(typo.status).toBe(1);
		expect(typo.stderr).toContain("Unknown flag(s): --npm-publsh");
	});

	test("source pushes only the release tag (never --tags) and keeps npm publish behind the opt-in", () => {
		const source = readFileSync(releaseScript, "utf8");
		expect(source).toMatch(/run\(`git push origin \$\{shellQuote\(`refs\/tags\/\$\{tag\}`\)\}`\);/);
		expect(source).not.toMatch(/push[^\n]*--tags/);
		expect(source).toMatch(/if \(args\.npmPublish\) \{\s*\n[^\n]*\n\s*run\("npm run publish"\);/);
	});
});

describe("scripts/compare-release-artifacts.mjs", () => {
	let work: string;
	const version = "9.9.9";

	function tarball(dir: string, name: string, files: Record<string, string>, format: "gnu" | "posix" = "gnu") {
		const stage = join(dir, `${name}-stage`);
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(stage, "package", path, ".."), { recursive: true });
			writeFileSync(join(stage, "package", path), content);
		}
		const result = spawnSync(
			"tar",
			[
				`--format=${format}`,
				"--owner=0",
				"--group=0",
				"--numeric-owner",
				"--mtime=1985-10-26",
				"-czf",
				join(dir, name),
				"-C",
				stage,
				"package",
			],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) throw new Error(result.stderr);
		rmSync(stage, { recursive: true, force: true });
	}

	function writeSums(dir: string, files: string[]) {
		const lines = files.sort().map((file) => {
			const hash = spawnSync("sha256sum", [join(dir, file)], { encoding: "utf8" }).stdout.split(/\s+/)[0];
			return `${hash}  ${file}`;
		});
		writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
	}

	const longPath = `dist/${"deeply-nested-directory-name/".repeat(4)}a-file-name-that-exceeds-one-hundred-characters.js`;

	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), "evopi-compare-"));
		// "published": pack artifacts layout (SHA256SUMS at the top level).
		const published = join(work, "published");
		mkdirSync(published, { recursive: true });
		tarball(published, "evopi-same-9.9.9.tgz", {
			"package.json": '{"name":"same","version":"9.9.9"}\n',
			"dist/a.js": "a\n",
		});
		tarball(
			published,
			"evopi-diff-9.9.9.tgz",
			{
				"package.json": '{"name":"diff","version":"9.9.9","dependencies":{"x":"1.0.0"}}\n',
				"dist/bundle/cli.js": "import './chunk-AAA.js'\n",
				"dist/bundle/chunk-AAA.js": "old\n",
				[longPath]: "long\n",
			},
			"posix",
		);
		tarball(published, "evopi-missing-9.9.9.tgz", { "package.json": "{}\n" });
		writeSums(published, ["evopi-same-9.9.9.tgz", "evopi-diff-9.9.9.tgz", "evopi-missing-9.9.9.tgz"]);

		// "local": dry-run site layout (releases/v<version>/SHA256SUMS).
		const local = join(work, "site", "releases", `v${version}`);
		mkdirSync(local, { recursive: true });
		tarball(local, "evopi-same-9.9.9.tgz", {
			"package.json": '{"name":"same","version":"9.9.9"}\n',
			"dist/a.js": "a\n",
		});
		tarball(local, "evopi-diff-9.9.9.tgz", {
			"package.json": '{"name":"diff","version":"9.9.9","dependencies":{"x":"2.0.0"}}\n',
			"dist/bundle/cli.js": "import './chunk-BBB.js'\n",
			"dist/bundle/chunk-BBB.js": "new\n",
			[longPath]: "long\n",
		});
		tarball(local, "evopi-extra-9.9.9.tgz", { "package.json": "{}\n" });
		writeSums(local, ["evopi-same-9.9.9.tgz", "evopi-diff-9.9.9.tgz", "evopi-extra-9.9.9.tgz"]);
	});

	afterAll(() => {
		rmSync(work, { recursive: true, force: true });
	});

	test("reports MATCH / MISMATCH (with content + package.json diff) / MISSING / EXTRA and exits 1", () => {
		const result = runNode([
			compareScript,
			join(work, "site"),
			`v${version}`,
			"--published-dir",
			join(work, "published"),
		]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(1);
		const out = result.stdout;
		expect(out).toMatch(/^MATCH\s+evopi-same-9\.9\.9\.tgz\s+[0-9a-f]{64}$/m);
		expect(out).toMatch(/^MISMATCH\s+evopi-diff-9\.9\.9\.tgz/m);
		expect(out).toMatch(/^MISSING\s+evopi-missing-9\.9\.9\.tgz/m);
		expect(out).toMatch(/^EXTRA\s+evopi-extra-9\.9\.9\.tgz/m);
		// Content diff: long (>100 char) paths are read from both GNU 'L' and pax 'x' headers.
		expect(out).toContain("content: 1 identical, 2 changed, 1 only-local, 1 only-published");
		expect(out).toMatch(/changed\s+package\/dist\/bundle\/cli\.js/);
		expect(out).toMatch(/changed\s+package\/package\.json/);
		expect(out).toMatch(/only-local\s+package\/dist\/bundle\/chunk-BBB\.js/);
		expect(out).toMatch(/only-published\s+package\/dist\/bundle\/chunk-AAA\.js/);
		expect(out).not.toContain(longPath.slice(0, 30)); // identical long path is not listed as a difference
		expect(out).toContain('dependencies.x: "2.0.0" -> published "1.0.0"');
		expect(out).toContain("Summary: 1 match, 1 mismatch, 1 missing, 1 extra");
	});

	test("hints at the bundle build id when every difference is under dist/bundle/", () => {
		const published = join(work, "bundle-published");
		const local = join(work, "bundle-local");
		mkdirSync(published, { recursive: true });
		mkdirSync(local, { recursive: true });
		tarball(published, "evopi-9.9.9.tgz", { "package.json": "{}\n", "dist/bundle/cli.js": "a\n" });
		tarball(local, "evopi-9.9.9.tgz", { "package.json": "{}\n", "dist/bundle/cli.js": "b\n" });
		writeSums(published, ["evopi-9.9.9.tgz"]);
		writeSums(local, ["evopi-9.9.9.tgz"]);
		const result = runNode([compareScript, local, version, "--published-dir", published]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("__PI_BUILD_ID__");
		expect(result.stdout).toContain("package.json: identical");
	});

	test("all tarballs identical exits 0; --no-content skips the entry diff; a stale local SHA256SUMS is flagged", () => {
		const published = join(work, "published");
		const same = runNode([compareScript, published, version, "--published-dir", published]);
		expect(same.status).toBe(0);
		expect(same.stdout).toContain("Summary: 3 match, 0 mismatch, 0 missing, 0 extra");

		const noContent = runNode([
			compareScript,
			join(work, "site"),
			version,
			"--published-dir",
			published,
			"--no-content",
		]);
		expect(noContent.status).toBe(1);
		expect(noContent.stdout).not.toContain("content:");

		const stale = join(work, "stale");
		mkdirSync(stale, { recursive: true });
		tarball(stale, "evopi-same-9.9.9.tgz", {
			"package.json": '{"name":"same","version":"9.9.9"}\n',
			"dist/a.js": "a\n",
		});
		writeFileSync(join(stale, "SHA256SUMS"), `${"0".repeat(64)}  evopi-same-9.9.9.tgz\n`);
		const staleResult = runNode([compareScript, stale, version, "--published-dir", published]);
		expect(staleResult.stdout).toMatch(/^STALE\s+evopi-same-9\.9\.9\.tgz/m);
		expect(staleResult.status).toBe(1);
	});

	test("usage and I/O errors exit 2", () => {
		expect(runNode([compareScript]).status).toBe(2);
		expect(runNode([compareScript, work, version, "--bogus"]).status).toBe(2);
		const noSums = runNode([
			compareScript,
			join(work, "nowhere"),
			version,
			"--published-dir",
			join(work, "published"),
		]);
		expect(noSums.status).toBe(2);
		expect(noSums.stderr).toContain("No SHA256SUMS under");
	});
});
