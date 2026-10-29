import type {
  ApiErrorBody,
  AuthSession,
  BurnMode,
  Call,
  Community,
  Conversation,
  PostPolicy,
  HealthReport,
  Message,
  MessagePage,
  PublicUser,
  Reaction,
} from "../../shared/protocol.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type RegisterInput = {
  username: string;
  displayName: string;
  password: string;
  publicKey: string;
  wrappedPrivateKey: string;
  keySalt: string;
};

type MemberKeyInput = {
  userId: string;
  wrappedKey: string;
};

type CreateConversationInput = {
  kind: "dm" | "group";
  name?: string;
  keys: MemberKeyInput[];
  defaultTtlSeconds: number;
  defaultBurnMode: BurnMode;
};

type SendMessageInput = {
  ciphertext: string;
  iv: string;
  mediaId: string | null;
  replyToId: string | null;
  ttlSeconds: number;
  burnMode: BurnMode;
};

type CreateCommunityInput = {
  name: string;
  description: string;
  maxTtlSeconds: number;
};

type CommunityPatchInput = {
  name?: string;
  description?: string;
  maxTtlSeconds?: number;
};

type CreateChannelInput = {
  name: string;
  postPolicy: PostPolicy;
  keys: MemberKeyInput[];
  defaultTtlSeconds: number;
  defaultBurnMode: BurnMode;
};

export type ConversationPatchInput = {
  name?: string;
  defaultTtlSeconds?: number;
  defaultBurnMode?: BurnMode;
};

/** Token accessor, so the client always sends the current session without prop drilling. */
type TokenSource = () => string | null;

export function createApi(tokenSource: TokenSource) {
  const request = async <T>(path: string, init: RequestInit = {}, parse = true): Promise<T> => {
    const headers = new Headers(init.headers);
    const token = tokenSource();
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetch(`/api${path}`, { ...init, headers });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiError(
        response.status,
        body?.error.code ?? "unknown",
        body?.error.message ?? `Request failed with ${response.status}`,
      );
    }
    if (!parse || response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  return {
    health: () => request<HealthReport>("/health"),

    register: (input: RegisterInput) =>
      request<AuthSession>("/auth/register", { method: "POST", body: JSON.stringify(input) }),

    login: (username: string, password: string) =>
      request<AuthSession>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),

    logout: () => request<void>("/auth/logout", { method: "POST" }, false),

    me: () => request<PublicUser>("/users/me"),

    directory: (query: string) => request<PublicUser[]>(`/users?q=${encodeURIComponent(query)}`),

    conversations: () => request<Conversation[]>("/conversations"),

    createConversation: (input: CreateConversationInput) =>
      request<Conversation>("/conversations", { method: "POST", body: JSON.stringify(input) }),

    patchConversation: (id: string, patch: ConversationPatchInput) =>
      request<Conversation>(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

    addMember: (id: string, input: MemberKeyInput) =>
      request<Conversation>(`/conversations/${id}/members`, { method: "POST", body: JSON.stringify(input) }),

    leaveConversation: (id: string, userId: string) =>
      request<void>(`/conversations/${id}/members/${userId}`, { method: "DELETE" }, false),

    messages: (id: string, cursor: string | null) =>
      request<MessagePage>(`/conversations/${id}/messages${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`),

    sendMessage: (id: string, input: SendMessageInput) =>
      request<Message>(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify(input) }),

    markConversationRead: (id: string) =>
      request<void>(`/conversations/${id}/read`, { method: "POST" }, false),

    markMessageRead: (id: string) =>
      request<{ expiresAt: number | null }>(`/messages/${id}/read`, { method: "POST" }),

    react: (id: string, emoji: string) =>
      request<{ reactions: Reaction[] }>(`/messages/${id}/reactions`, {
        method: "POST",
        body: JSON.stringify({ emoji }),
      }),

    communities: () => request<Community[]>("/communities"),

    createCommunity: (input: CreateCommunityInput) =>
      request<Community>("/communities", { method: "POST", body: JSON.stringify(input) }),

    patchCommunity: (id: string, patch: CommunityPatchInput) =>
      request<Community>(`/communities/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

    addCommunityMember: (id: string, userId: string, role: "admin" | "member") =>
      request<Community>(`/communities/${id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId, role }),
      }),

    leaveCommunity: (id: string, userId: string) =>
      request<void>(`/communities/${id}/members/${userId}`, { method: "DELETE" }, false),

    createChannel: (id: string, input: CreateChannelInput) =>
      request<Conversation>(`/communities/${id}/channels`, { method: "POST", body: JSON.stringify(input) }),

    calls: () => request<Call[]>("/calls"),

    burnMessage: (id: string) => request<void>(`/messages/${id}`, { method: "DELETE" }, false),

    uploadMedia: async (bytes: Uint8Array<ArrayBuffer>): Promise<{ id: string }> =>
      request<{ id: string }>("/media", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }),

    downloadMedia: async (id: string): Promise<Uint8Array<ArrayBuffer>> => {
      const headers = new Headers();
      const token = tokenSource();
      if (token !== null) headers.set("authorization", `Bearer ${token}`);

      const response = await fetch(`/api/media/${id}`, { headers });
      if (!response.ok) throw new ApiError(response.status, "media_unavailable", "Attachment is gone");
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
