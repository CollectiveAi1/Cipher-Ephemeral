import type { Store } from "../store.ts";
import { forbidden, notFound } from "./errors.ts";

/**
 * Confirms the caller is a member and returns their role. A non-member gets 404 rather
 * than 403 so the API does not confirm that a conversation id exists.
 */
export function assertMember(store: Store, conversationId: string, userId: string): "admin" | "member" {
  const role = store.conversations.roleOf(conversationId, userId);
  if (role === null) throw notFound("Conversation not found");
  return role;
}

export function assertAdmin(store: Store, conversationId: string, userId: string): void {
  if (assertMember(store, conversationId, userId) !== "admin") {
    throw forbidden("Only a conversation admin can do that");
  }
}
