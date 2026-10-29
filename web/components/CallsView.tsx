import { useMemo, useState } from "react";
import type { Call, Conversation } from "../../shared/protocol.ts";
import { formatRemaining } from "../../shared/burn-scale.ts";
import { useTick } from "../lib/clock.tsx";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { peerOf, titleOf } from "./ConversationList.tsx";
import { CallIcon, VideoIcon } from "./Icons.tsx";

/**
 * Calls are one-to-one for now. Restricted to direct messages rather than any
 * two-person conversation, so a two-member channel does not offer a call that would
 * read as calling the community.
 */
function callableConversations(conversations: readonly Conversation[]): Conversation[] {
  return conversations.filter((conversation) => conversation.kind === "dm" && conversation.members.length === 2);
}

function describe(call: Call, selfId: string | undefined): { label: string; tone: string } {
  const outgoing = call.initiatorId === selfId;
  if (call.status === "missed") return { label: outgoing ? "No answer" : "Missed", tone: "text-red" };
  if (call.status === "declined") return { label: outgoing ? "Declined" : "You declined", tone: "text-lo" };
  if (call.status === "ringing") return { label: "Ringing…", tone: "text-cyan" };
  if (call.status === "active") return { label: "In progress", tone: "text-teal" };
  return { label: outgoing ? "Outgoing" : "Incoming", tone: "text-lo" };
}

function formatWhen(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CallsView() {
  const { state, user, startCall } = useCipher();
  const tick = useTick();
  const [picking, setPicking] = useState(false);

  const serverNow = tick + state.clockOffsetMs;
  const callable = useMemo(() => callableConversations(state.conversations), [state.conversations]);
  const history = state.calls.filter((entry) => entry.expiresAt > serverNow);

  const conversationFor = (call: Call) => state.conversations.find((item) => item.id === call.conversationId);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-edge px-4 py-3">
        <h1 className="font-semibold tracking-tight">Calls</h1>
        <button
          type="button"
          onClick={() => setPicking((open) => !open)}
          aria-expanded={picking}
          className="ml-auto rounded-lg border border-edge p-1.5 text-lo hover:border-cyan hover:text-cyan"
          aria-label="New call"
        >
          <CallIcon />
        </button>
      </header>

      {picking && (
        <div className="border-b border-edge bg-ink-900/60 px-2 py-2">
          <p className="px-2 pb-1.5 text-[11px] text-lo">Pick someone to call</p>
          {callable.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-lo">
              No one to call yet. Start a direct message first — calls are one-to-one.
            </p>
          ) : (
            <ul>
              {callable.map((conversation) => {
                const peer = peerOf(conversation, user?.id);
                return (
                  <li key={conversation.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-ink-700">
                    <Avatar name={titleOf(conversation, user?.id)} hue={peer?.avatarHue ?? 210} size={30} />
                    <span className="min-w-0 flex-1 truncate text-sm">{titleOf(conversation, user?.id)}</span>
                    <button
                      type="button"
                      onClick={() => {
                        startCall(conversation.id, "audio");
                        setPicking(false);
                      }}
                      aria-label={`Call ${titleOf(conversation, user?.id)}`}
                      className="rounded-md p-1.5 text-lo hover:bg-ink-800 hover:text-cyan"
                    >
                      <CallIcon className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        startCall(conversation.id, "video");
                        setPicking(false);
                      }}
                      aria-label={`Video call ${titleOf(conversation, user?.id)}`}
                      className="rounded-md p-1.5 text-lo hover:bg-ink-800 hover:text-cyan"
                    >
                      <VideoIcon className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto">
        <p className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-lo uppercase">Recent</p>

        {history.length === 0 ? (
          <p className="px-4 py-6 text-xs leading-relaxed text-lo">
            No calls. Cipher keeps call records for a day and then deletes them, so this list empties itself.
          </p>
        ) : (
          <ul>
            {history.map((entry) => {
              const conversation = conversationFor(entry);
              const peer = conversation === undefined ? undefined : peerOf(conversation, user?.id);
              const title = conversation === undefined ? "Unknown" : titleOf(conversation, user?.id);
              const { label, tone } = describe(entry, user?.id);
              return (
                <li key={entry.id}>
                  <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-700/40">
                    <Avatar name={title} hue={peer?.avatarHue ?? 210} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{title}</span>
                      <span className={`flex items-center gap-1.5 text-xs ${tone}`}>
                        {entry.kind === "video" ? <VideoIcon className="h-3 w-3" /> : <CallIcon className="h-3 w-3" />}
                        {label}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[11px] text-lo">{formatWhen(entry.startedAt, serverNow)}</span>
                      <span className="tabular block text-[10px] text-lo/70">
                        burns in {formatRemaining((entry.expiresAt - serverNow) / 1000)}
                      </span>
                    </span>
                    {conversation !== undefined && (
                      <button
                        type="button"
                        onClick={() => startCall(conversation.id, entry.kind)}
                        aria-label={`Call ${title} back`}
                        className="rounded-md p-1.5 text-lo hover:bg-ink-800 hover:text-cyan"
                      >
                        <CallIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
