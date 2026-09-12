import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";

const browseParams = Type.Object({
	url: Type.String({ description: "The full URL to fetch, including the https:// or http:// scheme." }),
});

export type BrowseDetails = { url: string; bytes: number };

const MAX_CONTENT_CHARS = 200_000;

/**
 * Reader proxy that converts a page to markdown and is CORS-enabled. The
 * default (r.jina.ai) works on international networks; it can be swapped for
 * a self-hosted proxy in the settings dialog.
 */
let browseProxy = "https://r.jina.ai";

export function setBrowseProxy(proxy: string): void {
	browseProxy = proxy.replace(/\/+$/, "");
}

/**
 * Web browsing tool: fetches a page through a CORS-enabled reader proxy and
 * returns clean markdown instead of raw HTML.
 */
export const browseUrlTool: AgentHarnessTool<ExecutionToolContext, typeof browseParams, BrowseDetails> = {
	name: "browse_url",
	label: "browse_url",
	description:
		"Fetch a web page and return its readable content as markdown. " +
		"Use this whenever you need to look at a URL the user mentions. " +
		"PDF and other non-HTML URLs are converted to text as well. " +
		"Content is truncated if extremely long.",
	parameters: browseParams,
	async execute(_toolCallId, params: Static<typeof browseParams>, signal, _onUpdate, _context) {
		const details: BrowseDetails = { url: params.url, bytes: 0 };
		try {
			const response = await fetch(`${browseProxy}/${params.url}`, {
				signal,
				headers: { Accept: "text/plain" },
			});
			if (!response.ok) {
				const body = (await response.text().catch(() => "")).slice(0, 500);
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch ${params.url}: HTTP ${response.status}${body ? `\n${body}` : ""}`,
						},
					],
					details,
				};
			}
			const text = await response.text();
			details.bytes = text.length;
			const truncated = text.length > MAX_CONTENT_CHARS;
			return {
				content: [
					{
						type: "text",
						text: truncated ? `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[... truncated, ${text.length} chars total]` : text,
					},
				],
				details,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return {
				content: [
					{
						type: "text",
						text:
							`Failed to fetch ${params.url}: ${message}. ` +
							`The reader proxy (${browseProxy}) may be unreachable from this network — ` +
							`tell the user they can change it in the settings dialog.`,
					},
				],
				details,
			};
		}
	},
};
