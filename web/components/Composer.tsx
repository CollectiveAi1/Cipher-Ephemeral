import { useCallback, useEffect, useRef, useState } from "react";
import type { BurnMode, Conversation } from "../../shared/protocol.ts";
import { formatLifespan } from "../../shared/burn-scale.ts";
import { MAX_MEDIA_BYTES } from "../../shared/protocol.ts";
import { useCipher } from "../lib/store.tsx";
import { BurnDial } from "./BurnDial.tsx";
import { CloseIcon, PaperclipIcon, SendIcon } from "./Icons.tsx";

/**
 * Mounted with a key of the conversation id, so switching conversations resets the
 * composer to that conversation's burn defaults — and drops any half-typed draft
 * rather than carrying it to a different recipient.
 */
type ComposerProps = {
  conversation: Conversation;
  replyToId: string | null;
  onClearReply: () => void;
};

const MAX_TEXTAREA_HEIGHT_PX = 160;

export function Composer({ conversation, replyToId, onClearReply }: ComposerProps) {
  const { send, notifyTyping, state } = useCipher();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ttlSeconds, setTtlSeconds] = useState(conversation.defaultTtlSeconds);
  const [burnMode, setBurnMode] = useState<BurnMode>(conversation.defaultBurnMode);
  const [sizeError, setSizeError] = useState<string | null>(null);

  // A channel inherits its community's retention ceiling, so the dial cannot offer a
  // lifespan the server would clamp anyway.
  const ceiling =
    conversation.communityId === null
      ? state.maxTtlSeconds
      : (state.communities.find((item) => item.id === conversation.communityId)?.maxTtlSeconds ??
        state.maxTtlSeconds);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /**
   * Grows the textarea to fit its content. Skipped while the element has no layout —
   * mounting inside a hidden container would otherwise measure a zero-width box, wrap
   * the text into hundreds of lines, and persist the maximum height.
   */
  const autosize = useCallback(() => {
    const element = textarea.current;
    if (element === null || element.clientWidth === 0) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(MAX_TEXTAREA_HEIGHT_PX, element.scrollHeight)}px`;
  }, []);

  useEffect(autosize, [autosize, text]);

  // Re-measure when the available width changes: becoming visible, or a window resize.
  // Height-only changes are ignored, so adjusting the height cannot feed back.
  useEffect(() => {
    const element = textarea.current;
    if (element === null) return undefined;

    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      autosize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [autosize]);

  // Sending is an HTTP request, so it does not wait on the socket. A reconnecting
  // socket delays delivery notifications, not the ability to send.
  const canSend = text.trim() !== "" || file !== null;

  const submit = async () => {
    if (!canSend) return;
    const payload = { text: text.trim(), ttlSeconds, burnMode, replyToId, file };
    setText("");
    setFile(null);
    onClearReply();
    if (fileInput.current !== null) fileInput.current.value = "";
    await send(payload);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    if (picked !== null && picked.size > MAX_MEDIA_BYTES) {
      setSizeError(`Attachments are capped at ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB.`);
      event.target.value = "";
      return;
    }
    setSizeError(null);
    setFile(picked);
  };

  return (
    <div className="border-t border-edge bg-ink-800/80 px-4 py-3 backdrop-blur-md">
      {replyToId !== null && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-edge bg-ink-900 px-3 py-1.5 text-xs text-lo">
          <span>Replying to a message</span>
          <button type="button" onClick={onClearReply} aria-label="Cancel reply" className="ml-auto hover:text-hi">
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/*
        Two columns, two rows. On a narrow screen the dial sits beside the burn-mode
        controls and the input spans the full width beneath them; from `sm` up the dial
        spans both rows on the left. One markup tree, no duplicated input.
      */}
      <div className="grid grid-cols-[auto_1fr] items-end gap-x-3 gap-y-2">
        <div className="sm:row-span-2">
          <BurnDial seconds={Math.min(ttlSeconds, ceiling)} onChange={setTtlSeconds} maxSeconds={ceiling} />
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {(["absolute", "onRead"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBurnMode(mode)}
                aria-pressed={burnMode === mode}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  burnMode === mode
                    ? "border-cyan bg-cyan/10 text-cyan"
                    : "border-edge text-lo hover:border-lo hover:text-hi"
                }`}
              >
                {mode === "absolute" ? "From send" : "From first read"}
              </button>
            ))}
            <span className="tabular ml-auto text-[11px] text-lo">
              {burnMode === "absolute"
                ? `burns ${formatLifespan(ttlSeconds)} after sending`
                : `burns ${formatLifespan(ttlSeconds)} after it is opened`}
            </span>
          </div>

        </div>

        <div className="col-span-2 min-w-0 sm:col-span-1">
          <div className="flex items-end gap-2 rounded-xl border border-edge bg-ink-900 px-2 py-1.5 focus-within:border-cyan">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label="Attach an encrypted file"
              className="flex size-11 items-center justify-center rounded-lg text-lo hover:bg-ink-700 hover:text-hi sm:size-9"
            >
              <PaperclipIcon />
            </button>
            <input ref={fileInput} type="file" onChange={onPickFile} className="hidden" />

            <textarea
              ref={textarea}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                notifyTyping(conversation.id);
              }}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={`Message ${conversation.kind === "group" ? conversation.name ?? "the group" : "securely"}…`}
              aria-label="Message"
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-sm text-hi placeholder:text-lo/60 focus:outline-none"
            />

            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="Send"
              className="flex size-11 items-center justify-center rounded-lg bg-cyan text-ink-900 transition-transform disabled:scale-0 disabled:opacity-0 sm:size-9"
            >
              <SendIcon />
            </button>
          </div>

          {file !== null && (
            <p className="mt-1.5 flex items-center gap-2 text-[11px] text-lo">
              <span className="truncate">{file.name}</span>
              <button type="button" onClick={() => setFile(null)} className="hover:text-hi">
                remove
              </button>
            </p>
          )}
          {sizeError !== null && <p className="mt-1.5 text-[11px] text-red">{sizeError}</p>}
        </div>
      </div>
    </div>
  );
}
