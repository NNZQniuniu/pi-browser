import DOMPurify from "dompurify";
import { marked } from "marked";

export interface UploadedFileView {
	name: string;
	size: number;
}

function byId<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Missing element #${id}`);
	return el as T;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderMarkdown(markdown: string): string {
	const html = marked.parse(markdown, { async: false, gfm: true, breaks: true });
	return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

function textPreview(value: unknown, limit = 400): string {
	if (value === undefined || value === null) return "";
	let text: string;
	if (Array.isArray(value)) {
		text = value
			.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : JSON.stringify(part)))
			.join("\n");
	} else if (typeof value === "object") {
		text = JSON.stringify(value, null, 2);
	} else {
		text = String(value);
	}
	return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

export class Ui {
	private readonly messages = byId<HTMLDivElement>("messages");
	private readonly chat = byId<HTMLElement>("chat");
	private readonly welcome = byId<HTMLDivElement>("welcome");
	private readonly input = byId<HTMLTextAreaElement>("input");
	private readonly btnSend = byId<HTMLButtonElement>("btn-send");
	private readonly btnStop = byId<HTMLButtonElement>("btn-stop");
	private readonly btnAttach = byId<HTMLButtonElement>("btn-attach");
	private readonly fileInput = byId<HTMLInputElement>("file-input");
	private readonly attachments = byId<HTMLDivElement>("attachments");
	private readonly modelBadge = byId<HTMLSpanElement>("model-badge");
	private readonly overlay = byId<HTMLDivElement>("settings-overlay");

	private streamingEl: HTMLDivElement | null = null;
	private pinned = true;

	constructor(handlers: {
		onSend: () => void;
		onStop: () => void;
		onFilesPicked: (files: FileList) => void;
		onOpenSettings: () => void;
		onCloseSettings: () => void;
		onSaveSettings: () => void;
		onSuggestion: (prompt: string) => void;
		onRefreshModels: () => void;
	}) {
		byId<HTMLButtonElement>("btn-settings").addEventListener("click", handlers.onOpenSettings);
		byId<HTMLButtonElement>("btn-settings-close").addEventListener("click", handlers.onCloseSettings);
		byId<HTMLButtonElement>("btn-save").addEventListener("click", handlers.onSaveSettings);
		// 按需求:只有"保存并应用"或 ✕ 能关闭设置弹层,点击遮罩不关闭

		const refreshBtn = byId<HTMLButtonElement>("btn-refresh-models");
		const keyInput = byId<HTMLInputElement>("inp-key");
		const syncRefreshState = () => {
			refreshBtn.disabled = keyInput.value.trim().length === 0;
		};
		keyInput.addEventListener("input", syncRefreshState);
		refreshBtn.addEventListener("click", () => {
			if (!refreshBtn.disabled) handlers.onRefreshModels();
		});
		syncRefreshState();

		this.btnSend.addEventListener("click", handlers.onSend);
		this.btnStop.addEventListener("click", handlers.onStop);
		this.btnAttach.addEventListener("click", () => this.fileInput.click());
		this.fileInput.addEventListener("change", () => {
			if (this.fileInput.files?.length) handlers.onFilesPicked(this.fileInput.files);
			this.fileInput.value = "";
		});

		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handlers.onSend();
			}
		});
		this.input.addEventListener("input", () => {
			this.input.style.height = "auto";
			this.input.style.height = `${Math.min(this.input.scrollHeight, 180)}px`;
			this.btnSend.disabled = this.input.value.trim().length === 0;
		});

		for (const btn of document.querySelectorAll<HTMLButtonElement>(".suggestion")) {
			btn.addEventListener("click", () => handlers.onSuggestion(btn.dataset.prompt ?? ""));
		}

		this.chat.addEventListener("scroll", () => {
			this.pinned = this.chat.scrollHeight - this.chat.scrollTop - this.chat.clientHeight < 60;
		});
	}

	getText(): string {
		return this.input.value.trim();
	}

	clearText(): void {
		this.input.value = "";
		this.input.style.height = "auto";
		this.btnSend.disabled = true;
	}

	setModelBadge(text: string): void {
		this.modelBadge.textContent = text;
	}

	addAttachmentChip(name: string): void {
		const chip = document.createElement("span");
		chip.className = "file-card";
		chip.innerHTML = `<span class="fname"></span>`;
		(chip.querySelector(".fname") as HTMLElement).textContent = name;
		this.attachments.appendChild(chip);
	}

	clearAttachments(): void {
		this.attachments.innerHTML = "";
	}

	openSettings(): void {
		this.overlay.classList.remove("hidden");
	}

	closeSettings(): void {
		this.overlay.classList.add("hidden");
	}

	fillSettingsForm(values: {
		provider: string;
		model: string;
		key: string;
		proxy: string;
		customBaseUrl: string;
		customApi: string;
	}): void {
		byId<HTMLSelectElement>("sel-provider").value = values.provider;
		this.setCustomVisible(values.provider === "custom");
		byId<HTMLSelectElement>("sel-custom-api").value = values.customApi;
		byId<HTMLInputElement>("inp-custom-base").value = values.customBaseUrl;
		this.fillModelSelect(values.model);
		byId<HTMLInputElement>("inp-key").value = values.key;
		byId<HTMLInputElement>("inp-proxy").value = values.proxy;
		this.setRefreshBusy(false);
		this.setSettingsHint(null);
	}

	setCustomVisible(visible: boolean): void {
		byId<HTMLDivElement>("custom-fields").classList.toggle("hidden", !visible);
	}

	setRefreshBusy(busy: boolean): void {
		const btn = byId<HTMLButtonElement>("btn-refresh-models");
		btn.classList.toggle("spinning", busy);
		btn.disabled = busy || byId<HTMLInputElement>("inp-key").value.trim().length === 0;
	}

	/** null 恢复默认提示文案;传入文本则显示(错误/状态)信息。 */
	setSettingsHint(text: string | null): void {
		const hint = document.querySelector(".settings .hint") as HTMLElement;
		hint.textContent =
			text ??
			"Key 只写入本机 localStorage,请求直连模型服务商;除此之外不经过任何服务器。抓取代理需支持 CORS 且在你的网络可达,r.jina.ai 在国际网络可用,国内网络建议自建(如 Cloudflare Worker)。";
		if (text) hint.style.color = "var(--danger)";
		else hint.style.color = "";
	}

	fillModelSelect(selectedModel: string, options?: readonly string[]): void {
		const input = byId<HTMLInputElement>("inp-model");
		const datalist = byId<HTMLDataListElement>("model-options");
		const models = options ?? [...datalist.options].map((o) => o.value);
		datalist.innerHTML = "";
		for (const id of models) {
			const option = document.createElement("option");
			option.value = id;
			datalist.appendChild(option);
		}
		input.value = models.includes(selectedModel) || selectedModel ? selectedModel : (models[0] ?? "");
	}

	readSettingsForm(): {
		provider: string;
		model: string;
		key: string;
		proxy: string;
		customBaseUrl: string;
		customApi: string;
	} {
		return {
			provider: byId<HTMLSelectElement>("sel-provider").value,
			model: byId<HTMLInputElement>("inp-model").value.trim(),
			key: byId<HTMLInputElement>("inp-key").value.trim(),
			proxy: byId<HTMLInputElement>("inp-proxy").value.trim(),
			customBaseUrl: byId<HTMLInputElement>("inp-custom-base").value.trim().replace(/\/+$/, ""),
			customApi: byId<HTMLSelectElement>("sel-custom-api").value,
		};
	}

	private scrollIfPinned(): void {
		if (this.pinned) this.chat.scrollTop = this.chat.scrollHeight;
	}

	private hideWelcome(): void {
		this.welcome.classList.add("hidden");
	}

	private append(el: HTMLElement): void {
		this.hideWelcome();
		this.messages.appendChild(el);
		this.scrollIfPinned();
	}

	addUserMessage(text: string, files: UploadedFileView[]): void {
		const wrap = document.createElement("div");
		wrap.className = "msg msg-user";
		for (const file of files) {
			const card = document.createElement("span");
			card.className = "file-card";
			card.innerHTML = `<span class="fname"></span><span class="fsize"></span>`;
			(card.querySelector(".fname") as HTMLElement).textContent = file.name;
			(card.querySelector(".fsize") as HTMLElement).textContent = formatSize(file.size);
			wrap.appendChild(card);
		}
		if (text) {
			const bubble = document.createElement("div");
			bubble.className = "bubble";
			bubble.textContent = text;
			wrap.appendChild(bubble);
		}
		this.append(wrap);
	}

	beginAssistant(): void {
		const wrap = document.createElement("div");
		wrap.className = "msg msg-assistant";
		const who = document.createElement("div");
		who.className = "who";
		who.textContent = "assistant";
		const body = document.createElement("div");
		body.className = "md";
		body.innerHTML = `<span class="cursor"></span>`;
		wrap.append(who, body);
		this.streamingEl = wrap;
		this.append(wrap);
	}

	private assistantBody(): HTMLElement {
		if (!this.streamingEl) this.beginAssistant();
		return this.streamingEl!.querySelector(".md") as HTMLElement;
	}

	updateAssistant(markdown: string): void {
		const body = this.assistantBody();
		body.innerHTML = renderMarkdown(markdown) + `<span class="cursor"></span>`;
		this.scrollIfPinned();
	}

	finishAssistant(markdown: string): void {
		const body = this.assistantBody();
		body.innerHTML = markdown ? renderMarkdown(markdown) : `<span class="md" style="color:var(--text-faint)">(no content)</span>`;
		this.streamingEl = null;
		this.scrollIfPinned();
	}

	addToolRow(id: string, toolName: string, args: unknown): void {
		const host = this.streamingEl ?? this.messages;
		const row = document.createElement("details");
		row.className = "tool-row";
		row.dataset.toolId = id;
		row.innerHTML = `
			<summary>
				<span class="spinner"></span>
				<span class="chevron">▶</span>
				<span class="tool-name"></span>
				<span class="tool-args"></span>
				<span class="tool-state running">运行中</span>
			</summary>
			<div class="tool-body"><pre></pre></div>`;
		(row.querySelector(".tool-name") as HTMLElement).textContent = toolName;
		(row.querySelector(".tool-args") as HTMLElement).textContent = textPreview(args, 120).replace(/\s+/g, " ");
		(row.querySelector(".tool-body pre") as HTMLElement).textContent = textPreview(args, 2000);
		if (host === this.messages) {
			this.append(row);
		} else {
			// insert tool rows after the streaming bubble's header, above the markdown body
			this.streamingEl!.appendChild(row);
			this.scrollIfPinned();
		}
	}

	setToolState(id: string, state: "done" | "error", output?: unknown): void {
		const row = this.messages.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);
		if (!row) return;
		row.querySelector(".spinner")?.remove();
		const stateEl = row.querySelector(".tool-state") as HTMLElement | null;
		if (stateEl) {
			stateEl.textContent = state === "done" ? "完成" : "出错";
			stateEl.className = `tool-state ${state}`;
		}
		if (output !== undefined) {
			const pre = row.querySelector(".tool-body pre") as HTMLElement | null;
			if (pre) pre.textContent = textPreview(output, 2000);
		}
	}

	showError(text: string): void {
		const el = document.createElement("div");
		el.className = "msg msg-error";
		el.textContent = text;
		this.append(el);
	}

	addDocCard(name: string, size: number, getContent: () => Promise<string | Uint8Array>): void {
		const card = document.createElement("span");
		card.className = "file-card doc";
		card.innerHTML = `<span>📄</span><span class="fname"></span><span class="fsize"></span><button class="dl-btn">下载</button>`;
		(card.querySelector(".fname") as HTMLElement).textContent = name;
		(card.querySelector(".fsize") as HTMLElement).textContent = formatSize(size);
		card.querySelector(".dl-btn")?.addEventListener("click", async () => {
			const content = await getContent();
			const blob =
				typeof content === "string"
					? new Blob([content], { type: "text/markdown;charset=utf-8" })
					: new Blob([content.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.click();
			URL.revokeObjectURL(url);
		});
		this.append(card);
	}

	setBusy(busy: boolean): void {
		this.btnSend.classList.toggle("hidden", busy);
		this.btnStop.classList.toggle("hidden", !busy);
		this.btnAttach.disabled = busy;
		this.input.disabled = busy;
		if (!busy) {
			this.btnSend.disabled = this.input.value.trim().length === 0;
			this.input.focus();
		}
	}
}
