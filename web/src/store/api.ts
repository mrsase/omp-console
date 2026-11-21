import type { FsListing, InfoResponse, RecentSession, ThreadInfo } from "../protocol/types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface CreateThreadBody {
  cwd?: string;
  resume?: string;
  model?: string;
  thinking?: string;
}

export interface ConsoleApi {
  info(): Promise<InfoResponse>;
  threads(): Promise<ThreadInfo[]>;
  createThread(body: CreateThreadBody): Promise<ThreadInfo>;
  deleteThread(id: string): Promise<void>;
  stderr(id: string): Promise<string[]>;
  recent(cwd?: string, limit?: number): Promise<RecentSession[]>;
  fs(path?: string): Promise<FsListing>;
}

export class HttpApi implements ConsoleApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(base = "", fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.base = base;
    this.fetchImpl = fetchImpl;
  }

  async info(): Promise<InfoResponse> {
    return this.request<InfoResponse>("/api/info");
  }

  async threads(): Promise<ThreadInfo[]> {
    return this.request<ThreadInfo[]>("/api/threads");
  }

  async createThread(body: CreateThreadBody): Promise<ThreadInfo> {
    return this.request<ThreadInfo>("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async deleteThread(id: string): Promise<void> {
    await this.request<{ ok: true }>(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async stderr(id: string): Promise<string[]> {
    const result = await this.request<{ lines: string[] }>(`/api/threads/${encodeURIComponent(id)}/stderr`);
    return result.lines;
  }

  async recent(cwd?: string, limit = 50): Promise<RecentSession[]> {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    params.set("limit", String(limit));
    return this.request<RecentSession[]>(`/api/recent?${params.toString()}`);
  }

  async fs(path?: string): Promise<FsListing> {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    return this.request<FsListing>(`/api/fs?${params.toString()}`);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    const response = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const record = payload && typeof payload === "object" ? (payload as { error?: unknown; code?: unknown }) : {};
      throw new ApiError(
        typeof record.error === "string" ? record.error : `request failed (${response.status})`,
        response.status,
        typeof record.code === "string" ? record.code : null,
      );
    }
    return payload as T;
  }
}
