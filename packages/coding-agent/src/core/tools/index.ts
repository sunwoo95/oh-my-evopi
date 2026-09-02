export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createHashlineEditTool,
	createHashlineEditToolDefinition,
	type HashlineEditToolDetails,
	type HashlineEditToolInput,
} from "./hashline-edit.js";
export {
	createIpythonTool,
	createIpythonToolDefinition,
	IpythonKernelProvisioner,
	type IpythonToolDetails,
	type IpythonToolInput,
	type IpythonToolOptions,
} from "./ipython.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

import type { AgentTool } from "@evopi/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { createHashlineEditToolDefinition } from "./hashline-edit.js";
import { createIpythonToolDefinition, type IpythonToolOptions } from "./ipython.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "ipython" | "hashline_edit";

export interface ToolsOptions {
	ipython?: IpythonToolOptions;
}

/**
 * Base tool definitions registered for every session. `ipython` is the only
 * one active by default (see AgentSession's defaultActiveToolNames); the
 * remaining entries stay registered-but-inactive so `--tools` can allowlist
 * them. `hashline_edit` is therefore a `--tools`-gated structural editor.
 */
export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		ipython: createIpythonToolDefinition(cwd, options?.ipython),
		hashline_edit: createHashlineEditToolDefinition(cwd),
	};
}
