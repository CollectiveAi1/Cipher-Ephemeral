import { useEffect, useRef } from "react";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { peerOf, titleOf } from "./ConversationList.tsx";
import { CallIcon, HangUpIcon, MicIcon, MicOffIcon, VideoIcon } from "./Icons.tsx";

/** Binds a MediaStream to a video element without re-rendering on every frame. */
function useStream(stream: MediaStream | null) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.srcObject = stream;
  }, [stream]);
  return ref;
}

const CONNECTION_LABELS: Partial<Record<RTCPeerConnectionState, string>> = {
  new: "Connecting…",
  connecting: "Connecting…",
  disconnected: "Reconnecting…",
  failed: "Connection failed",
};

/**
 * The call surface: a ringing prompt before it is answered, and the live call after.
 * Shown over everything, because a call is the only thing you are doing while it runs.
 */
export function CallOverlay() {
  const { state, user, callMedia, acceptCall, declineCall, hangUp, toggleMute, toggleCamera } = useCipher();
  const call = state.activeCall;

  const remoteRef = useStream(callMedia.remoteStream);
  const localRef = useStream(callMedia.localStream);

  if (call === null) return null;

  const conversation = state.conversations.find((item) => item.id === call.conversationId);
  const peer = conversation === undefined ? undefined : peerOf(conversation, user?.id);
  const title = conversation === undefined ? "Unknown" : titleOf(conversation, user?.id);

  const incoming = call.status === "ringing" && call.initiatorId !== user?.id;
  const isVideo = call.kind === "video";
  const statusLabel =
    call.status === "ringing"
      ? incoming
        ? `Incoming ${call.kind} call`
        : "Ringing…"
      : (CONNECTION_LABELS[callMedia.connection] ?? "Connected");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${call.kind} call with ${title}`}
      className="fixed inset-0 z-60 flex flex-col bg-ink-900/95 backdrop-blur-sm"
    >
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {isVideo && callMedia.remoteStream !== null ? (
          <video ref={remoteRef} autoPlay playsInline className="h-full w-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-4 text-center">
            <Avatar name={title} hue={peer?.avatarHue ?? 210} size={112} />
            <div>
              <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
              <p className="mt-1 text-sm text-lo">{statusLabel}</p>
            </div>
          </div>
        )}

        {isVideo && callMedia.localStream !== null && (
          <video
            ref={localRef}
            autoPlay
            playsInline
            muted
            className="absolute right-4 bottom-4 w-32 rounded-xl border border-edge object-cover shadow-lg sm:w-44"
          />
        )}

        {isVideo && callMedia.remoteStream !== null && (
          <p className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-ink-900/70 px-3 py-1 text-xs">
            {title} · {statusLabel}
          </p>
        )}
      </div>

      <div className="flex items-center justify-center gap-3 border-t border-edge bg-ink-800/80 px-6 py-5">
        {incoming ? (
          <>
            <button
              type="button"
              onClick={declineCall}
              className="flex size-14 items-center justify-center rounded-full bg-red text-hi"
              aria-label="Decline"
            >
              <HangUpIcon className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={acceptCall}
              className="flex size-14 items-center justify-center rounded-full bg-teal text-ink-900"
              aria-label="Accept"
            >
              {isVideo ? <VideoIcon className="h-6 w-6" /> : <CallIcon className="h-6 w-6" />}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={callMedia.muted}
              aria-label={callMedia.muted ? "Unmute" : "Mute"}
              className={`flex size-12 items-center justify-center rounded-full border border-edge ${
                callMedia.muted ? "bg-hi text-ink-900" : "text-hi hover:bg-ink-700"
              }`}
            >
              {callMedia.muted ? <MicOffIcon className="h-5 w-5" /> : <MicIcon className="h-5 w-5" />}
            </button>

            {isVideo && (
              <button
                type="button"
                onClick={toggleCamera}
                aria-pressed={callMedia.cameraOff}
                aria-label={callMedia.cameraOff ? "Turn camera on" : "Turn camera off"}
                className={`flex size-12 items-center justify-center rounded-full border border-edge ${
                  callMedia.cameraOff ? "bg-hi text-ink-900" : "text-hi hover:bg-ink-700"
                }`}
              >
                <VideoIcon className="h-5 w-5" />
              </button>
            )}

            <button
              type="button"
              onClick={hangUp}
              className="flex size-14 items-center justify-center rounded-full bg-red text-hi"
              aria-label="Hang up"
            >
              <HangUpIcon className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

      <p className="pb-4 text-center text-[11px] text-lo">
        Media is end-to-end encrypted. This call leaves a record that burns in a day.
      </p>
    </div>
  );
}
