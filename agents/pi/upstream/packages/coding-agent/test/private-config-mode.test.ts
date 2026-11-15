import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resolveConfigValue, resolveConfigValueUncached, isConfigValueConfigured } from "../src/core/resolve-config-value.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

afterEach(() => vi.unstubAllEnvs());

test("private prompt modes use only agent SYSTEM.md and never append; normal CLI retains discovery", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-private-prompt-"));
	try {
		const agentDir = join(directory, "pi-config"); mkdirSync(agentDir);
		mkdirSync(join(directory, ".pi"));
		writeFileSync(join(agentDir, "SYSTEM.md"), "private replacement");
		writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "private append");
		writeFileSync(join(directory, ".pi", "SYSTEM.md"), "workspace replacement");
		writeFileSync(join(directory, ".pi", "APPEND_SYSTEM.md"), "workspace append");
		const settingsManager = SettingsManager.create(directory, agentDir, { projectTrusted: true });
		vi.stubEnv("PI_ADAPTOR_CONFIG_ONLY", "1");
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
			systemPrompt: "explicit replacement", appendSystemPrompt: "explicit append" });
		await loader.reload();
		expect(loader.getSystemPrompt()).toBe("private replacement");
		expect(loader.getAppendSystemPrompt()).toEqual([]);
		rmSync(join(agentDir, "SYSTEM.md"));
		await loader.reload();
		expect(loader.getSystemPrompt()).toBeUndefined();
		expect(loader.getAppendSystemPrompt()).toEqual([]);
		vi.stubEnv("PI_ADAPTOR_CONFIG_ONLY", "");
		const normal = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager });
		await normal.reload();
		expect(normal.getSystemPrompt()).toBe("workspace replacement");
		expect(normal.getAppendSystemPrompt()).toEqual(["workspace append"]);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("private config mode rejects ambient keys/cloud profiles and accepts stored API keys and OAuth", async () => {
	vi.stubEnv("PI_ADAPTOR_CONFIG_ONLY", "1");
	vi.stubEnv("DEEPSEEK_API_KEY", "host-deepseek-key");
	vi.stubEnv("AWS_PROFILE", "host-profile");
	vi.stubEnv("GOOGLE_CLOUD_API_KEY", "host-google-key");
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({
		"amazon-bedrock": { type: "api_key", env: { AWS_PROFILE: "host-profile" } },
	}), modelsPath: null });
	expect(await runtime.getAuth("deepseek")).toBeUndefined();
	expect(await runtime.getAuth("amazon-bedrock")).toBeUndefined();
	expect(await runtime.getAuth("google-vertex")).toBeUndefined();
	const privateRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({
		deepseek: { type: "api_key", key: "agent-key" },
		anthropic: { type: "oauth", access: "agent-oauth", refresh: "agent-refresh", expires: Date.now() + 3600000 },
	}), modelsPath: null });
	expect((await privateRuntime.getAuth("deepseek"))?.auth.apiKey).toBe("agent-key");
	expect((await privateRuntime.getAuth("anthropic"))?.auth.apiKey).toBe("agent-oauth");
	vi.stubEnv("PI_ADAPTOR_CONFIG_ONLY", "");
	const normal = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	expect((await normal.getAuth("deepseek"))?.auth.apiKey).toBe("host-deepseek-key");
});

test("private config references use only stored env and cannot execute credential commands", () => {
	vi.stubEnv("PI_ADAPTOR_CONFIG_ONLY", "1");
	vi.stubEnv("DEEPSEEK_API_KEY", "host-key");
	expect(resolveConfigValue("$DEEPSEEK_API_KEY")).toBeUndefined();
	expect(isConfigValueConfigured("$DEEPSEEK_API_KEY")).toBe(false);
	expect(resolveConfigValue("$LOCAL_KEY", { LOCAL_KEY: "stored-key" })).toBe("stored-key");
	const directory = mkdtempSync(join(tmpdir(), "pi-private-command-"));
	try {
		const proof = join(directory, "unexpected");
		const command = `!touch '${proof}'`;
		expect(isConfigValueConfigured(command)).toBe(false);
		expect(resolveConfigValue(command)).toBeUndefined();
		expect(resolveConfigValueUncached(command)).toBeUndefined();
		expect(existsSync(proof)).toBe(false);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("models.json command and host-env references do not count as configured authentication", async () => {
	vi.stubEnv("PI_ADAPTOR_CONFIG_ONLY", "1");
	vi.stubEnv("DEEPSEEK_API_KEY", "host-key");
	const directory = mkdtempSync(join(tmpdir(), "pi-private-models-"));
	try {
		const path = join(directory, "models.json");
		for (const key of ["$DEEPSEEK_API_KEY", "!printf forbidden", ""]) {
			writeFileSync(path, JSON.stringify({ providers: { deepseek: { apiKey: key, baseUrl: "http://127.0.0.1:9" } } }));
			const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: path });
			expect(runtime.hasConfiguredAuth("deepseek")).toBe(false);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("workspace settings cannot replace an instance's private model selection", () => {
	vi.stubEnv("PI_ADAPTOR_CONFIG_ONLY", "1");
	const directory = mkdtempSync(join(tmpdir(), "pi-private-settings-"));
	try {
		const config = join(directory, "pi-config"); mkdirSync(config);
		mkdirSync(join(directory, ".pi"));
		writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultProvider: "agent-provider", defaultModel: "agent-model" }));
		writeFileSync(join(directory, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "host-provider", defaultModel: "host-model" }));
		const settings = SettingsManager.create(directory, config);
		expect(settings.getDefaultProvider()).toBe("agent-provider");
		expect(settings.getDefaultModel()).toBe("agent-model");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
