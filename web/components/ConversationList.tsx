import type { Conversation, PublicUser } from "../../shared/protocol.ts";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { PlusIcon, ShieldIcon } from "./Icons.tsx";

type ConversationListProps = {
  onNewConversation: () => void;
};

/** A DM is titled and pictured from the other person, not from a stored name. */
export function peerOf(conversation: Conversation, selfId: string | undefined): PublicUser | undefined {
  return conversation.members.find((member) => member.id !== selfId) ?? conversation.members[0];
}

export function titleOf(conversation: Conversation, selfId: string | undefined): string {
  if (conversation.kind === "group") return conversation.name ?? "Untitled group";
  return peerOf(conversation, selfId)?.displayName ?? "Direct message";
}

export function ConversationList({ onNewConversation }: ConversationListProps) {
  const { state, user, openConversation } = useCipher();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-edge px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-700 text-cyan">
          <ShieldIcon className="h-4 w-4" />
        </span>
        <h1 className="font-semibold tracking-tight">Chats</h1>
        <button
          type="button"
          onClick={onNewConversation}
          aria-label="New conversation"
          className="ml-auto rounded-lg border border-edge p-1.5 text-lo hover:border-cyan hover:text-cyan"
        >
          <PlusIcon />
        </button>
      </header>

      <nav className="scroll-thin flex-1 overflow-y-auto py-2">
        {state.conversations.length === 0 ? (
          <p className="px-4 py-6 text-xs leading-relaxed text-lo">
            No conversations yet. Start one and every message you send will carry its own expiry.
          </p>
        ) : (
          <ul>
            {state.conversations.map((conversation) => {
              const peer = peerOf(conversation, user?.id);
              const active = conversation.id === state.activeId;
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => openConversation(conversation.id)}
                    aria-current={active}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      active ? "bg-ink-700" : "hover:bg-ink-700/50"
                    }`}
                  >
                    <Avatar
                      name={titleOf(conversation, user?.id)}
                      hue={conversation.kind === "group" ? 265 : (peer?.avatarHue ?? 210)}
                      {...(conversation.kind === "dm" && peer !== undefined
                        ? { online: conversation.members.some((m) => m.id === peer.id && m.presence === "online") }
                        : {})}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {titleOf(conversation, user?.id)}
                      </span>
                      <span className="block truncate text-xs text-lo">
                        {conversation.kind === "group"
                          ? `${conversation.members.length} members`
                          : `@${peer?.username ?? "unknown"}`}
                      </span>
                    </span>
                    {conversation.unreadCount > 0 && (
                      <span className="tabular rounded-full bg-cyan px-1.5 py-0.5 text-[11px] font-semibold text-ink-900">
                        {conversation.unreadCount}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

    </div>
  );
}
