import { formatLifespan } from "../../shared/burn-scale.ts";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { ShieldIcon } from "./Icons.tsx";

export function SettingsView() {
  const { state, user, signOut } = useCipher();

  const connectionLabel =
    state.connection === "online" ? "Connected" : state.connection === "connecting" ? "Connecting…" : "Offline";

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge px-4 py-3">
        <h1 className="font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-edge px-4 py-4">
          <Avatar name={user?.displayName ?? "?"} hue={user?.avatarHue ?? 210} size={48} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user?.displayName}</p>
            <p className="truncate text-xs text-lo">@{user?.username}</p>
          </div>
        </div>

        <section className="border-b border-edge px-4 py-3">
          <h2 className="mb-2 text-[11px] font-medium tracking-wide text-lo uppercase">Connection</h2>
          <p className="flex items-center gap-2 text-sm">
            <span className={state.connection === "online" ? "text-teal" : "text-lo"}>●</span>
            {connectionLabel}
          </p>
          <p className="mt-1 text-[11px] text-lo">
            Messages send over HTTP whether or not the live connection is up; it only carries delivery and presence.
          </p>
        </section>

        <section className="border-b border-edge px-4 py-3">
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-lo uppercase">
            <ShieldIcon className="h-3 w-3" />
            Encryption
          </h2>
          <ul className="space-y-1.5 text-xs leading-relaxed text-lo">
            <li>Your identity key is held in memory only and rebuilt from your password each time you open Cipher.</li>
            <li>The server stores ciphertext and wrapped keys. It cannot read a message or open an attachment.</li>
            <li>Call media is end-to-end encrypted, and the signalling that sets it up is sealed too.</li>
            <li>
              A recipient can still screenshot what they can read. Ephemerality is an agreement Cipher makes easy to
              keep, not one it can enforce on a determined peer.
            </li>
          </ul>
        </section>

        <section className="border-b border-edge px-4 py-3">
          <h2 className="mb-2 text-[11px] font-medium tracking-wide text-lo uppercase">Retention</h2>
          <p className="text-xs leading-relaxed text-lo">
            This workspace caps every message at{" "}
            <span className="text-hi">{formatLifespan(state.maxTtlSeconds)}</span>. Communities can set a shorter
            ceiling for their own channels, and each message still picks its own lifespan on the dial.
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-lo">
            Call records are kept for a day and then deleted.
          </p>
        </section>

        <div className="px-4 py-4">
          <button
            type="button"
            onClick={() => void signOut()}
            className="w-full rounded-lg border border-red/40 px-3 py-2 text-xs font-medium text-red hover:bg-red/10"
          >
            Sign out
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-lo">
            Signing out clears your key from this device. Your password rebuilds it next time.
          </p>
        </div>
      </div>
    </div>
  );
}
