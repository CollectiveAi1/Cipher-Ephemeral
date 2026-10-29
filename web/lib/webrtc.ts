import type { CallKind } from "../../shared/protocol.ts";

/**
 * One peer connection for a one-to-one call.
 *
 * Media is encrypted by DTLS-SRTP, which WebRTC does regardless. What Cipher adds is
 * that the *signalling* — SDP and ICE candidates, which carry network addresses — is
 * sealed under the conversation key before it reaches the server (see `sealSignal`).
 *
 * Negotiation follows the "perfect negotiation" pattern: the caller is impolite and the
 * callee is polite, so simultaneous offers resolve without a deadlock.
 */

export type SignalMessage =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

type PeerHandlers = {
  /** A signal to seal and send to the peer. */
  onSignal: (signal: SignalMessage) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
};

export type CallPeer = {
  /** Captures local media and, for the caller, makes the first offer. */
  open: (kind: CallKind, polite: boolean) => Promise<MediaStream>;
  accept: (signal: SignalMessage) => Promise<void>;
  setMuted: (muted: boolean) => void;
  setCameraOff: (off: boolean) => void;
  close: () => void;
};

export function createPeer(iceServers: readonly string[], handlers: PeerHandlers): CallPeer {
  const connection = new RTCPeerConnection({
    iceServers: iceServers.length === 0 ? [] : [{ urls: [...iceServers] }],
  });

  let localStream: MediaStream | null = null;
  let polite = false;
  let makingOffer = false;
  let ignoreOffer = false;

  connection.addEventListener("icecandidate", (event) => {
    if (event.candidate !== null) handlers.onSignal({ kind: "candidate", candidate: event.candidate.toJSON() });
  });

  connection.addEventListener("track", (event) => {
    const [stream] = event.streams;
    if (stream !== undefined) handlers.onRemoteStream(stream);
  });

  connection.addEventListener("connectionstatechange", () => {
    handlers.onConnectionState(connection.connectionState);
  });

  connection.addEventListener("negotiationneeded", () => {
    void (async () => {
      try {
        makingOffer = true;
        await connection.setLocalDescription();
        if (connection.localDescription !== null) {
          handlers.onSignal({ kind: "description", description: connection.localDescription.toJSON() });
        }
      } finally {
        makingOffer = false;
      }
    })();
  });

  return {
    async open(kind, isPolite) {
      polite = isPolite;
      // Adding tracks fires negotiationneeded, which is what produces the first offer.
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === "video",
      });
      for (const track of localStream.getTracks()) connection.addTrack(track, localStream);
      return localStream;
    },

    async accept(signal) {
      if (signal.kind === "candidate") {
        try {
          await connection.addIceCandidate(signal.candidate);
        } catch (error) {
          // A candidate for an offer we chose to ignore is expected, not a failure.
          if (!ignoreOffer) throw error;
        }
        return;
      }

      const description = signal.description;
      const offerCollision =
        description.type === "offer" && (makingOffer || connection.signalingState !== "stable");

      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;

      await connection.setRemoteDescription(description);
      if (description.type === "offer") {
        await connection.setLocalDescription();
        if (connection.localDescription !== null) {
          handlers.onSignal({ kind: "description", description: connection.localDescription.toJSON() });
        }
      }
    },

    setMuted(muted) {
      for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
    },

    setCameraOff(off) {
      for (const track of localStream?.getVideoTracks() ?? []) track.enabled = !off;
    },

    close() {
      for (const track of localStream?.getTracks() ?? []) track.stop();
      localStream = null;
      connection.close();
    },
  };
}
