#!/usr/bin/env node
// Collects the SELF-EVAL scorecard (docs/eval/SELF-EVAL.md, 최종 스코어카드) as
// JSON so releases can be compared (NEXT-STEPS C2). Node built-ins only. The
// script measures and never mutates the tree: tsgo runs with --noEmit, biome
// without --write, the bundle is sized but not rebuilt.
//
// Usage:
//   node scripts/self-eval.mjs [--skip-tests] [--out <file>] [--write]
//                              [--baseline <file>] [--fail-on-regression]
//
//   --skip-tests          skip the coding-agent vitest run (G2), which takes minutes
//   --out <file>          also write the JSON report to <file>
//   --write               write to eval/self-eval/<version>.json (unless --out given)
//   --baseline <file>     print a markdown comparison table (baseline vs current) to stderr
//   --fail-on-regression  exit 1 when a hard metric regressed: vitest failures increased
//                         vs the baseline, tsgo errors > 0, biome errors > 0, or an
//                         unexpected .omp/.prime literal (F3) exists
//
// The JSON report always goes to stdout; progress lines go to stderr.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const optionValue = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

const SKIP_TESTS = hasFlag("--skip-tests");
const WRITE = hasFlag("--write");
const OUT = optionValue("--out");
const BASELINE = optionValue("--baseline");
const FAIL_ON_REGRESSION = hasFlag("--fail-on-regression");
const STARTUP_RUNS = 5;
const MAX_BUFFER = 256 * 1024 * 1024;

// The three prime interop reads sanctioned by CLAUDE.md (F3 gate).
const F3_SANCTIONED_FILES = new Set([
	"packages/coding-agent/src/core/prime-inference-auth.ts",
	"packages/ai/src/env-api-keys.ts",
	"packages/ai/scripts/generate-models.ts",
]);
const F3_LITERALS = [".omp/", ".prime/"];
const F3_TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".json",
	".md",
	".py",
	".sh",
	".txt",
	".yaml",
	".yml",
]);

const durationsMs = {};

function log(message) {
	process.stderr.write(`[self-eval] ${message}\n`);
}

function formatMs(ms) {
	return `${(ms / 1000).toFixed(1)}s`;
}

function timed(key, fn) {
	const started = performance.now();
	try {
		return fn();
	} finally {
		durationsMs[key] = Math.round(performance.now() - started);
	}
}

function exec(command, commandArgs, options = {}) {
	const started = performance.now();
	const result = spawnSync(command, commandArgs, {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		...options,
		env: { ...process.env, ...(options.env ?? {}) },
	});
	return {
		exit: result.error ? null : result.status,
		signal: result.signal ?? null,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error?.message,
		ms: Math.round(performance.now() - started),
	};
}

/** Prefer the workspace-local binary; fall back to npx so a bare checkout still works. */
function toolCommand(name, toolArgs) {
	const local = join(ROOT, "node_modules", ".bin", name);
	return existsSync(local) ? [local, toolArgs] : ["npx", [name, ...toolArgs]];
}

function stripAnsi(text) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function readText(relativePath) {
	const path = join(ROOT, relativePath);
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Evaluates `30 * 60_000`-style constant expressions (digits, `_`, `*`, `+`, whitespace only). */
function evalArithmetic(expression) {
	const cleaned = expression.replace(/_/g, "").trim();
	if (!/^[\d\s*+]+$/.test(cleaned)) return undefined;
	return cleaned
		.split("+")
		.map((term) =>
			term
				.split("*")
				.map((factor) => Number(factor.trim()))
				.reduce((product, factor) => product * factor, 1),
		)
		.reduce((sum, term) => sum + term, 0);
}

function count(regex, text) {
	return (text.match(regex) ?? []).length;
}

// ---------------------------------------------------------------------------
// G1 — type check + lint
// ---------------------------------------------------------------------------

function runTsgo(project) {
	// tsconfig.build.json files emit into dist/; --noEmit keeps the existing build untouched.
	const [command, commandArgs] = toolCommand("tsgo", ["-p", project, "--noEmit"]);
	const result = exec(command, commandArgs);
	const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
	const summary = output.match(/Found (\d+) errors?/);
	return {
		exit: result.exit,
		errors: summary ? Number(summary[1]) : count(/\berror TS\d+/g, output),
		...(result.error ? { error: result.error } : {}),
	};
}

function collectG1() {
	log("G1 tsgo packages/coding-agent …");
	const codingAgent = timed("G1.tsgo.codingAgent", () => runTsgo("packages/coding-agent/tsconfig.build.json"));
	log(`G1 tsgo packages/ai … (coding-agent: exit ${codingAgent.exit}, ${codingAgent.errors} errors)`);
	const ai = timed("G1.tsgo.ai", () => runTsgo("packages/ai/tsconfig.build.json"));
	log(`G1 biome check . … (ai: exit ${ai.exit}, ${ai.errors} errors)`);
	const biome = timed("G1.biome", () => {
		const [command, commandArgs] = toolCommand("biome", ["check", "."]);
		const result = exec(command, commandArgs);
		const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
		const errors = Number(output.match(/Found (\d+) errors?\./)?.[1] ?? 0);
		const warnings = Number(output.match(/Found (\d+) warnings?\./)?.[1] ?? 0);
		return {
			exit: result.exit,
			errors,
			warnings,
			diagnostics: errors + warnings,
			...(result.error ? { error: result.error } : {}),
		};
	});
	log(`G1 done (biome: exit ${biome.exit}, ${biome.diagnostics} diagnostics)`);
	return { tsgo: { codingAgent, ai }, biome };
}

// ---------------------------------------------------------------------------
// G2 — coding-agent vitest (mirrors the `test:ci` exclude)
// ---------------------------------------------------------------------------

function collectG2() {
	if (SKIP_TESTS) {
		log("G2 vitest skipped (--skip-tests)");
		return { skipped: true };
	}
	log("G2 vitest packages/coding-agent … (this takes minutes)");
	return timed("G2.vitest", () => {
		const tmp = mkdtempSync(join(tmpdir(), "evopi-self-eval-vitest-"));
		const reportFile = join(tmp, "vitest.json");
		try {
			const vitest = join(ROOT, "node_modules", ".bin", "vitest");
			if (!existsSync(vitest)) {
				return { skipped: false, exit: null, error: `missing ${relative(ROOT, vitest)} (run npm ci)` };
			}
			// JSON reporter for the counts; the dot reporter's summary is the only place
			// unhandled errors ("Errors  N errors") are reported.
			const result = exec(
				vitest,
				[
					"run",
					"--reporter=json",
					"--reporter=dot",
					`--outputFile.json=${reportFile}`,
					"--exclude",
					"test/daemon-supervisor-process.test.ts",
				],
				{ cwd: join(ROOT, "packages", "coding-agent") },
			);
			const summary = stripAnsi(`${result.stdout}\n${result.stderr}`);
			const unhandled = Number(summary.match(/\bErrors\s+(\d+) errors?/)?.[1] ?? 0);
			if (!existsSync(reportFile)) {
				return {
					skipped: false,
					exit: result.exit,
					errors: unhandled,
					error: result.error ?? `vitest produced no JSON report (exit ${result.exit})`,
					stderrTail: summary.trim().split("\n").slice(-10).join("\n"),
				};
			}
			const report = JSON.parse(readFileSync(reportFile, "utf8"));
			const testFiles = report.testResults ?? [];
			const failedTestFiles = testFiles.filter((file) => file.status === "failed");
			// Names of failing tests so a stored baseline explains its own fail count.
			const failedTests = failedTestFiles.flatMap((file) =>
				(file.assertionResults ?? [])
					.filter((test) => test.status === "failed")
					.map((test) => `${relative(ROOT, file.name)} > ${test.fullName}`),
			);
			const metrics = {
				skipped: false,
				exit: result.exit,
				total: report.numTotalTests,
				passed: report.numPassedTests,
				failed: report.numFailedTests,
				pending: report.numPendingTests,
				errors: unhandled,
				testFiles: testFiles.length,
				failedTestFiles: failedTestFiles.length,
				success: report.success,
				failedTests: failedTests.slice(0, 20),
			};
			log(`G2 done: ${metrics.passed} pass / ${metrics.failed} fail / ${metrics.errors} errors (exit ${metrics.exit})`);
			for (const name of metrics.failedTests) log(`G2 failed: ${name}`);
			return metrics;
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
}

// ---------------------------------------------------------------------------
// G3 — bundle size (measured, never rebuilt)
// ---------------------------------------------------------------------------

function directoryBytes(dir) {
	let bytes = 0;
	let files = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			const nested = directoryBytes(path);
			bytes += nested.bytes;
			files += nested.files;
		} else if (entry.isFile()) {
			bytes += statSync(path).size;
			files += 1;
		}
	}
	return { bytes, files };
}

function collectG3() {
	return timed("G3.bundle", () => {
		const bundleDir = join(ROOT, "packages", "coding-agent", "dist", "bundle");
		if (!existsSync(bundleDir)) {
			log("G3 bundle missing (packages/coding-agent/dist/bundle)");
			return { status: "missing", bundleBytes: null, cliBytes: null };
		}
		const { bytes, files } = directoryBytes(bundleDir);
		const cli = join(bundleDir, "cli.js");
		const cliBytes = existsSync(cli) ? statSync(cli).size : null;
		log(`G3 bundle ${(bytes / 1024 / 1024).toFixed(1)} MiB in ${files} files, cli.js ${cliBytes ?? "missing"} bytes`);
		return { status: "present", bundleBytes: bytes, bundleFiles: files, cliBytes };
	});
}

// ---------------------------------------------------------------------------
// S1 / S2 / R1 / R2 — source-text metrics
// ---------------------------------------------------------------------------

/** Number of string literals inside `const <name>… = [ … ];`. */
function stringArrayLength(source, name) {
	const match = source.match(new RegExp(`const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
	return match ? count(/"[^"\n]*"/g, match[1]) : null;
}

/** Number of `/…/flags,` entries between `const <name>` and the closing `];`. */
function regexArrayLength(source, name) {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`const ${name}`));
	if (start === -1) return null;
	let total = 0;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line === "];") return total;
		if (line.startsWith("/") && !line.startsWith("//")) total += 1;
	}
	return null;
}

function collectS1() {
	const path = "packages/coding-agent/src/core/kernel/kernel-env.ts";
	const source = readText(path);
	if (source === null) return { status: "missing", file: path };
	return {
		secretEnvNames: stringArrayLength(source, "AGENT_SECRET_ENV_NAMES"),
		secretEnvPrefixes: stringArrayLength(source, "AGENT_SECRET_ENV_PREFIXES"),
		allowlistMode: /allowlist/i.test(source),
	};
}

function collectS2() {
	const path = "packages/coding-agent/src/core/extensions/builtin/permission-gate.ts";
	const source = readText(path);
	if (source === null) return { status: "missing", file: path };
	return {
		dangerousPatterns: regexArrayLength(source, "DANGEROUS_PATTERNS"),
		ipythonShellMarkers: regexArrayLength(source, "IPYTHON_SHELL_MARKERS"),
		protectedPathPatterns: regexArrayLength(source, "PROTECTED_PATH_PATTERNS"),
		mutationMarkers: regexArrayLength(source, "MUTATION_MARKERS"),
	};
}

function constantValue(source, name) {
	const match = source?.match(new RegExp(`${name}\\s*=\\s*([\\d_\\s*+]+);`));
	return match ? evalArithmetic(match[1]) : undefined;
}

function collectR1() {
	const source = readText("packages/coding-agent/src/core/settings-manager.ts");
	let value = constantValue(source, "DEFAULT_KERNEL_CELL_TIMEOUT_MS");
	if (value === undefined && source && /cellTimeoutMs/.test(source) && /30 \* 60/.test(source)) {
		value = 30 * 60 * 1000;
	}
	return { cellTimeoutMsDefault: value ?? "unknown" };
}

function collectR2() {
	const source = readText("packages/coding-agent/src/core/kernel/repl-manager.ts");
	let value = constantValue(source, "MAX_KERNEL_STDERR_CHARS");
	if (value === undefined && source) {
		const match = source.match(/(?:STDERR\w*)\s*=\s*([\d_\s*+]+);/) ?? source.match(/(64 \* 1024)/);
		value = match ? evalArithmetic(match[1]) : undefined;
	}
	return { stderrCapBytes: value ?? "unknown" };
}

// ---------------------------------------------------------------------------
// P1 — startup time of `evopi --version` with an isolated HOME
// ---------------------------------------------------------------------------

function collectP1() {
	return timed("P1.startup", () => {
		const cli = join(ROOT, "packages", "coding-agent", "dist", "bundle", "cli.js");
		if (!existsSync(cli)) {
			log("P1 startup skipped: bundle cli.js missing");
			return { status: "missing", runs: 0 };
		}
		const home = mkdtempSync(join(tmpdir(), "evopi-self-eval-home-"));
		const samples = [];
		let exit = 0;
		let versionOutput = "";
		try {
			for (let run = 0; run < STARTUP_RUNS; run++) {
				const result = exec(process.execPath, [cli, "--version"], {
					env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") },
				});
				samples.push(result.ms);
				if (result.exit !== 0) exit = result.exit;
				versionOutput = versionOutput || `${result.stdout}${result.stderr}`.trim().split("\n")[0];
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
		const sorted = [...samples].sort((a, b) => a - b);
		const metrics = {
			status: "measured",
			runs: samples.length,
			exit,
			minMs: sorted[0],
			medianMs: sorted[Math.floor(sorted.length / 2)],
			maxMs: sorted[sorted.length - 1],
			samplesMs: samples,
			versionOutput,
		};
		log(`P1 startup ${metrics.minMs}/${metrics.medianMs}/${metrics.maxMs} ms (min/median/max, ${samples.length} runs)`);
		return metrics;
	});
}

// ---------------------------------------------------------------------------
// H2 — shell static check (check-shell.mjs, shellcheck optional)
// ---------------------------------------------------------------------------

function collectH2() {
	return timed("H2.shellcheck", () => {
		const result = exec(process.execPath, [join(ROOT, "scripts", "check-shell.mjs")]);
		const output = `${result.stdout}\n${result.stderr}`;
		const available = !/skipped\s+—\s+shellcheck not installed/.test(output);
		const metrics = {
			exit: result.exit,
			shellcheckAvailable: available,
			passed: result.exit === 0 && available,
			...(result.error ? { error: result.error } : {}),
		};
		log(`H2 check:shell exit ${metrics.exit} (shellcheck ${available ? "available" : "not installed"})`);
		return metrics;
	});
}

// ---------------------------------------------------------------------------
// F3 — no `.omp/` / `.prime/` ownership literals in packages/*/src
// ---------------------------------------------------------------------------

function* walkTextFiles(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTextFiles(path);
		} else if (entry.isFile() && F3_TEXT_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
			yield path;
		}
	}
}

function collectF3() {
	return timed("F3.gate", () => {
		const packagesDir = join(ROOT, "packages");
		const files = [];
		for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
			const src = join(packagesDir, pkg.name, "src");
			if (pkg.isDirectory() && existsSync(src)) files.push(...walkTextFiles(src));
		}
		for (const sanctioned of F3_SANCTIONED_FILES) {
			const path = join(ROOT, sanctioned);
			if (existsSync(path) && !files.includes(path)) files.push(path);
		}
		const hits = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, index) => {
				for (const literal of F3_LITERALS) {
					if (line.includes(literal)) {
						hits.push({ file: relative(ROOT, file), line: index + 1, literal });
					}
				}
			});
		}
		const sanctionedHits = hits.filter((hit) => F3_SANCTIONED_FILES.has(hit.file));
		const unexpectedHits = hits.filter((hit) => !F3_SANCTIONED_FILES.has(hit.file));
		log(`F3 ${unexpectedHits.length} unexpected / ${sanctionedHits.length} sanctioned hits in ${files.length} files`);
		return {
			filesScanned: files.length,
			sanctioned: sanctionedHits.length,
			unexpected: unexpectedHits.length,
			unexpectedHits: unexpectedHits.slice(0, 20),
		};
	});
}

// ---------------------------------------------------------------------------
// Report, baseline comparison, regression gate
// ---------------------------------------------------------------------------

function flatten(value, prefix = "", into = {}) {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, nested] of Object.entries(value)) {
			flatten(nested, prefix ? `${prefix}.${key}` : key, into);
		}
	} else if (!Array.isArray(value)) {
		into[prefix] = value;
	}
	return into;
}

function formatCell(value) {
	if (value === undefined) return "—";
	if (value === null) return "null";
	return String(value);
}

function compareWithBaseline(baseline, current) {
	const before = flatten(baseline.metrics ?? {});
	const after = flatten(current.metrics ?? {});
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const lines = [
		`### self-eval: ${baseline.version ?? "?"}@${baseline.commit ?? "?"} → ${current.version}@${current.commit ?? "?"}`,
		"",
		"| metric | baseline | current | delta |",
		"|---|---|---|---|",
	];
	for (const key of keys) {
		if (key.endsWith("samplesMs") || key.endsWith("versionOutput") || key.endsWith("stderrTail")) continue;
		const a = before[key];
		const b = after[key];
		let delta = "";
		if (typeof a === "number" && typeof b === "number") {
			const diff = b - a;
			delta = diff === 0 ? "0" : `${diff > 0 ? "+" : ""}${diff}`;
		} else if (a !== b) {
			delta = "changed";
		}
		lines.push(`| ${key} | ${formatCell(a)} | ${formatCell(b)} | ${delta} |`);
	}
	process.stderr.write(`${lines.join("\n")}\n\n`);
}

function hardRegressions(current, baseline) {
	const problems = [];
	const m = current.metrics;
	for (const [label, result] of Object.entries(m.G1?.tsgo ?? {})) {
		if (typeof result.errors === "number" && result.errors > 0) {
			problems.push(`tsgo ${label}: ${result.errors} errors`);
		}
	}
	if (typeof m.G1?.biome?.errors === "number" && m.G1.biome.errors > 0) {
		problems.push(`biome: ${m.G1.biome.errors} errors`);
	}
	if (typeof m.F3?.unexpected === "number" && m.F3.unexpected > 0) {
		problems.push(`F3: ${m.F3.unexpected} unexpected .omp/.prime literal(s)`);
	}
	const currentFailed = m.G2?.skipped ? undefined : m.G2?.failed;
	const baselineFailed = baseline?.metrics?.G2?.skipped ? undefined : baseline?.metrics?.G2?.failed;
	if (typeof currentFailed === "number" && typeof baselineFailed === "number" && currentFailed > baselineFailed) {
		problems.push(`vitest failures increased: ${baselineFailed} → ${currentFailed}`);
	}
	return problems;
}

function main() {
	const startedAt = performance.now();
	const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const git = exec("git", ["rev-parse", "--short", "HEAD"]);
	const commit = git.exit === 0 ? git.stdout.trim() : null;

	const metrics = {
		G1: collectG1(),
		G2: collectG2(),
		G3: collectG3(),
		S1: collectS1(),
		S2: collectS2(),
		R1: collectR1(),
		R2: collectR2(),
		P1: collectP1(),
		H2: collectH2(),
		F3: collectF3(),
	};
	durationsMs.total = Math.round(performance.now() - startedAt);

	const report = {
		version: rootPackage.version,
		commit,
		timestamp: new Date().toISOString(),
		environment: { node: process.version, platform: process.platform, arch: process.arch },
		metrics,
		durationsMs,
	};
	const json = `${JSON.stringify(report, null, "\t")}\n`;

	const outPath = OUT ?? (WRITE ? join("eval", "self-eval", `${report.version}.json`) : undefined);
	if (outPath) {
		const absolute = resolve(ROOT, outPath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, json);
		const shown = relative(ROOT, absolute);
		log(`wrote ${shown.startsWith("..") ? absolute : shown}`);
	}

	let baseline;
	if (BASELINE) {
		baseline = JSON.parse(readFileSync(resolve(ROOT, BASELINE), "utf8"));
		compareWithBaseline(baseline, report);
	}

	process.stdout.write(json);
	log(`done in ${formatMs(durationsMs.total)}`);

	if (FAIL_ON_REGRESSION) {
		const problems = hardRegressions(report, baseline);
		if (problems.length > 0) {
			log(`hard regression(s):\n  - ${problems.join("\n  - ")}`);
			process.exit(1);
		}
		log("no hard regressions");
	}
}

main();
