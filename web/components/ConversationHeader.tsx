import { useState } from "react";
import type { Conversation } from "../../shared/protocol.ts";
import { formatLifespan, NOTCH_SECONDS } from "../../shared/burn-scale.ts";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { peerOf, titleOf } from "./ConversationList.tsx";
import { CallIcon, ShieldIcon, VideoIcon } from "./Icons.tsx";

type ConversationHeaderProps = {
  conversation: Conversation;
  onBack: () => void;
};

export function ConversationHeader({ conversation, onBack }: ConversationHeaderProps) {
  const { user, updateConversation, leave, startCall } = useCipher();
  const [showDetails, setShowDetails] = useState(false);

  const peer = peerOf(conversation, user?.id);
  const online =
    conversation.kind === "dm"
      ? conversation.members.some((member) => member.id === peer?.id && member.presence === "online")
      : conversation.members.some((member) => member.id !== user?.id && member.presence === "online");

  return (
    <header className="border-b border-edge bg-ink-800/70 backdrop-blur-md">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-11 items-center rounded-lg border border-edge px-3 text-xs text-lo hover:text-hi sm:hidden"
        >
          Back
        </button>

        <Avatar
          name={titleOf(conversation, user?.id)}
          hue={conversation.kind === "group" ? 265 : (peer?.avatarHue ?? 210)}
          size={34}
        />

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{titleOf(conversation, user?.id)}</h2>
          <p className="truncate text-xs text-lo">
            {conversation.kind === "group"
              ? `${conversation.members.length} members`
              : online
                ? "Online"
                : "Offline"}
            {" · default "}
            {formatLifespan(conversation.defaultTtlSeconds)}
            {conversation.communityId !== null && " · community policy"}
          </p>
        </div>

        {/* Calls are one-to-one for now, so the buttons appear only on direct messages. */}
        {conversation.kind === "dm" && conversation.members.length === 2 && (
          <>
            <button
              type="button"
              onClick={() => startCall(conversation.id, "audio")}
              aria-label="Start a voice call"
              className="flex size-10 items-center justify-center rounded-lg text-lo hover:bg-ink-700 hover:text-cyan sm:size-9"
            >
              <CallIcon />
            </button>
            <button
              type="button"
              onClick={() => startCall(conversation.id, "video")}
              aria-label="Start a video call"
              className="flex size-10 items-center justify-center rounded-lg text-lo hover:bg-ink-700 hover:text-cyan sm:size-9"
            >
              <VideoIcon />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => setShowDetails((open) => !open)}
          aria-expanded={showDetails}
          className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs text-lo hover:border-cyan hover:text-cyan"
        >
          <ShieldIcon className="h-3.5 w-3.5" />
          Security
        </button>
      </div>

      {showDetails && (
        <div className="space-y-3 border-t border-edge px-4 py-3 text-xs">
          <p className="leading-relaxed text-lo">
            Messages are encrypted on this device with a key the server never holds. Expired messages are deleted
            from the server, not hidden. A recipient can still screenshot what they can read — ephemerality is an
            agreement this app makes easy to keep, not one it can enforce.
          </p>

          <label className="flex flex-wrap items-center gap-2">
            <span className="text-lo">Default lifespan for this conversation</span>
            <select
              value={conversation.defaultTtlSeconds}
              onChange={(event) =>
                void updateConversation(conversation.id, { defaultTtlSeconds: Number(event.target.value) })
              }
              className="rounded-md border border-edge bg-ink-900 px-2 py-1 text-xs"
            >
              {NOTCH_SECONDS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {formatLifespan(seconds)}
                </option>
              ))}
            </select>
          </label>

          <div>
            <p className="mb-1.5 text-lo">Members</p>
            <ul className="flex flex-wrap gap-1.5">
              {conversation.members.map((member) => (
                <li
                  key={member.id}
                  className="flex items-center gap-1.5 rounded-full border border-edge px-2 py-1"
                >
                  <span className={member.presence === "online" ? "text-teal" : "text-lo"}>●</span>
                  {member.displayName}
                  {member.role === "admin" && <span className="text-lo">admin</span>}
                </li>
              ))}
            </ul>
          </div>

          <button
            type="button"
            onClick={() => void leave(conversation.id)}
            className="text-red hover:underline"
          >
            Leave conversation
          </button>
        </div>
      )}
    </header>
  );
}
