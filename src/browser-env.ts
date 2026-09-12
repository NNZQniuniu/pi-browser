import {
	ExecutionError,
	FileError,
	type ExecutionEnv,
	type FileInfo,
	type Result,
} from "@earendil-works/pi-agent-core";

/**
 * In-memory ExecutionEnv for the browser: a small POSIX-style virtual
 * filesystem backed by a Map. Every FileSystem method follows the interface
 * contract — failures are encoded in the returned Result, never thrown.
 */

interface FsNode {
	kind: "file" | "directory";
	content?: Uint8Array;
	mtimeMs: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

function fail<T>(error: FileError): Result<T, FileError> {
	return { ok: false, error };
}

export class BrowserExecutionEnv implements ExecutionEnv {
	readonly cwd = "/home/user";
	private readonly nodes = new Map<string, FsNode>();
	private tmpCounter = 0;

	constructor() {
		const now = Date.now();
		for (const dir of ["/", "/home", "/home/user", "/uploads", "/output", "/tmp"]) {
			this.nodes.set(dir, { kind: "directory", mtimeMs: now });
		}
	}

	/** Resolve against cwd and collapse ".", ".." and duplicate slashes. */
	private normalize(path: string): string {
		const abs = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		const parts: string[] = [];
		for (const seg of abs.split("/")) {
			if (seg === "" || seg === ".") continue;
			if (seg === "..") parts.pop();
			else parts.push(seg);
		}
		return "/" + parts.join("/");
	}

	private basename(path: string): string {
		return path.slice(path.lastIndexOf("/") + 1);
	}

	private parentOf(path: string): string {
		const i = path.lastIndexOf("/");
		return i <= 0 ? "/" : path.slice(0, i);
	}

	private ensureDirsSync(dir: string): void {
		const parts = dir.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur += "/" + part;
			const existing = this.nodes.get(cur);
			if (existing) {
				if (existing.kind !== "directory") {
					throw new FileError("not_directory", `Not a directory: ${cur}`, cur);
				}
				continue;
			}
			this.nodes.set(cur, { kind: "directory", mtimeMs: Date.now() });
		}
	}

	private guard<T>(path: string | undefined, fn: () => Result<T, FileError>): Result<T, FileError> {
		try {
			return fn();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return fail(new FileError("unknown", message, path));
		}
	}

	private node(path: string): Result<FsNode, FileError> {
		const node = this.nodes.get(path);
		if (!node) return fail(new FileError("not_found", `No such file or directory: ${path}`, path));
		return ok(node);
	}

	private requireFile(path: string, content?: Uint8Array): Result<Uint8Array, FileError> {
		const node = this.nodes.get(path);
		if (!node) return fail(new FileError("not_found", `No such file: ${path}`, path));
		if (node.kind !== "file") return fail(new FileError("is_directory", `Is a directory: ${path}`, path));
		return ok(content ?? node.content ?? new Uint8Array());
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return this.guard(path, () => ok(this.normalize(path)));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return this.guard(parts[0], () => ok(this.normalize(parts.join("/"))));
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const bytes = this.requireFile(path);
			if (!bytes.ok) return bytes;
			return ok(decoder.decode(bytes.value));
		});
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		return this.guard(path, () => {
			if (options?.abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const bytes = this.requireFile(path);
			if (!bytes.ok) return bytes;
			const all = decoder.decode(bytes.value).split("\n");
			const maxLines = options?.maxLines;
			return ok(typeof maxLines === "number" ? all.slice(0, maxLines) : all);
		});
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const bytes = this.requireFile(path);
			if (!bytes.ok) return bytes;
			return ok(bytes.value.slice());
		});
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const normalized = this.normalize(path);
			this.ensureDirsSync(this.parentOf(normalized));
			const bytes = typeof content === "string" ? encoder.encode(content) : content;
			this.nodes.set(normalized, { kind: "file", content: bytes.slice(), mtimeMs: Date.now() });
			return ok(undefined);
		});
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const normalized = this.normalize(path);
			const addition = typeof content === "string" ? encoder.encode(content) : content;
			const existing = this.nodes.get(normalized);
			if (existing && existing.kind === "directory") {
				return fail(new FileError("is_directory", `Is a directory: ${normalized}`, normalized));
			}
			const current = existing?.content ?? new Uint8Array();
			const merged = new Uint8Array(current.length + addition.length);
			merged.set(current, 0);
			merged.set(addition, current.length);
			this.nodes.set(normalized, { kind: "file", content: merged, mtimeMs: Date.now() });
			return ok(undefined);
		});
	}

	async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const normalized = this.normalize(path);
			const found = this.node(normalized);
			if (!found.ok) return found;
			const node = found.value;
			return ok({
				name: this.basename(normalized),
				path: normalized,
				kind: node.kind,
				size: node.kind === "file" ? (node.content?.length ?? 0) : 0,
				mtimeMs: node.mtimeMs,
			});
		});
	}

	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const normalized = this.normalize(path);
			const dir = this.node(normalized);
			if (!dir.ok) return dir;
			if (dir.value.kind !== "directory") {
				return fail(new FileError("not_directory", `Not a directory: ${normalized}`, normalized));
			}
			const prefix = normalized === "/" ? "/" : normalized + "/";
			const children: FileInfo[] = [];
			for (const [childPath, node] of this.nodes) {
				if (!childPath.startsWith(prefix) || childPath === normalized) continue;
				const rest = childPath.slice(prefix.length);
				if (rest.includes("/")) continue; // grandchildren live under a child dir entry anyway
				children.push({
					name: this.basename(childPath),
					path: childPath,
					kind: node.kind,
					size: node.kind === "file" ? (node.content?.length ?? 0) : 0,
					mtimeMs: node.mtimeMs,
				});
			}
			children.sort((a, b) => a.name.localeCompare(b.name));
			return ok(children);
		});
	}

	async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const normalized = this.normalize(path);
			const found = this.node(normalized);
			return found.ok ? ok(normalized) : found;
		});
	}

	async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
		return this.guard(path, () => {
			if (abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			return ok(this.nodes.has(this.normalize(path)));
		});
	}

	async createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		return this.guard(path, () => {
			if (options?.abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const normalized = this.normalize(path);
			const existing = this.nodes.get(normalized);
			if (existing) {
				if (existing.kind === "directory") return ok(undefined);
				return fail(new FileError("not_directory", `File exists, not a directory: ${normalized}`, normalized));
			}
			const parent = this.parentOf(normalized);
			if (options?.recursive === false && !this.nodes.has(parent)) {
				return fail(new FileError("not_found", `Parent directory does not exist: ${parent}`, normalized));
			}
			this.ensureDirsSync(normalized);
			return ok(undefined);
		});
	}

	async remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		return this.guard(path, () => {
			if (options?.abortSignal?.aborted) return fail(new FileError("aborted", "Aborted", path));
			const normalized = this.normalize(path);
			if (normalized === "/") {
				return fail(new FileError("permission_denied", "Cannot remove the filesystem root", normalized));
			}
			const node = this.nodes.get(normalized);
			if (!node) {
				return options?.force ? ok(undefined) : fail(new FileError("not_found", `No such path: ${normalized}`, normalized));
			}
			if (node.kind === "directory" && options?.recursive !== true) {
				const hasChildren = [...this.nodes.keys()].some(
					(p) => p.startsWith(normalized + "/") && !p.slice(normalized.length + 1).includes("/"),
				);
				if (hasChildren) {
					return fail(new FileError("invalid", `Directory not empty: ${normalized}`, normalized));
				}
			}
			for (const p of [...this.nodes.keys()]) {
				if (p === normalized || p.startsWith(normalized + "/")) this.nodes.delete(p);
			}
			return ok(undefined);
		});
	}

	async createTempDir(prefix?: string): Promise<Result<string, FileError>> {
		return this.guard(undefined, () => {
			const dir = `/tmp/${prefix ?? "tmp-"}${Date.now().toString(36)}-${this.tmpCounter++}`;
			this.ensureDirsSync(dir);
			return ok(dir);
		});
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		return this.guard(undefined, () => {
			const file = `/tmp/${options?.prefix ?? ""}${Date.now().toString(36)}-${this.tmpCounter++}${options?.suffix ?? ""}`;
			this.nodes.set(file, { kind: "file", content: new Uint8Array(), mtimeMs: Date.now() });
			return ok(file);
		});
	}

	async cleanup(): Promise<void> {
		/* nothing to release */
	}

	async exec(): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return { ok: false, error: new ExecutionError("shell_unavailable", "Shell execution is not available in the browser") };
	}
}
