import type { ReadImageProcessor } from "@earendil-works/pi-agent-core";

/**
 * Browser image processor for the read tool: base64-encodes images so the
 * model receives them as attachments, downscaling oversized ones via canvas
 * (vision APIs choke on very large payloads).
 */

const MAX_SIDE = 1568;
const MAX_BYTES = 4 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

async function resizeIfNeeded(
	bytes: Uint8Array,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	if (bytes.length <= MAX_BYTES) return null;
	const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType });
	const bitmap = await createImageBitmap(blob);
	try {
		const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
		if (!out) return null;
		return { data: toBase64(new Uint8Array(await out.arrayBuffer())), mimeType: "image/jpeg" };
	} finally {
		bitmap.close();
	}
}

export const canvasImageProcessor: ReadImageProcessor = async (bytes, mimeType, { autoResizeImages }) => {
	try {
		if (autoResizeImages) {
			const resized = await resizeIfNeeded(bytes, mimeType);
			if (resized) {
				return { ok: true, ...resized, hints: [`Image was resized to fit ${MAX_SIDE}px (original ${bytes.length} bytes).`] };
			}
		}
		return { ok: true, data: toBase64(bytes), mimeType, hints: [] };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
};
