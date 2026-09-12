import type { MutableModels } from "@earendil-works/pi-ai";

export type ProviderId = "anthropic" | "openai" | "google" | "deepseek" | "custom";

/**
 * Fetch the live model list from a provider's upstream API. Endpoint shapes
 * differ per provider; baseUrl comes from the pi-ai provider object so it
 * stays consistent with what streaming uses.
 */
export async function fetchUpstreamModels(
	models: MutableModels,
	provider: ProviderId,
	key: string,
	customApi = "openai-completions",
): Promise<string[]> {
	const baseUrl = models.getProvider(provider)?.baseUrl?.replace(/\/+$/, "");
	if (!baseUrl) throw new Error(`Provider ${provider} 没有配置 baseUrl`);

	let url: string;
	const init: RequestInit = { headers: {} as Record<string, string> };
	const headers = init.headers as Record<string, string>;

	switch (provider) {
		case "deepseek":
		case "openai":
		case "custom": {
			// OpenAI 兼容:base_url 可含 /v1,模型列表固定在 {base}/models
			url = `${baseUrl}/models`;
			headers.Authorization = `Bearer ${key}`;
			if (provider === "custom" && customApi === "anthropic-messages") {
				url = `${baseUrl}/v1/models`;
				headers.Authorization = "";
				delete headers.Authorization;
				headers["x-api-key"] = key;
				headers["anthropic-version"] = "2023-06-01";
			} else if (provider === "custom" && customApi === "google-generative-ai") {
				url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(key)}`;
			}
			break;
		}
		case "anthropic":
			url = `${baseUrl}/v1/models`;
			headers["x-api-key"] = key;
			headers["anthropic-version"] = "2023-06-01";
			break;
		case "google":
			url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(key)}`;
			break;
	}

	const response = await fetch(url, init);
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`上游返回 HTTP ${response.status}${body ? `:${body}` : ""}`);
	}
	const payload = (await response.json()) as {
		data?: { id?: string }[];
		models?: { name?: string; supportedGenerationMethods?: string[] }[];
	};

	if (Array.isArray(payload.data)) {
		return payload.data.map((m) => m.id ?? "").filter(Boolean).sort();
	}
	if (Array.isArray(payload.models)) {
		return payload.models
			.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
			.map((m) => (m.name ?? "").replace(/^models\//, ""))
			.filter(Boolean)
			.sort();
	}
	throw new Error("上游响应里没有模型列表");
}
