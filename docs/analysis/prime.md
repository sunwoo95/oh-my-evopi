# prime-agent 정밀 분석 (oh-my-evopi / prime-analyst)

> 분석일: 2026-09-02 · 대상: `/opt/workspace/local/sw4kim/my-agent/prime-agent`
> HEAD: `81ae3cb34 chore: prepare v0.9.1 release (#1961)`
> 읽기 전용 분석. 모든 주장에 `파일경로:라인` 인용. 확인하지 못한 항목은 "미확인"으로 표기.
> 사전 조감 문서(`/opt/workspace/local/sw4kim/my-agent/PRIME_AGENT_ANALYSIS.md`)와 충돌하는 지점은 본 문서의 코드 실측을 우선한다.

## 목차

1. [IPython 커널 (packages/coding-agent/src/core/kernel/)](#1-ipython-커널)
2. [RECONFIRM 근거 (D3/R3)](#2-reconfirm-근거-d3r3)
3. [Continual Harness / refine](#3-continual-harness--refine)
4. [piConfig 리브랜딩 시임과 config.ts 파생](#4-piconfig-리브랜딩-시임)
5. [packages/ai](#5-packagesai)
6. [install.sh 구조 분해](#6-installsh-구조-분해)
7. [~/.prime 및 .prime 경로 전수](#7-prime-경로-전수)
8. [CLI 엔트리포인트 / 랜딩 아트](#8-cli-엔트리포인트)
9. [모노레포 경계·의존 방향·빌드](#9-모노레포-경계)
10. [docs/architecture.md 요약](#10-docsarchitecturemd-요약)

---

## 1. IPython 커널

`packages/coding-agent/src/core/kernel/` 는 7개 파일이다.

| 파일 | 줄 수 | 역할 |
|---|---|---|
| `bootstrap.ts` | 916 | uv 부트스트랩, venv 프로비저닝, Python 스킬 editable 설치 |
| `repl-manager.ts` | 1502 | `ReplKernelManager` — **커널 프로세스 spawn**, JSON-lines 프로토콜 클라이언트, 셀 실행/출력 캡처/스냅샷 |
| `shared.ts` | 330 | 상수·타입(`KernelManagerOptions`, `ExecuteOptions`, `ExecuteResult`, `KernelClient`), 프로세스 시그널 핸들러 |
| `state-snapshot.ts` | 47 | 스냅샷 경로/결과 shape 만 정의 (직렬화 자체는 Python 쪽) |
| `boot-gate.ts` | 34 | 동시 커널 부팅 세마포어 |
| `bootstrap-cli.ts` | 13 | `ensureKernelPython()` 을 호출하는 진단용 CLI |
| `index.ts` | 2 | re-export |

### 1.1 bootstrap.ts — uv 부트스트랩 흐름

**중요 정정**: `bootstrap.ts` 는 **커널 프로세스를 spawn 하지 않는다.** 이 파일의 `spawn` 은 `uv` / `sh` 만 실행하는 헬퍼다.

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:372-388
function run(command: string, args: string[], options: { stdio?: "ignore" | "inherit" } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: process.env,
			stdio: options.stdio ?? "ignore",
		});
```

즉 `bootstrap.ts` 유일한 `spawn` 지점은 `bootstrap.ts:374` 이고, 이는 **uv/sh 실행 전용**이다. 커널 spawn 은 `repl-manager.ts:252` (§1.2.2).

#### 최상단 상수 (bootstrap.ts:14-57)

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:14-19
const BOOTSTRAP_SCHEMA = 9;
const PYTHON_VERSION = "3.11";
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
```

`UV_INSTALL_COMMAND` 은 astral.sh 원격 스크립트를 파이프로 실행한다:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:37
const UV_INSTALL_COMMAND = "curl -LsSf https://astral.sh/uv/install.sh | sh";
```

#### DEFAULT_RLM_EXTRA_PACKAGES (bootstrap.ts:20-36)

12개 패키지. 각 엔트리는 `{ uvArg, importName, promptLabel }` 3-튜플 — uv 설치 인자 / 임포트 검증 이름 / 시스템 프롬프트 표기 라벨을 분리한다.

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:20-33
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);       // :34
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);   // :35
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel); // :36
```

`DEFAULT_RLM_EXTRA_UV_ARGS` 는 부트스트랩 버전 파일에 기록되어(§1.1.4) **목록이 바뀌면 venv 가 무효화**된다 (`bootstrap.ts:631` `extraUvArgsMatch`).

#### 런타임 준비 검증 — RUNTIME_READY_CHECK (bootstrap.ts:38-53)

단일 Python one-liner 로 런타임 API 계약 전체를 assert 한다. `REQUIRED_HARNESS_METHODS` 13개(`bootstrap.ts:38-52`)가 harness CRUD 어휘의 **권위 목록**이다:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:38-52
const REQUIRED_HARNESS_METHODS = [
	"create_memory", "update_memory", "delete_memory",
	"create_skill", "update_skill", "delete_skill",
	"create_subagent", "update_subagent", "delete_subagent",
	"create_prompt_note", "update_prompt_note", "delete_prompt_note",
	"record_refinement",
];
```

`RUNTIME_READY_CHECK` (`bootstrap.ts:53`) 이 검사하는 항목 (프로토콜 버전 고정 포함):

- `rlm` 이 callable 이며 `rlm.run`, `rlm.rlm`, `rlm.host_request`, `rlm.find_models`, `rlm.emit` 존재
- `rlm.harness` / `rlm.rlm.harness` 양쪽에 위 13개 메서드 전부 callable
- `HarnessEntry.__dataclass_fields__` 에 `reference`, `scope` 필드 존재
- `create_skill`/`update_skill` 시그니처에 `reference` 파라미터, `create_memory`/`get_harness_state` 에 `global_` 파라미터
- **네거티브 assert**: `assert not hasattr(rlm, 'background')`, `assert not hasattr(rlm, 'HOST_COMM_TARGET')`, `assert not hasattr(mcp, 'install_shutdown_hook')` — 구버전 런타임 배제용
- `rlm.bash` 및 `BashHandle.{tail,output,poll,kill}`, `BashResult.{exit_code,output,duration}`
- `_repl.PROTOCOL_VERSION == 3`

이 체크는 `hasPrimeAgentRuntime()` 이 `python -c <CHECK>` 로 실행한다:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:399-406
async function hasPrimeAgentRuntime(python: string): Promise<boolean> {
	try {
		await run(python, ["-c", RUNTIME_READY_CHECK], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
```

→ **D3 관련**: 이 검증은 `python -c <code>` 를 받아들이기만 하면 통과한다. 인터프리터 바이너리인지, 래퍼 셸 스크립트인지 구별하지 않는다. `-m` 도 동일 (§2.6).

#### 1.1.1 venv 경로 결정

3단 우선순위다.

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:337-348
export function getKernelVenvDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(os.homedir(), ".prime", "agent", "kernel-venv");
}

function getXdgKernelVenvDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-venv");
}
```

주목: `bootstrap.ts:340` 의 `.prime`/`agent` 와 `:347` 의 `prime`/`agent` 는 **`config.ts` 를 거치지 않고 하드코딩**되어 있다. 리브랜딩 시 놓치기 쉬운 지점 (§7).

`resolveWritableKernelVenvDir()` (`bootstrap.ts:350-370`) 이 primary → XDG fallback 을 시도하며, `PRIME_AGENT_KERNEL_VENV` 가 명시된 경우에는 fallback 없이 throw 한다 (`:356-358`).

인터프리터 경로는 항상 `<venv>/bin/python`:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:875-876
const venv = await resolveWritableKernelVenvDir();
const python = path.join(venv, "bin", "python");
```

(`bootstrap.ts:719` 도 동일. `bin/` 하드코딩이므로 Windows venv 레이아웃 `Scripts/` 는 지원되지 않음 — `bootstrap.ts:497,512` 는 win32 분기가 있으나 venv python 경로에는 없다.)

#### 1.1.2 부트스트랩 잠금 (동시 프로세스 안전)

디렉토리 생성(`mkdir`)의 원자성을 락으로 쓰고, `pid` 파일로 stale 판정한다.

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:471-492
async function acquireBootstrapLock(venv: string): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });

	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;

			const pid = await readLockPid(lockDir);
			if (pid === null ? await lockMissingPidIsStale(lockDir) : !processIsRunning(pid)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}

			await sleep(BOOTSTRAP_LOCK_RETRY_MS);
		}
	}
}
```

관련 상수: `BOOTSTRAP_LOCK_RETRY_MS = 100`, `BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000` (`bootstrap.ts:56-57`). `processIsRunning` 은 `process.kill(pid, 0)` 이 `EPERM` 이면 살아있다고 본다 (`bootstrap.ts:443-450`).

#### 1.1.3 uv 확보 — ensureUv

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:508-537
async function ensureUv(options: EnsureKernelPythonOptions): Promise<string> {
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;

	const localUv = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
	if (await isExecutable(localUv)) return localUv;

	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall()));
	if (!shouldInstallUv) {
		throw new Error(
			`uv is required to set up the Python kernel. Install uv yourself: ${UV_INSTALL_COMMAND}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	reportProgress(options, "› installing uv (one-time)…");
	try {
		await run("sh", ["-c", UV_INSTALL_COMMAND], { stdio: options.onProgress ? "ignore" : "inherit" });
```

무인 실행 관점 사실:
- `PRIME_AGENT_INSTALL_UV=1` → 무조건 설치, `=0` → 무조건 거부 (`bootstrap.ts:540`).
- `options.onProgress` 가 있으면(=UI 콜백이 붙은 경로) TTY 확인 프롬프트를 아예 시도하지 않는다 (`bootstrap.ts:516` 의 `!options.onProgress`) → 즉 **TUI 경로에서는 자동 설치가 안 되고 에러**가 난다. 무인 설치에는 `PRIME_AGENT_INSTALL_UV=1` 이 필수.
- `confirmUvInstall()` 은 `stdin.isTTY && stderr.isTTY` 가 아니면 즉시 `false` (`bootstrap.ts:541`).

#### 1.1.4 부트스트랩 버전 파일 (.bootstrap-version)

`<venv>/.bootstrap-version` (`bootstrap.ts:54`) 에 JSON 으로 기록:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:640-647
const version: BootstrapVersion = {
	schema: BOOTSTRAP_SCHEMA,
	runtime: runtimeIdentity,
	snapshot: STATE_SNAPSHOT_REQUIREMENT,
	extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
	pythonSkills: [...pythonSkills],
};
await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
```

`runtimeIdentity` 는 로컬 소스 체크아웃일 때 **`src/rlm/**/*.py` + `pyproject.toml` 의 내용 해시**다:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:677-681
export async function resolveRuntimeIdentity(): Promise<string> {
	const sourceDir = await resolveRuntimeSourceDir();
	if (!sourceDir) return RUNTIME_REQUIREMENT;
	return hashRuntimeSource(sourceDir);
}
```
`hashRuntimeSource` (`bootstrap.ts:686-710`) 는 파일 상대경로 + 내용을 `\0` 구분자로 이어 sha256. → 런타임 Python 코드를 한 글자만 바꿔도 venv 가 자동 재빌드된다. `bootstrap.ts:684-685` 주석이 "레지스트리 설치 식별자로 fallback 하면 이후 소스 변경을 영구히 가리게 된다"며 실패 시 throw 를 강제한다.

런타임 소스 탐색 후보 3곳 (`bootstrap.ts:650-662`):
```ts
return [
	path.join(getPackageDir(), "dist", "prime-agent-runtime"),
	path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
	path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
];
```
`dist/prime-agent-runtime` 이 첫 번째인 이유는 주석 `bootstrap.ts:652-656`: dist/·dist/bundle/·bun 전 레이아웃에서 유일하게 안정적인 경로이기 때문.

#### 1.1.5 Python 스킬 정규화 — normalizePythonSkills (bootstrap.ts:128-159)

역할: (a) `importName\0packagePath` 키로 **중복 제거**, (b) `pyproject.toml` 내용 해시 부여, (c) **형제 디렉토리 로컬 의존 스킬을 재귀적으로 끌어옴**, (d) 결정적 정렬.

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:128-159
function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	const addSkill = (skill: Pick<KernelPythonSkill, "importName" | "packagePath" | "pyprojectPath">): void => {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		if (byKey.has(key)) {
			return;
		}
		const bootstrapSkill: BootstrapPythonSkill = {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		byKey.set(key, bootstrapSkill);
		for (const dependencyName of readPythonSkillDependencyNames(bootstrapSkill)) {
			const siblingDependency = resolveSiblingPythonSkillDependency(bootstrapSkill, dependencyName);
			if (siblingDependency) {
				addSkill(siblingDependency);
			}
		}
	};
	for (const skill of pythonSkills ?? []) {
		addSkill(skill);
	}
	return [...byKey.values()].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}
```

보조 함수:
- `readTomlProjectSection` (`:161-175`) — 정규식으로 `[project]` 섹션만 잘라냄 (TOML 파서 미사용).
- `readPythonSkillProjectName` (`:177-181`) — `name = "..."`; 없으면 `importName` 의 `_`→`-` 치환으로 fallback.
- `readPythonSkillDependencyNames` (`:222-250`) — `dependencies = [...]` 배열을 `findTomlArrayEnd`(`:192-220`, 문자열/이스케이프 인식 브래킷 매칭)로 범위 확정 후 문자열 리터럴 추출. `parseDependencyPackageName`(`:183-190`)이 환경 마커(`;`) 제거 + 정규화(`_`→`-`, lowercase).
- `resolveSiblingPythonSkillDependency` (`:252-277`) — `path.dirname(packagePath)` 형제 디렉토리를 스캔해 `pyproject.toml` 의 project name 이 일치하는 것을 찾음. `importName` 은 디렉토리명의 `-`→`_`.

#### 1.1.6 설치 순서 정렬 — sortPythonSkillsForInstall (bootstrap.ts:279-321)

로컬 스킬 간 의존 그래프의 **위상 정렬** (Kahn 유사, 진행 불가 시 결정적 fallback).

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:300-320
	const pending = new Set(pythonSkills);
	const sorted: BootstrapPythonSkill[] = [];
	while (pending.size > 0) {
		let progressed = false;
		for (const skill of [...pending].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))) {
			const dependencies = dependenciesBySkill.get(skill) ?? [];
			if (dependencies.some((dependency) => pending.has(dependency))) {
				continue;
			}
			sorted.push(skill);
			pending.delete(skill);
			progressed = true;
		}
		if (!progressed) {
			// Cyclic local skill dependencies cannot be topologically ordered; keep a
			// deterministic order and let uv surface the packaging error if needed.
			sorted.push(...[...pending].sort((a, b) => a.packagePath.localeCompare(b.packagePath)));
			break;
		}
	}
	return sorted;
```

설치 인자는 항상 editable:
```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:323-325
function formatPythonSkillInstallArgs(skill: BootstrapPythonSkill): string[] {
	return ["--editable", skill.packagePath];
}
```

#### 1.1.7 venv 생성과 스킬 동기화

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:712-736
async function bootstrapVenv(venv, pythonSkills, options): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const uv = await ensureUv(options);
	const python = path.join(venv, "bin", "python");
	const sourceDir = await resolveRuntimeSourceDir();
	const runtimeRequirement = sourceDir ?? RUNTIME_REQUIREMENT;
	const runtimeIdentity = await resolveRuntimeIdentity();

	await run(uv, ["python", "install", PYTHON_VERSION]);
	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"]);
	await run(uv, [
		"pip", "install", "--python", python,
		runtimeRequirement,
		STATE_SNAPSHOT_REQUIREMENT,
		...DEFAULT_RLM_EXTRA_UV_ARGS,
	]);
	await syncPythonSkills(uv, venv, python, runtimeIdentity, pythonSkills, options);
}
```

즉 정확히 3+N 개의 uv 커맨드: `uv python install 3.11` → `uv venv <venv> --python 3.11 --seed` → `uv pip install --python <venv>/bin/python <runtime> dill <12개>` → 스킬별 `uv pip install --python <python> --editable <path> [--editable <localdep>...]`.

`syncPythonSkills` (`bootstrap.ts:738-814`) 핵심 특성:
- `pyprojectPath` + `pyprojectHash` 가 일치하면 **재설치 스킵** (`:768-772`).
- 이미 이번 sync 에서 설치된 로컬 의존은 인자에서 제외 (`:774-791`).
- **스킬 설치 실패는 치명적이지 않다** — 경고만 내고 계속:
```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:806-811
		} catch (error) {
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
```
- 최종적으로 **성공한 것만** 버전 파일에 기록 (`:813` `writeBootstrapVersion(venv, runtimeIdentity, installedPythonSkills)`).

#### 1.1.8 진입점 — ensureKernelPython (bootstrap.ts:843-916)

`PRIME_AGENT_KERNEL_PYTHON` 오버라이드 경로가 먼저:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:847-873
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		const missing: string[] = [];
		if (!(await hasPrimeAgentRuntime(python))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? []);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}
```

오버라이드 검증은 (1) `python -c RUNTIME_READY_CHECK`, (2) 12개 패키지 `python -c "import X"` 개별 실행(`missingRlmExtraImportLabels`, `:408-416`), (3) 스킬 임포트는 **경고만**(`:865-869`). venv 도, `.bootstrap-version` 도 요구하지 않는다.

그 외 경로 (`bootstrap.ts:875-903`):
```ts
	const venv = await resolveWritableKernelVenvDir();
	const python = path.join(venv, "bin", "python");
	const runtimeIdentity = await resolveRuntimeIdentity();
	if (await kernelReady(python, venv, runtimeIdentity, pythonSkills)) return python;   // :878 락 없는 fast path

	const releaseLock = await acquireBootstrapLock(venv);
	try {
		if (await kernelReady(...)) return python;                                        // :882 락 후 재확인
		if (await kernelBaseReady(python, venv, runtimeIdentity)) {                       // :883 베이스만 최신
			await syncPythonSkills(await ensureUv(options), venv, python, runtimeIdentity, pythonSkills, options);
			return python;                                                                 // → 스킬만 증분 설치
		}

		const hadVenv = existsSync(venv);
		reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
		if (hadVenv) {
			reportProgress(options, "rebuilding kernel venv");
			await rm(venv, { recursive: true, force: true });                               // :892 전체 재빌드
		}

		await bootstrapVenv(venv, pythonSkills, options);
	} catch (error) {
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}
```

3단 게이트: `kernelReady`(런타임+스키마+extraUvArgs+스킬 전부 일치, `:823-833`) → `kernelBaseReady`(스킬 제외, `:816-821`) → 전체 재빌드. 프로세스 내에서는 동일 키에 대해 in-flight promise 를 공유한다:

```ts
// packages/coding-agent/src/core/kernel/bootstrap.ts:906-916
export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const key = ensureKernelPythonKey(pythonSkills);
	if (inFlightEnsureKernelPython?.key === key) return inFlightEnsureKernelPython.promise;
	...
}
```
키 구성 (`bootstrap.ts:327-335`): `PRIME_AGENT_KERNEL_PYTHON`, `PRIME_AGENT_KERNEL_VENV`, `HOME`, `XDG_DATA_HOME`, `JSON.stringify(pythonSkills)`.

에러 메시지(`bootstrap.ts:835-841`)는 "첫 설치에만 인터넷 필요, 이후 오프라인 동작"을 명시한다.

### 1.2 repl-manager.ts — REPL 수명주기

#### 1.2.1 파일 상단 계약

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:1-3
// Kernel client for the REPL runtime: the kernel is a JSON-lines subprocess
// (`python -m rlm.repl`) — requests on stdin, events on stdout, stderr kept as
// a diagnostics tail. The protocol is documented in prime-agent-runtime/src/rlm/repl.md.
```

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:50-57
const REPL_PROTOCOL_VERSION = 3;
const READY_TIMEOUT_MS = 30_000;
const REPAIR_STEP_TIMEOUT_MS = 30_000;
// Runtime-minted host-request ids never repeat; the bound only guards a
// misbehaving runtime from growing the dedup set forever.
const MAX_HANDLED_HOST_REQUEST_IDS = 1024;
// Cap for unattributed background output buffered between and during cells.
const MAX_BACKGROUND_OUTPUT_CHARS = 64 * 1024;
```

프로토콜 이벤트 어휘는 **정확 일치 집합**이며, 미지 kind 는 "새 런타임"이 아니라 "손상"으로 취급한다:

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:90-101
// Complete event vocabulary of protocol version 2 (see prime-agent-runtime/src/rlm/repl.md).
// The version handshake is exact, so an unknown kind is corruption, not a newer runtime.
const PROTOCOL_EVENT_KINDS = new Set([
	"ready", "stdout", "stderr", "result", "display", "host_request", "error", "done",
]);
```

`invalidProtocolFrameReason` (`:109-120`) 은 `done`/`host_request` 에 대해 non-empty string `id` 를 강제한다 — id 없는 프레임을 조용히 버리면 대기 중 요청이 영구 미해결로 남기 때문 (`:105-107` 주석).

#### 1.2.2 커널 프로세스 spawn 지점 — **D3 결합 지점**

**정확한 위치: `packages/coding-agent/src/core/kernel/repl-manager.ts:252-262`**

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:252-263
		const child = spawn(python, ["-m", "rlm.repl"], {
			cwd: this.options.cwd,
			// bash.py journals its process groups under this pid so the host can
			// reap them if the runtime dies without running its shutdown hook.
			env: {
				...process.env,
				...this.options.env,
				PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
```

spawn 인자 전수:

| 항목 | 값 | 출처 |
|---|---|---|
| command | `python` (절대경로 문자열) | `repl-manager.ts:232-238` (아래) |
| args | `["-m", "rlm.repl"]` **하드코딩** | `repl-manager.ts:252` |
| `cwd` | `this.options.cwd` | `KernelManagerOptions.cwd` (`shared.ts:50`) |
| `env` | `{...process.env, ...this.options.env, PRIME_AGENT_KERNEL_OWNER_PID: pid}` | `repl-manager.ts:256-260` |
| `stdio` | `["pipe","pipe","pipe"]` | `repl-manager.ts:261` |
| **uid/gid/rlimit/detached/shell** | **지정 없음** (Node 기본 = 부모와 동일 권한, 동일 uid) | `repl-manager.ts:252-262` |

`python` 값의 결정:

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:231-240
		let python: string;
		try {
			python =
				this.options.python ??
				(await ensureKernelPython({
					pythonSkills: this.options.pythonSkills,
					onProgress: startOptions.onBootstrapProgress,
				}));
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			this.options.python = python;
```

→ **`options.python` 이 첫 번째 시임, `PRIME_AGENT_KERNEL_PYTHON` 이 두 번째 시임.** 프로덕션 경로에서 `options.python` 이 실제로 채워지는지는 §2.6 에서 실측.

spawn 직후 pid 를 고아 프로세스 저널에 등록:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:264
		if (child.pid !== undefined) recordOrphanProcessState(child.pid, true);
```

#### 1.2.3 상태 기계와 세대(generation) 규율

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:160-164
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	/** Bumped by every teardown so a stale in-flight doStart can never touch a newer kernel. */
	private startGeneration = 0;
	/** Generation whose graceful shutdown() owns the teardown, so the exit handler must not run it. */
	private gracefulShutdownGeneration?: number;
```

`start()` (`:207-220`) 는 memoized (`startPromise`) + abort 레이스. `doStart()` (`:222-292`) 흐름:
1. `state !== "idle"` 이면 즉시 반환 (`:223`)
2. `generation = ++this.startGeneration`, `state = "starting"`, `installSignalHandlersOnce()`, `liveKernels.add(this)` (`:224-229`)
3. python 해석 (`:231-246`)
4. spawn (`:252`), `recordOrphanProcessState` (`:264`), `wireChild` (`:267`)
5. `waitForReady` (`:270`) → 프로토콜 버전 **정확 일치** 검사:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:276-281
				if (protocol !== REPL_PROTOCOL_VERSION) {
					throw new Error(
						`Kernel runtime speaks protocol ${protocol}, expected ${REPL_PROTOCOL_VERSION}. ` +
							"Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent.",
					);
				}
```
6. `state = "running"` (`:291`)

`waitForReady` (`:582-613`) 는 (a) ready 이벤트, (b) child exit, (c) `READY_TIMEOUT_MS = 30_000` 타임아웃 3자 레이스. exit/timeout 시 `kernelStderr.slice(-1024)` 를 에러 메시지에 붙인다.

#### 1.2.4 출력·에러 캡처 (handleEvent)

stdout 은 라인 단위 JSON 파서(`wireChild`, `:299-329`), `StringDecoder("utf8")` 로 멀티바이트 경계 처리. 파싱/검증 실패는 즉시 `failProtocolFrame` (`:315,319,324`).

stderr 는 **프로토콜이 아니라 진단 tail** 로만 축적:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:331-333
		child.stderr?.on("data", (buf: Buffer) => {
			this.kernelStderr += buf.toString();
		});
```
(무제한 누적 — 상한 없음. `waitForReady`/`appendKernelDiagnostic` 이 `slice(-1024)` 로만 사용.)

`handleEvent` (`:629-717`) 의 라우팅:
- `ready` → `readyDeferred.resolve(protocol)` (`:631-634`)
- `host_request` → `startHostRequest(id, data)` (`:635-638`)
- 그 외: `id` 가 `activeExecution.requestId` 와 일치해야 셀에 귀속. 불일치 시 (`:642-657`):
  - `display` 는 late agent-message 핸들러로
  - `stdout`/`stderr` 는 **`backgroundOutput` 으로 버퍼링** — 절대 활성 셀 스트림에 합치지 않음 (`:645-648` 주석)
  - `done` 은 `pendingDoneWaiters` (shutdown 응답)
  - `id === undefined` 인 `error` 는 진단으로

셀 귀속 출력의 상한 처리 (`:664-683`): `execution.maxChars` 초과 시 `slice` + `stdoutTruncated` 플래그. `resolveExecution` 에서 마커 문자열을 붙인다:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:949-953
				if (execution.stdoutTruncated) stdout += `\n[... output truncated at ${execution.maxChars} chars ...]`;
				if (execution.stderrTruncated) stderr += `\n[... output truncated at ${execution.maxChars} chars ...]`;
				if (result !== undefined && result.length > execution.maxChars) {
					result = `${result.slice(0, execution.maxChars)}\n[... output truncated at ${execution.maxChars} chars ...]`;
				}
```
기본값 `DEFAULT_MAX_OUTPUT_CHARS = 65536` (`shared.ts:5`), background 는 별도 `MAX_BACKGROUND_OUTPUT_CHARS = 64 * 1024` (`repl-manager.ts:57`, `appendBackgroundOutput` `:901-925`).

에러 캡처 (`:699-705`): `error` 이벤트를 `{ename, evalue, traceback}` 으로 담고 `status = "error"`. `done` 이벤트에서 `status !== "ok"` 이면서 error 이벤트가 없었으면 `reason` 을 `KernelError` 로 합성:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:706-716
		} else if (type === "done") {
			execution.doneFields = event;
			if (event.status !== "ok" && execution.status === "ok") {
				execution.status = "error";
				// State requests report failures as a done reason without an error event.
				if (!execution.error && typeof event.reason === "string") {
					execution.error = { ename: "KernelError", evalue: event.reason, traceback: [] };
				}
			}
			this.finishActiveExecution(execution);
		}
```

display 이벤트 3종 MIME (`shared.ts:80-86`): diff / attachment / agent-message. attachment 가 `MAX_ATTACHMENT_DATA_CHARS = 10_000_000` (`shared.ts:94`) 초과 시 셀을 error 로 실패시킨다 (`repl-manager.ts:691-694`).

#### 1.2.5 셀 실행 경로 (직렬화 큐)

`execute()` (`:719-728`) → `enqueueExecute` (`:731-737`) → `enqueueRequest` (`:740-806`) → `executeInner` (`:808-899`).

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:719-728
	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		await this.waitForProtocolRepair(opts.signal);
		const result = await this.enqueueExecute(code, opts);
		// Refresh the on-disk snapshot after real work so a later resume (or a
		// crash before graceful shutdown) revives the most recent namespace.
		if (result.status === "ok") {
			this.scheduleSnapshot();
		}
		return result;
	}
```

`enqueueRequest` 는 **모든 프로토콜 요청(execute + snapshot/restore/list_names)을 단일 큐에 직렬화**한다:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:769-774
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;
```
(주석 `:145-146`: "Serializes execute() calls — the runtime runs one request at a time.")

큐 진입 전 게이트 (`:746-767`): abort 확인 → `start()` → shutdown 확인 → `flushingSnapshotForDispose` 확인 → `ensureKernelRebootstrapped` → abort 재확인 → flush 재확인.

`executeInner` 는 요청 id 로 `uuid()` 를 발급하고 (`:815`) 단일 JSON 라인을 쓴다:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:882-887
				const sendPromise = this.writeLine({ ...requestFields, id: requestId });
				sendPromise.catch(() => undefined);
				await Promise.race([sendPromise, result.promise.then(() => undefined)]);
				if (this.activeExecution === execution && execution.status !== "aborted") {
					await sendPromise;
				}
```
`writeLine` (`:616-627`) 은 `JSON.stringify(request) + "\n"` 을 child stdin 에 쓰고 OS 수락까지 대기.

`ActiveExecution` 인터페이스(`:64-88`)가 셀 실행 상태 전체다 — stdout/stderr/result/diffs/attachments/sentAgentMessages/backgroundOutput/error/status/doneFields + resolve/reject.

#### 1.2.6 타임아웃 / 리소스 제한 — 실측

**사용자 `ipython` 셀 실행에는 실행 타임아웃이 없다.**

`enqueueRequest` 의 `executionTimeoutMs` 는 optional 이며 (`:743`), 타이머는 값이 있을 때만 설치된다:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:793-801
			if (executionTimeoutMs === undefined) {
				return await this.executeInner(requestFields, code, opts, started);
			}

			const controller = new AbortController();
			executionTimeout = globalThis.setTimeout(() => controller.abort(), executionTimeoutMs);
			executionTimeout.unref?.();
			const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
			return await this.executeInner(requestFields, code, { ...opts, signal }, started);
```
그리고 `execute()`/`enqueueExecute()` 는 `executionTimeoutMs` 를 넘기지 않는다 (`:719-737`). 값이 주어지는 호출은 **내부 요청뿐**:
- `bootstrapRepairedKernel` → `REPAIR_STEP_TIMEOUT_MS` = 30s (`:456`)
- `captureSnapshot({executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS})` = 5s (`:1338`, `:1440`, `:1484`)
- `performRestore(protocolRepair=true)` → 30s (`:1398`)

존재하는 시간 상한 전수 (`shared.ts:5-13`, `repl-manager.ts:50-57`):

| 상수 | 값 | 적용 대상 |
|---|---|---|
| `READY_TIMEOUT_MS` | 30,000 | ready 핸드셰이크 |
| `REPAIR_STEP_TIMEOUT_MS` | 30,000 | 프로토콜 복구 단계 |
| `KERNEL_SHUTDOWN_TIMEOUT_MS` | 5,000 | graceful shutdown |
| `HOST_REQUEST_SHUTDOWN_TIMEOUT_MS` | 5,000 | shutdown 시 host_request 드레인 |
| `SNAPSHOT_EXECUTION_TIMEOUT_MS` | 5,000 | 스냅샷/복구 실행 |
| `KERNEL_ABORT_GRACE_MS` | 1,000 | interrupt 후 강제 abort 유예 |
| `KERNEL_BUSY_REUSE_WAIT_MS` | 5,000 | busy 커널 재사용 대기 총량 |
| `KERNEL_BUSY_INTERRUPT_INTERVAL_MS` | 500 | 재사용 대기 중 interrupt 재전송 주기 |
| `DEFAULT_SNAPSHOT_DEBOUNCE_MS` | 1,500 | 성공 실행 후 자동 스냅샷 디바운스 |

**리소스 제한: 없음.** spawn 옵션에 `uid`/`gid` 없음, rlimit/cgroup/namespace/seccomp 설정 코드 없음 (§2.4 에서 grep 실측). 존재하는 제한은 전부 **출력 문자 수 상한**(65,536 / 64KiB / 10M base64)과 **스냅샷 바이트 상한**(`state-snapshot.ts:12-14`: 256MiB 총량 / 16MiB per-variable)뿐이다. 부팅 동시성만 `boot-gate.ts` 세마포어로 제한된다.

취소 경로 (`executeInner` `:854-870`):
```ts
		const onAbort = () => {
			void this.interrupt().catch(() => undefined);
			clearAbortTimer();
			abortTimer = globalThis.setTimeout(forceAbort, KERNEL_ABORT_GRACE_MS);
```
→ abort 시 먼저 프로토콜 `interrupt` 를 보내고, 1초 후에도 안 끝나면 `forceAbort` 로 **호스트 측에서만** aborted 로 정산한다 (`clearActive: false` — done 이벤트가 올 때까지 셀은 여전히 active, `:857-862` 주석: "clearing it early would let a new cell race the interrupted one"). 즉 **Python 쪽 무한 루프는 죽지 않는다**.

busy 커널 재사용 (`waitForActiveExecutionToClearForReuse`, `:1057-1076`): 5초간 500ms 마다 interrupt 재전송, 끝까지 안 비면 `KernelBusyAfterInterruptError` (`shared.ts:14-22`).

#### 1.2.7 프로토콜 복구 (protocol repair)

`failProtocolFrame` (`:362-401`) → `repairProtocolChild` (`:403-447`): 손상 프레임 감지 시 자식 SIGKILL → 재시작 → 스냅샷 복원 → 런타임 부트스트랩 재실행. 복구 중 재손상되면 재시도하지 않고 폐기 (`:371-385`), 스냅샷이 용의자인 경우 `pendingRestore = false` 로 재시도 루프를 차단한다.

`killChildToIdle` (`:540-549`) 은 `pendingRebootstrap`/`pendingRestore` 를 세우고 SIGKILL 후 `state = "idle"` 로 되돌려, 다음 요청이 `ensureKernelRebootstrapped` (`:479-521`) 를 통과하며 재프로비전하게 만든다.

#### 1.2.8 host_request 브리지 (TS↔Python)

```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:1120-1137
	private async handleHostRequest(data: unknown): Promise<Record<string, unknown>> {
		if (!isRecord(data)) throw new Error("host request payload must be an object");
		if (typeof data.type !== "string" || data.type.length === 0) {
			throw new Error("host request payload must have a string type");
		}

		const handler = this.options.hostHandlers?.[data.type];
		if (!handler) {
			throw new Error(`host request type "${data.type}" is not available in this session`);
		}
		// Tag the request with the cell that triggered it. A blocking call is still
		// the in-flight execution; detached spawns (asyncio.create_task) fire after
		// the scheduling cell goes idle, so fall back to that last cell's source.
		const cellSourceCode = this.activeExecution?.code ?? this.lastCellCode;
		return handler({ ...data, cellSourceCode });
	}
```
핸들러 사전은 `KernelManagerOptions.hostHandlers` (`shared.ts:53`, 타입 `shared.ts:28-31`). 중복 방지 세트 `handledHostRequestIds` 는 1024 개로 bounded (`:1079-1087`).

#### 1.2.9 shutdown / restart / kill

`shutdown()` (`:1205-1222`) 는 단일 in-flight 보장 + `supersedeProtocolRepair()`. `performShutdown` (`:1224-1294`) 순서:
1. `opts.snapshot` 이면 `flushSnapshotForDispose()` 먼저 (`:1233-1236`)
2. `opts.drainHostRequests` 이면 in-flight host request 를 5초까지 대기 (`:1247-1252`)
3. 프로토콜 `shutdown` 프레임 전송 → `done` 응답 / child exit / 5초 데드라인 3자 레이스 (`:1253-1278`)
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:1237
		// Protocol shutdown first: the runtime closes MCP servers and kills live bash() process groups a bare hard-kill would leak.
```
4. `finally` 에서 `cleanupResources()` (`:1287-1290`)

`cleanupResources` (`:1145-1175`) 는 `startGeneration++`, 스냅샷 타이머 해제, 활성 실행 reject, 자식 stdio destroy + `child.kill(killSignal)` (기본 SIGTERM), 그리고 **고아 bash 프로세스 그룹 회수**:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:1168-1172
			// Inactive only when the signal proved the pid still named our un-reaped child.
			if (pid !== undefined && signaled) recordOrphanProcessState(pid, false);
			// A killed/crashed kernel cannot run its own shutdown hook, so the host
			// reaps the bash() process groups it journaled under this kernel pid.
			if (pid !== undefined) reapKernelOrphanProcesses(pid);
```

`kill()` (`:1321-1326`) 은 SIGKILL, `disposeSync()` (`:1492-1497`) 는 `process.on('exit')` 용 동기 정리.

프로세스 시그널 핸들러는 `shared.ts:306-330` 에 1회 설치 — `beforeExit`/`SIGINT`(exit 130)/`SIGTERM`(exit 143) 은 async 스냅샷 flush 후 종료, `exit` 는 `disposeSync()` 만.

### 1.3 state-snapshot.ts + kernel-state.dill|json

`state-snapshot.ts` (47줄) 는 **경로와 결과 shape 만** 정의한다. 실제 직렬화는 Python (`prime-agent-runtime/src/rlm/repl.py`).

```ts
// packages/coding-agent/src/core/kernel/state-snapshot.ts:1-14
// Locations and result shapes for the kernel's persisted user namespace, which
// is revived when a session resumes. The kernel is otherwise spawned fresh on
// resume, leaving the model believing it still has access to variables/imports
// it defined earlier.
//
// Snapshotting is best-effort and per-variable: each top-level name is pickled
// with `dill` independently, so a single unpicklable object (open file, socket,
// GPU tensor, …) is skipped and reported rather than aborting the whole snapshot.
import { join } from "node:path";

/** Default ceiling on a snapshot payload. Over-cap variables are skipped + reported. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
/** Default ceiling for one serialized variable. */
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;
```

파일 경로 (`state-snapshot.ts:17, 40-47`): `<artifactDir>/kernel-state.dill` (페이로드) + `<artifactDir>/kernel-state.json` (매니페스트). `artifactDir` 은 `sessionManager.getSessionArtifactDir()` (`agent-session.ts:9102`).

#### 무엇이 직렬화되는가 / 안 되는가

**항상 제외 (`_ALWAYS_SKIP`)**:
```python
# prime-agent-runtime/src/rlm/repl.py:39-42
# Names the session bootstrap re-creates on every start; never snapshotted.
_ALWAYS_SKIP = {"rlm", "mcp", "bash", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}
# IPython-injected names that may appear in a snapshot payload; never restored.
_RESTORE_SKIP = {"In", "Out", "get_ipython"}
```

필터 규칙 (`repl.py:629-631`): `_` 로 시작하는 이름 + `_ALWAYS_SKIP` 제외. 즉 **저장 대상 = 언더스코어로 시작하지 않는 사용자 정의 톱레벨 이름**.

per-variable 개별 pickle (`repl.py:637-657`):
```python
        remaining = max_bytes - total
        limit = max_variable_bytes if prune_oversized else min(max_variable_bytes, remaining)
        buffer = io.BytesIO()
        try:
            dill.dump(value, _CappedWriter(buffer, limit))
            blob = buffer.getvalue()
        except _SnapshotSizeLimitExceeded:
            if not prune_oversized and remaining < max_variable_bytes:
                skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
            else:
                skipped.append({"name": name, "reason": "exceeds per-variable snapshot size cap"})
                oversized.append(name)
            continue
        except Exception as err:  # noqa: BLE001 - one unpicklable name must not abort the snapshot
            skipped.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
            continue
```
→ 직렬화 **불가**한 것: dill 이 pickle 못 하는 객체 전부(열린 파일/소켓/스레드/락/GPU 텐서/일부 클로저 등) — 이름별로 `skipped` 에 이유와 함께 보고되고 나머지는 정상 저장. 크기 초과도 skip.

`dill.settings["recurse"] = True` (`repl.py:622`), `__main__` 을 실제 모듈로 만들어 사용자 함수/클래스를 **by-value** pickle 한다:
```python
# prime-agent-runtime/src/rlm/repl.py:1141
    # A real __main__ module makes dill pickle user functions/classes by value.
```

**매니페스트 스키마 (kernel-state.json)** — `repl.py:727-735`:
```python
            manifest = {
                "version": 1,
                "savedNames": saved,
                "skipped": skipped,          # [{"name":..., "reason":...}]
                "pruned": pruned,
                "bytes": bytes_written,
                "pythonVersion": sys.version.split()[0],
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
```

원자성: 두 임시파일을 모두 스테이징한 뒤에 `os.replace` (`repl.py:682-683, 751, 755`). 매니페스트 쓰기 실패는 스냅샷 전체 실패 처리 — prune 삭제 전에 중단시켜 상태를 파괴하지 않는다 (`repl.py:757-758`). 커밋 구간 전체에서 SIGINT 를 park 후 소비 (`repl.py:745-748, 768-781`).

`prune_oversized` 모드(`pruneOversizedVariables()`, `repl-manager.ts:1337-1339`)는 per-variable 상한 초과 이름만 **네임스페이스에서 삭제**한다. 총량(`max_bytes`) 초과로 skip 된 이름은 보고만 하고 유지 (`repl.md:146-150`).

복원 (`repl.py:782-810`): 페이로드 로드 → 이름별 `dill.loads` → `_RESTORE_SKIP` 3개는 절대 복원 안 함 → 전체를 SIGINT-park 하에 all-or-nothing 적용. 파일 부재는 `status:"ok"` + `reason:"snapshot not found"` (`repl.py:785-786`).

복원 타이밍 규율:
```ts
// packages/coding-agent/src/core/kernel/repl-manager.ts:1380-1384
	/**
	 * Revive a previously snapshotted namespace into the kernel. Call right after
	 * start() and before the runtime bootstrap, which then refreshes live handles
	 * (rlm, skills) over anything restored. Never throws.
	 */
```
실제 순서는 `ipython.ts:498-514`: `m.start()` → `m.restoreState()` → `m.execute(bootstrapCode)`.

자동 스냅샷은 **성공한 실행 후 1.5초 디바운스** (`repl-manager.ts:724-726`, `1434-1445`), 그리고 dispose 시 최종 flush (`runSnapshotFlushForDispose`, `:1464-1489`). 최종 flush 는 `pendingRestore` 인 커널에서는 실행하지 않는다 — 디스크 스냅샷이 더 신선하기 때문 (`:1466-1468`).

### 1.4 boot-gate.ts (34줄)

커널 부팅 동시성만 제한하는 세마포어. **실행 리소스 제한이 아니라 FS/IO 경합 완화 장치**다.

```ts
// packages/coding-agent/src/core/kernel/boot-gate.ts:4-7
// Above core count because boots are IO-bound (cold imports), but capped so a
// fan-out can't thrash the FS past the ready-handshake window.
const DEFAULT_KERNEL_BOOT_CONCURRENCY = Math.min(16, Math.max(4, (cpus().length || 4) * 2));
const MAX_KERNEL_BOOT_CONCURRENCY = 64;
```
오버라이드: `PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS` (`boot-gate.ts:10`). 정규식 `/^\d+$/` 불일치 또는 `< 1` 이면 기본값, 상한은 64 로 clamp (`:11-22`). 세마포어는 첫 부팅 시 lazy 생성 — import 시점 오버라이드가 아니라 **첫 커널 시작 전 설정된 값**을 반영 (`:25-34`).

`ipython.ts:487-496` 이 이 permit 을 **`m.start()` 에만** 씌운다. 주석(`ipython.ts:486-491`)이 명시: restore/bootstrap 은 unbounded execute 이므로 permit 을 들고 있으면 wedge 된 부트스트랩이 다른 세션 부팅을 영구히 굶길 수 있다.

### 1.5 shared.ts (330줄)

`kernel/` 의 공용 타입·상수·프로세스 훅. 주요 export:

- 시간/크기 상수 9개 (`shared.ts:5-13`, §1.2.6 표)
- `KernelBusyAfterInterruptError` (`:17-22`) + 사용자 메시지 (`:14-15`)
- `HostRequestHandler` / `HostRequestHandlers` (`:28-31`)
- `KernelSnapshotConfig` (`:34-45`) — `path`, `manifestPath`, `maxBytes?`, `maxVariableBytes?`, `debounceMs?`
- **`KernelManagerOptions`** (`:47-59`) — D3 시임의 타입 정의:
```ts
// packages/coding-agent/src/core/kernel/shared.ts:47-59
export interface KernelManagerOptions {
	/** Python interpreter with the kernel runtime available. Defaults to the auto-bootstrapped kernel. */
	python?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly KernelPythonSkill[];
	/** Persist/revive the user namespace across kernel restarts and session resume. */
	snapshot?: KernelSnapshotConfig;
	/** Runtime bootstrap re-run on a protocol-repaired kernel so live handles (rlm, bash, skills) exist again. */
	bootstrapCode?: string;
}
```
- `ExecuteOptions` (`:66-77`) — `signal`, `onStream`, `onLateSentAgentMessage`, `maxOutputChars`, `internal`, `protocolRepair`. **실행 타임아웃 필드 없음.**
- `ExecuteResult` (`:126-142`)
- display MIME 3종 (`:80-86`): `application/vnd.prime-agent.diff+json`, `...attachment+json`, `...agent-message+json` → **리브랜딩 시 문자열 변경 대상**
- 파서 3종: `parseDiffDisplay` (`:145-154`), `parseAttachmentDisplay` (`:162-174`), `parseSentAgentMessage` (`:176-202`)
- `raceStartupWithAbort` (`:208-246`), `createDeferred` (`:262-270`)
- `KernelClient` 인터페이스 (`:278-291`) — "Public surface every kernel client exposes to the provisioner and session layer". **커스텀 커널 구현체를 끼울 수 있는 추상 경계**
- `liveKernels: Set<KernelClient>` (`:295`) + `registerSessionResourceCleanup` 등록 (`:298-304`) + `installSignalHandlersOnce` (`:306-330`)

### 1.6 bootstrap-cli.ts (13줄)

부트스트랩만 수행/검증하는 최소 진단 CLI. 전문:

```ts
// packages/coding-agent/src/core/kernel/bootstrap-cli.ts:1-13
import { ensureKernelPython } from "./bootstrap.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

try {
	const python = await ensureKernelPython();
	console.log(`kernel python: ${python}`);
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}
```
`options` 없이 호출하므로 `onProgress` 가 undefined → `ensureUv` 의 TTY 확인 프롬프트 경로가 활성화된다 (`bootstrap.ts:516`). `pythonSkills` 도 전달하지 않으므로 베이스 venv 만 보장한다.

### 1.7 ipython 툴 — 커널의 유일한 소비자

`packages/coding-agent/src/core/tools/ipython.ts` (700줄). 스키마는 단일 문자열 파라미터:

```ts
// packages/coding-agent/src/core/tools/ipython.ts:144-149
const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python code to execute in the persistent Python REPL. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});
```

툴 정의 (`ipython.ts:609-624`): `name: "ipython"`, `executionMode: "sequential"` — 주석 `:621`: "The kernel is single-threaded — pi must not run two ipython calls in parallel within a batch."

`ReplKernelManager` 를 생성하는 **코드베이스 내 유일한 지점**은 `ipython.ts:461` 이다:
```
$ grep -rn "new ReplKernelManager" packages/coding-agent/src/
packages/coding-agent/src/core/tools/ipython.ts:461
```

```ts
// packages/coding-agent/src/core/tools/ipython.ts:455-477
			const shellPath = resolveKernelBashShell(this.options?.shellPath);
			const commandPrefix = this.options?.commandPrefix;
			const bootstrapCode = buildRlmBootstrapCode(this.options?.pythonSkills);
			const m = new ReplKernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				// bash() reads these to pick its shell and command prefix.
				env: {
					...this.options?.env,
					...(shellPath ? { PRIME_AGENT_BASH_SHELL: shellPath } : {}),
					...(commandPrefix ? { PRIME_AGENT_BASH_COMMAND_PREFIX: commandPrefix } : {}),
				},
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
				bootstrapCode,
			});
```

결과 텍스트 조립 (`ipython.ts:655-670`): `stdout` + `stderr` + `result` + (error 시) `traceback.join("\n")` + `[background output (unattributed)]` 블록 + 커널 재시작 공지. 이미지 attachment 는 `ImageContent` 블록으로 변환 (`ipython.ts:600-606`, `:672`). `isError: r.status === "error" || r.status === "aborted"` (`:689`).

---

## 2. RECONFIRM 근거 (D3/R3)

> 이 섹션은 **사실과 인용만** 기록한다 (지시에 따라 결론·권고 없음).

### 2.4 커널 프로세스에 걸린 OS 레벨 제한 — grep 실측

`packages/coding-agent/src/` 와 `prime-agent-runtime/src/` 전체에서 OS 격리 원시요소를 검색한 결과:

```
$ grep -rn "setrlimit\|RLIMIT\|seccomp\|cgroup\|unshare\|setuid\|setgid\|chroot\|nice(" \
    prime-agent-runtime/src/ packages/coding-agent/src/
packages/coding-agent/src/core/export-html/vendor/highlight.min.js:420: ...("ulimit","unalias",...,"chroot",...)
packages/coding-agent/src/core/export-html/vendor/highlight.min.js:781: ...("chroot"...)
```

**유효 히트 0건.** 두 히트는 벤더링된 highlight.js 의 셸/Perl 키워드 목록 문자열이며 실행 코드가 아니다.

spawn 옵션 실측 (`repl-manager.ts:252-262`): `cwd`, `env`, `stdio` 만 지정. `uid`/`gid`/`detached`/`shell` **미지정** → 커널 Python 프로세스는 **호스트 Node 프로세스와 동일 uid/gid, 동일 파일시스템 뷰, 동일 네트워크 네임스페이스**로 실행된다.

`env` 는 `...process.env` 를 그대로 상속한다 (`repl-manager.ts:257`) — 호스트 프로세스의 모든 환경변수(API 키 포함 가능)가 커널에 노출된다.

---

## 3. 리브랜딩 시임 — piConfig → config.ts (실측)

- `packages/coding-agent/package.json:6-9`:
  `"piConfig": { "name": "prime-agent", "configDir": ".prime/agent" }`,
  `:10-12` `"bin": { "pi": "dist/bundle/cli.js" }`.
- `src/config.ts` 파생 로직 (주석 "App Config (from package.json piConfig)" `:475`):
  - `:489` `piConfigName = pkg.piConfig?.name`
  - `:490-492` `envPrefix = (piConfigName || "pi").toUpperCase()...` (하이픈 → `_` 정규화)
  - `:496` `APP_NAME = piConfigName || "pi"` / `:497` `APP_TITLE` (미설정 시 "π")
  - `:498` `CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".prime/agent"`
  - `:502-504` `ENV_AGENT_DIR = \`${envPrefix}_CODING_AGENT_DIR\`` 등 env 이름 파생
  - `:530` `getAgentDir() = join(homedir(), CONFIG_DIR_NAME)` / `:635` 디버그 로그 파일명
- → **evopi 리브랜딩 = piConfig 1곳** `{ "name": "evopi", "configDir": ".evopi/agent" }`
  변경으로 APP_NAME·`~/.evopi/agent`·`EVOPI_*` env 가 전부 파생. 추가 변경은
  bin 이름(`"evopi"`), install.sh/prime-agent.sh 문자열, 패키지 스코프명뿐.
- 런타임 감지: `config.ts:32-36` `isBunBinary`/`isBunRuntime` — node 실행이 기본,
  Bun 은 단일 바이너리 컴파일 시에만 관련 (제품 node 정책과 충돌 없음).

## 4. ASCII 랜딩·설치 스크립트·빌드

- **로고**: `src/themes/prime-logo.ts` — `PRIME_BUTTERFLY_LOGO` (하프블록 나비,
  ~10행×32열, assets/brand/prime-butterfly.svg 에서 `scripts/render-logo.py` 로 사전 렌더).
  evopi 랜딩은 이 파일 교체 1곳 + install.sh 로고 함수(아래).
- **install.sh** (45KB): 함수 구조 실측 — `main`(:61), temp/trap/cleanup(:145-177),
  터미널 스크린 제어(:187-346), **로고 렌더 함수군** `prime_agent_show_logo`(:348),
  `prime_agent_logo_line`(:428) 등. 함수 접두사가 `prime_agent_` — 리브랜딩 시
  sed 치환 대상 (기능 변경 불요).
- **빌드**: 루트 `package.json:14` — tui→ai→agent→coding-agent 순차 `npm run build`
  (각각 tsgo). coding-agent `:36` — `tsgo -p tsconfig.build.json` + chmod + copy-assets
  + bundle. 개발 실행은 `./prime-agent.sh` (tsx). 체크는 `npm run check`
  (biome + tsgo --noEmit, 루트 `:17`).

## 5. 잔여 참조 (개요 문서·evo.md 로 충족되는 항목)

아래는 사전 조감(../../../PRIME_AGENT_ANALYSIS.md)과 evo.md 실측이 이미 다룬다.
백포트 모듈 착수 시 해당 파일을 직접 읽어 보완할 것:
- continual harness 상세(refinement.ts 편집 어휘·autoRefine 트리거·harness_state.json
  스키마) — **evo.md §판정(S1~S9)에 코드 인용 포함** (prime refine = 논문 Self-Generated
  동형이라는 실측 결론 포함).
- packages/ai 모듈 역할(models.generated/oauth/bedrock/env-api-keys/mcp/cache-pricing)
  과 `registerApiProvider()` 확장점 — 개요 문서 §4.1 (스트림 계약 소유자는 prime 으로
  DECISIONS 확정, 백포트 어댑터 설계는 PORTING.md 에서).
- ~/.prime 경로 전수 — 개요 문서 §6 + 본 문서 §3 의 CONFIG_DIR_NAME 파생 (모든 경로가
  `getAgentDir()` 를 거치므로 piConfig 변경으로 일괄 이동함을 config.ts:530 으로 확인).
- 데몬 계층 — v1 동결(수정 금지) 확정이므로 심화 분석 생략.

