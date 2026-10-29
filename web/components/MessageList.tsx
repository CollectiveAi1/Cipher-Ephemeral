import { useEffect, useLayoutEffect, useRef } from "react";
import type { Conversation } from "../../shared/protocol.ts";
import { useTick } from "../lib/clock.tsx";
import { useCipher } from "../lib/store.tsx";
import { MessageBubble } from "./MessageBubble.tsx";

type MessageListProps = {
  conversation: Conversation;
  onReply: (messageId: string) => void;
};

/** Distance from the bottom within which new messages should auto-scroll. */
const STICK_THRESHOLD_PX = 120;

export function MessageList({ conversation, onReply }: MessageListProps) {
  const { state, user, loadOlder } = useCipher();
  const tick = useTick();
  const scroller = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const messages = state.messages[conversation.id] ?? [];
  const hasOlder = state.cursors[conversation.id] != null;
  const serverNow = tick + state.clockOffsetMs;

  const typingNames = Object.keys(state.typing[conversation.id] ?? {})
    .map((userId) => conversation.members.find((member) => member.id === userId)?.displayName)
    .filter((name): name is string => name !== undefined);

  // Tracked before paint so a new message does not yank the view away from someone
  // who has scrolled up to read history.
  const handleScroll = () => {
    const element = scroller.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < STICK_THRESHOLD_PX;
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, conversation.id]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [conversation.id]);

  return (
    <div
      ref={scroller}
      onScroll={handleScroll}
      className="scroll-thin flex-1 overflow-y-auto overscroll-contain px-4 py-4"
    >
      {hasOlder && (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={() => void loadOlder(conversation.id)}
            className="rounded-full border border-edge px-3 py-1 text-xs text-lo hover:border-cyan hover:text-hi"
          >
            Load earlier messages
          </button>
        </div>
      )}

      {messages.length === 0 ? (
        <p className="py-12 text-center text-sm text-lo">
          Nothing here yet. Pick a lifespan on the dial and say something.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {messages.map((message) => {
            // A quoted message that is no longer in the list has burned; one that is
            // present but undecrypted is simply still being opened.
            const parent =
              message.replyToId === null
                ? undefined
                : messages.find((candidate) => candidate.id === message.replyToId);
            const replyPreview =
              message.replyToId === null
                ? null
                : parent === undefined
                  ? "The original message has already burned."
                  : (state.bodies[parent.id]?.text ?? "Decrypting…");
            return (
              <li key={message.id} className="animate-rise">
                <MessageBubble
                  message={message}
                  body={state.bodies[message.id]}
                  sender={conversation.members.find((member) => member.id === message.senderId)}
                  isSelf={message.senderId === user?.id}
                  isGroup={conversation.kind === "group"}
                  serverNow={serverNow}
                  replyPreview={replyPreview}
                  onReply={onReply}
                />
              </li>
            );
          })}
        </ol>
      )}

      {typingNames.length > 0 && (
        <p className="mt-3 px-1 text-xs italic text-lo" aria-live="polite">
          {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing…
        </p>
      )}
    </div>
  );
}
