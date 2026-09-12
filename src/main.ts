import "./style.css";

import {
	createModels,
	createProvider,
	envApiKeyAuth,
	InMemoryCredentialStore,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	AgentHarness,
	createReadTool,
	createWriteTool,
	InMemorySessionRepo,
	type AgentEvent,
	type ExecutionToolContext,
	type Session,
} from "@earendil-works/pi-agent-core";

import { BrowserExecutionEnv } from "./browser-env";
import { fetchUpstreamModels } from "./model-list";
import { browseUrlTool, setBrowseProxy } from "./tools";
import { Ui } from "./ui";

const PROVIDERS = {
	anthropic: anthropicProvider,
	openai: openaiProvider,
	google: googleProvider,
	deepseek: deepseekProvider,
} as const;

type ProviderId = keyof typeof PROVIDERS | "custom";

const STORAGE_KEY = "pi-browser:settings";

const SYSTEM_PROMPT = `You are pi, an agent running entirely inside the user's web browser. There is no shell and no access to the user's local machine.

- Files the user uploads are placed under /uploads/. Inspect them with the read tool.
- Anything produced for the user to keep must be written under /output/ as a markdown file with the write tool (the UI shows a download button for each file there). Prefer one self-contained document per task, e.g. /output/report.md.
- Use browse_url to fetch web pages; it returns page content as markdown.
- If a tool call fails, tell the user plainly instead of retrying silently.
- Respond in the user's language. Be concise and structured.`;

type CustomApiId = "openai-completions" | "anthropic-messages" | "google-generative-ai" | "openai-responses";

const CUSTOM_APIS: Record<CustomApiId, () => ReturnType<typeof openAICompletionsApi>> = {
	"openai-completions": openAICompletionsApi,
	"anthropic-messages": anthropicMessagesApi,
	"google-generative-ai": googleGenerativeAIApi,
	"openai-responses": openAIResponsesApi,
};

interface Settings {
	provider: ProviderId;
	model: string;
	key: string;
	proxy: string;
	customBaseUrl: string;
	customApi: CustomApiId;
}

const DEFAULT_PROXY = "https://r.jina.ai";

function loadSettings(): Settings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<Settings>;
			const provider = (parsed.provider ?? "anthropic") as ProviderId;
			if (provider === "custom" || provider in PROVIDERS) {
				return {
					provider,
					model: parsed.model ?? "",
					key: parsed.key ?? "",
					proxy: parsed.proxy ?? DEFAULT_PROXY,
					customBaseUrl: parsed.customBaseUrl ?? "",
					customApi: (parsed.customApi ?? "openai-completions") as CustomApiId,
				};
			}
		}
	} catch {
		/* corrupted settings fall through to defaults */
	}
	return { provider: "anthropic", model: "", key: "", proxy: DEFAULT_PROXY, customBaseUrl: "", customApi: "openai-completions" };
}

function saveSettings(settings: Settings): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// ── state ────────────────────────────────────────────────

const env = new BrowserExecutionEnv();
const sessionRepo = new InMemorySessionRepo();
let credentials = new InMemoryCredentialStore();
let models: MutableModels = createModels({ credentials });
let session: Session | null = null;
let harness: AgentHarness<ExecutionToolContext> | null = null;
let settings = loadSettings();
let pendingUploads: { path: string; name: string; size: number }[] = [];
let shownDocs = new Set<string>();
let liveModelIds = new Set<string>();
let busy = false;

// ── wiring ───────────────────────────────────────────────

function makeCustomProvider(baseUrl: string, api: CustomApiId) {
	return createProvider({
		id: "custom",
		name: "自定义",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("自定义 API key", ["CUSTOM_API_KEY"]) },
		models: [],
		api: CUSTOM_APIS[api](),
	});
}

function customModel(baseUrl: string, id: string, api: CustomApiId): Model<any> {
	return {
		id,
		name: id,
		api,
		provider: "custom",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	};
}

function configureProvider(
	provider: ProviderId,
	customBaseUrl = settings.customBaseUrl,
	customApi: CustomApiId = settings.customApi,
): void {
	if (provider === "custom") {
		if (customBaseUrl) models.setProvider(makeCustomProvider(customBaseUrl, customApi));
		return;
	}
	models.setProvider(PROVIDERS[provider]());
}

function resolveModel(): Model<any> {
	if (settings.provider === "custom") {
		if (!settings.customBaseUrl) throw new Error("自定义 provider 缺少 Base URL(在设置里填写)");
		if (!settings.model) throw new Error("请填写模型 ID(在设置里填写)");
		return customModel(settings.customBaseUrl, settings.model, settings.customApi);
	}
	const catalogModel = models.getModel(settings.provider, settings.model);
	if (catalogModel) return catalogModel;
	const fallback = models.getModels(settings.provider)[0];
	// 上游拉取的模型不在 pi 静态目录里:以目录模型为模板换 id(流式调用只需要 id + api 实现)
	if (settings.model && fallback && liveModelIds.has(`${settings.provider}:${settings.model}`)) {
		return { ...fallback, id: settings.model, name: settings.model };
	}
	if (fallback) return fallback;
	throw new Error(`Provider "${settings.provider}" 没有可用模型`);
}

async function onRefreshModels(): Promise<void> {
	const form = ui.readSettingsForm();
	if (!form.key) return;
	const provider = form.provider as ProviderId;
	if (provider === "custom" && form.customBaseUrl) {
		configureProvider("custom", form.customBaseUrl, form.customApi as CustomApiId);
	}
	ui.setRefreshBusy(true);
	ui.setSettingsHint(null);
	try {
		const live = await fetchUpstreamModels(models, provider, form.key, form.customApi);
		if (live.length === 0) throw new Error("上游返回的模型列表为空");
		for (const id of live) liveModelIds.add(`${form.provider}:${id}`);
		const catalog = models.getModels(form.provider).map((m) => m.id);
		ui.fillModelSelect(form.model, [...new Set([...live, ...catalog])]);
		ui.setSettingsHint(`已从上游拉取 ${live.length} 个模型;列表后段是本地目录兜底项。`);
	} catch (e) {
		ui.setSettingsHint(`拉取失败:${e instanceof Error ? e.message : String(e)}`);
	} finally {
		ui.setRefreshBusy(false);
	}
}

async function ensureHarness(): Promise<AgentHarness<ExecutionToolContext>> {
	if (harness) return harness;
	if (!session) session = await sessionRepo.create();
	configureProvider(settings.provider);
	harness = new AgentHarness<ExecutionToolContext>({
		session,
		models,
		model: resolveModel(),
		tools: [createReadTool(), createWriteTool(), browseUrlTool],
		toolContext: { env },
		systemPrompt: SYSTEM_PROMPT,
	});
	harness.subscribe((event) => onAgentEvent(event as AgentEvent));
	return harness;
}

function textOf(message: { content: { type: string; text?: string }[] }): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

function onAgentEvent(event: AgentEvent): void {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "assistant") ui.beginAssistant();
			break;
		case "message_update":
			if (event.message.role === "assistant") ui.updateAssistant(textOf(event.message));
			break;
		case "message_end":
			if (event.message.role === "assistant") {
				ui.finishAssistant(textOf(event.message));
				if (event.message.stopReason === "error" && event.message.errorMessage) {
					ui.showError(`模型返回错误:${event.message.errorMessage}`);
				} else if (event.message.stopReason === "aborted") {
					ui.showError("已停止。");
				}
			}
			break;
		case "tool_execution_start":
			ui.addToolRow(event.toolCallId, event.toolName, event.args);
			break;
		case "tool_execution_end":
			ui.setToolState(event.toolCallId, event.isError ? "error" : "done", event.result);
			break;
		case "agent_end":
			void emitDocCards();
			break;
		default:
			break;
	}
}

async function emitDocCards(): Promise<void> {
	const listing = await env.listDir("/output");
	if (!listing.ok) return;
	for (const file of listing.value) {
		if (file.kind !== "file" || shownDocs.has(file.path)) continue;
		shownDocs.add(file.path);
		ui.addDocCard(file.path, file.size, async () => {
			const content = await env.readTextFile(file.path);
			return content.ok ? content.value : `读取失败:${content.error.message}`;
		});
	}
}

async function uniquePath(path: string): Promise<string> {
	const dot = path.lastIndexOf(".");
	const base = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
	const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
	let candidate = path;
	let i = 1;
	for (;;) {
		const exists = await env.exists(candidate);
		if (!exists.ok || !exists.value) return candidate;
		candidate = `${base}-${i++}${ext}`;
	}
}

async function onFilesPicked(list: FileList): Promise<void> {
	for (const file of Array.from(list)) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const path = await uniquePath(`/uploads/${file.name}`);
		const result = await env.writeFile(path, bytes);
		if (result.ok) {
			pendingUploads.push({ path, name: file.name, size: bytes.length });
			ui.addAttachmentChip(file.name);
		} else {
			ui.showError(`上传失败 ${file.name}:${result.error.message}`);
		}
	}
}

async function onSend(): Promise<void> {
	if (busy) return;
	const text = ui.getText();
	const files = pendingUploads;
	if (!text && files.length === 0) return;

	const prompt =
		(text || "请阅读刚上传的文件并概述内容。") +
		(files.length
			? `\n\n[System note] Newly uploaded files: ${files.map((f) => f.path).join(", ")}.`
			: "");
	pendingUploads = [];
	ui.clearAttachments();
	ui.addUserMessage(text, files.map((f) => ({ name: f.name, size: f.size })));
	ui.clearText();
	busy = true;
	ui.setBusy(true);
	try {
		const agent = await ensureHarness();
		await agent.prompt(prompt);
	} catch (e) {
		ui.showError(e instanceof Error ? e.message : String(e));
	} finally {
		busy = false;
		ui.setBusy(false);
		await emitDocCards();
	}
}

async function onStop(): Promise<void> {
	await harness?.abort();
}

// ── settings UI ──────────────────────────────────────────

function onOpenSettings(): void {
	ui.fillSettingsForm({
		provider: settings.provider,
		model: settings.model,
		key: settings.key,
		proxy: settings.proxy,
		customBaseUrl: settings.customBaseUrl,
		customApi: settings.customApi,
	});
	ui.openSettings();
}

async function onProviderChanged(): Promise<void> {
	const form = ui.readSettingsForm();
	const provider = form.provider as ProviderId;
	ui.setCustomVisible(provider === "custom");
	if (provider === "custom") {
		if (form.customBaseUrl) configureProvider("custom", form.customBaseUrl, form.customApi as CustomApiId);
		ui.fillModelSelect("", []);
		return;
	}
	configureProvider(provider);
	ui.fillModelSelect("", models.getModels(provider).map((m) => m.id));
}

async function onSaveSettings(): Promise<void> {
	const form = ui.readSettingsForm();
	const provider = form.provider as ProviderId;
	if (provider === "custom" && (!form.customBaseUrl || !form.model)) {
		ui.setSettingsHint("自定义 provider 需要填写 Base URL 和模型 ID。");
		return;
	}
	credentials = new InMemoryCredentialStore();
	if (form.key) {
		await credentials.modify(provider, async () => ({ type: "api_key", key: form.key }));
	}
	settings = {
		provider,
		model: form.model,
		key: form.key,
		proxy: form.proxy || DEFAULT_PROXY,
		customBaseUrl: form.customBaseUrl,
		customApi: form.customApi as CustomApiId,
	};
	saveSettings(settings);
	setBrowseProxy(settings.proxy);
	models = createModels({ credentials });
	configureProvider(provider);
	harness = null; // rebuilt with the new model/auth on next send; chat history stays
	try {
		const model = resolveModel();
		ui.setModelBadge(`${settings.provider} / ${model.id}`);
		ui.closeSettings();
	} catch (e) {
		ui.showError(e instanceof Error ? e.message : String(e));
	}
}

// ── boot ─────────────────────────────────────────────────

const ui = new Ui({
	onSend: () => void onSend(),
	onStop: () => void onStop(),
	onFilesPicked: (files) => void onFilesPicked(files),
	onOpenSettings,
	onCloseSettings: () => ui.closeSettings(),
	onSaveSettings: () => void onSaveSettings(),
		onSuggestion: (prompt) => {
			ui.clearText();
			const input = document.getElementById("input") as HTMLTextAreaElement;
			input.value = prompt;
			input.dispatchEvent(new Event("input"));
			input.focus();
		},
		onRefreshModels: () => void onRefreshModels(),
	});

document.getElementById("sel-provider")?.addEventListener("change", () => void onProviderChanged());

(async function boot(): Promise<void> {
	setBrowseProxy(settings.proxy);
	configureProvider(settings.provider);
	const modelIds = models.getModels(settings.provider).map((m) => m.id);
	if (settings.model && !modelIds.includes(settings.model)) settings.model = modelIds[0] ?? "";
	ui.fillModelSelect(settings.model, modelIds);
	if (settings.key) {
		await credentials.modify(settings.provider, async () => ({ type: "api_key", key: settings.key }));
		try {
			ui.setModelBadge(`${settings.provider} / ${resolveModel().id}`);
		} catch {
			ui.setModelBadge(`${settings.provider} / ${settings.model || "未配置"}`);
		}
	} else {
		onOpenSettings();
	}
})();
