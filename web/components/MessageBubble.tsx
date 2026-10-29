import { useState } from "react";
import type { ConversationMember } from "../../shared/protocol.ts";
import { formatRemaining } from "../../shared/burn-scale.ts";
import { decayPaint, remainingFraction } from "../../shared/decay.ts";
import type { MessageBody } from "../lib/envelope.ts";
import type { LocalMessage } from "../lib/reducer.ts";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { FlameIcon, ReplyIcon } from "./Icons.tsx";

const QUICK_REACTIONS = ["👍", "🔥", "✅", "👀"];

type MessageBubbleProps = {
  message: LocalMessage;
  body: MessageBody | undefined;
  sender: ConversationMember | undefined;
  isSelf: boolean;
  isGroup: boolean;
  /** Server-corrected clock, so a skewed local clock cannot change a countdown. */
  serverNow: number;
  replyPreview: string | null;
  onReply: (messageId: string) => void;
};

export function MessageBubble({
  message,
  body,
  sender,
  isSelf,
  isGroup,
  serverNow,
  replyPreview,
  onReply,
}: MessageBubbleProps) {
  const { toggleReaction, burn, openAttachmentFor } = useCipher();
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  // An on-read message has no countdown until someone opens it.
  const expiresAt = message.expiresAt;
  const remaining = expiresAt === null ? 1 : remainingFraction(message.sentAt, expiresAt, serverNow);
  const paint = decayPaint(remaining);

  const grouped = message.reactions.reduce<Record<string, number>>((totals, reaction) => {
    totals[reaction.emoji] = (totals[reaction.emoji] ?? 0) + 1;
    return totals;
  }, {});

  const download = async () => {
    setAttachmentError(null);
    try {
      const opened = await openAttachmentFor(message.id);
      if (opened === null) return;
      const anchor = document.createElement("a");
      anchor.href = opened.url;
      anchor.download = opened.name;
      anchor.click();
      // Revoked on the next tick so the click has already been handled.
      window.setTimeout(() => URL.revokeObjectURL(opened.url), 0);
    } catch {
      setAttachmentError("That attachment has already burned.");
    }
  };

  return (
    <div className={`group flex items-end gap-2 ${isSelf ? "flex-row-reverse" : ""}`}>
      {!isSelf && isGroup && (
        <Avatar name={sender?.displayName ?? "Unknown"} hue={sender?.avatarHue ?? 210} size={28} />
      )}

      <div className={`flex max-w-[min(82%,34rem)] flex-col gap-1 ${isSelf ? "items-end" : "items-start"}`}>
        {!isSelf && isGroup && (
          <span className="px-1 text-xs font-semibold text-cyan">{sender?.displayName ?? "Unknown"}</span>
        )}

        {/*
          The decay gradient is the bubble's frame: a padded wrapper painted with the
          gradient, with the body drawn on an opaque inner surface.
        */}
        <div
          className={`rounded-2xl p-[2px] ${paint.pulse ? "animate-breath" : ""} ${message.pending ? "opacity-60" : ""}`}
          style={{ background: `linear-gradient(135deg, ${paint.from}, ${paint.to})` }}
        >
          <div className={`rounded-[14px] px-3.5 py-2.5 ${isSelf ? "bg-[#063343]" : "bg-ink-700"}`}>
            {replyPreview !== null && (
              <p className="mb-1.5 border-l-2 border-edge pl-2 text-xs italic text-lo">{replyPreview}</p>
            )}

            {body === undefined ? (
              <p className="text-sm text-lo">Decrypting…</p>
            ) : (
              <>
                {body.text !== "" && (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{body.text}</p>
                )}
                {body.attachment !== null && (
                  <button
                    type="button"
                    onClick={download}
                    className="mt-1.5 flex w-full items-center gap-2 rounded-lg border border-edge bg-ink-900/60 px-2.5 py-2 text-left text-xs hover:border-cyan"
                  >
                    <span className="truncate font-medium">{body.attachment.name}</span>
                    <span className="tabular ml-auto shrink-0 text-lo">
                      {Math.max(1, Math.round(body.attachment.size / 1024))} KB
                    </span>
                  </button>
                )}
                {body.text === "" && body.attachment === null && (
                  <p className="text-sm italic text-lo">This message could not be decrypted.</p>
                )}
              </>
            )}

            <div className="mt-1.5 flex items-center gap-2">
              <span className="tabular text-[11px]" style={{ color: paint.to }}>
                {message.pending
                  ? "sending…"
                  : expiresAt === null
                    ? "burns when read"
                    : `expires in ${formatRemaining((expiresAt - serverNow) / 1000)}`}
              </span>
              <span className="sr-only">{`Decay stage: ${paint.label}`}</span>
              {isSelf && message.readBy > 0 && (
                <span className="text-[11px] text-lo">{`read${isGroup ? ` · ${message.readBy}` : ""}`}</span>
              )}
            </div>
          </div>
        </div>

        {Object.keys(grouped).length > 0 && (
          <div className="flex flex-wrap gap-1 px-1">
            {Object.entries(grouped).map(([emoji, count]) => (
              <button
                key={emoji}
                type="button"
                onClick={() => void toggleReaction(message.id, emoji)}
                className="rounded-full border border-edge bg-ink-800 px-2 py-0.5 text-xs hover:border-cyan"
              >
                {emoji} {count}
              </button>
            ))}
          </div>
        )}

        {attachmentError !== null && <p className="px-1 text-[11px] text-red">{attachmentError}</p>}

        {!message.pending && (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => void toggleReaction(message.id, emoji)}
                aria-label={`React with ${emoji}`}
                className="rounded-md px-1.5 py-1 text-xs hover:bg-ink-700"
              >
                {emoji}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onReply(message.id)}
              aria-label="Reply"
              className="rounded-md p-1.5 text-lo hover:bg-ink-700 hover:text-hi"
            >
              <ReplyIcon className="h-3.5 w-3.5" />
            </button>
            {isSelf && (
              <button
                type="button"
                onClick={() => void burn(message.id)}
                aria-label="Burn now"
                className="rounded-md p-1.5 text-lo hover:bg-ink-700 hover:text-red"
              >
                <FlameIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
