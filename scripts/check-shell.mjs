#!/usr/bin/env node
// Static-check the shell entry points. shellcheck is optional tooling: when it
// is not installed the gate reports a skip instead of failing, so `npm run
// check` stays runnable on a bare machine while CI (which installs it) enforces.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCRIPTS = ["install.sh", "evopi.sh", "test.sh"];

const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.log("check:shell skipped — shellcheck not installed (apt-get install shellcheck)");
	process.exit(0);
}

let failed = false;
for (const script of SCRIPTS) {
	// Syntax-check with the interpreter the shebang names (install.sh is POSIX sh,
	// the dev launchers are bash); shellcheck reads the shebang on its own.
	const shebang = readFileSync(script, "utf8").split("\n", 1)[0] ?? "";
	const interpreter = /\bbash\b/.test(shebang) ? "bash" : "sh";
	const syntax = spawnSync(interpreter, ["-n", script], { encoding: "utf8" });
	if (syntax.status !== 0) {
		console.error(`${script}: ${interpreter} -n failed\n${syntax.stderr}`);
		failed = true;
		continue;
	}
	const result = spawnSync("shellcheck", ["-S", "warning", "-f", "gcc", script], { encoding: "utf8" });
	if (result.status !== 0) {
		console.error(result.stdout || result.stderr);
		failed = true;
	}
}
if (failed) {
	console.error("check:shell failed.");
	process.exit(1);
}
console.log(`check:shell passed (${SCRIPTS.join(", ")}).`);
