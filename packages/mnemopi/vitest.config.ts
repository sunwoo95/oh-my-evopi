import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const nativesLoader = fileURLToPath(new URL("../natives-loader/src/index.ts", import.meta.url));
const mnemopiSrc = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
	resolve: {
		alias: [
			{ find: /^@evopi\/pi-natives-loader$/, replacement: nativesLoader },
			{ find: /^@evopi\/mnemopi$/, replacement: mnemopiSrc },
		],
	},
});
