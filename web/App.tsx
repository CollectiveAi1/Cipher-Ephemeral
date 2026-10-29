import { useState } from "react";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { CallOverlay } from "./components/CallOverlay.tsx";
import { CallsView } from "./components/CallsView.tsx";
import { CommunitiesView } from "./components/CommunitiesView.tsx";
import { Composer } from "./components/Composer.tsx";
import { ConversationHeader } from "./components/ConversationHeader.tsx";
import { ConversationList } from "./components/ConversationList.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { NavRail } from "./components/NavRail.tsx";
import { NewConversationDialog } from "./components/NewConversationDialog.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { useCipher } from "./lib/store.tsx";

export function App() {
  const { status, state, activeConversation, closeConversation, dismissNotice } = useCipher();
  const [showNew, setShowNew] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);

  if (status !== "ready") return <AuthScreen />;

  // On a phone the panel is the whole screen until a conversation is open; on a desktop
  // it is a fixed rail beside the thread.
  const panelHidden = activeConversation !== null;

  return (
    <div className="flex h-full bg-ink-900">
      <div
        className={`${panelHidden ? "hidden" : "flex"} w-full flex-col border-r border-edge bg-ink-800 sm:flex sm:w-80 sm:shrink-0`}
      >
        <div className="min-h-0 flex-1">
          {state.tab === "chats" && <ConversationList onNewConversation={() => setShowNew(true)} />}
          {state.tab === "calls" && <CallsView />}
          {state.tab === "communities" && <CommunitiesView />}
          {state.tab === "settings" && <SettingsView />}
        </div>
        <NavRail />
      </div>

      <main className={`${panelHidden ? "flex" : "hidden"} min-w-0 flex-1 flex-col sm:flex`}>
        {activeConversation === null ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="max-w-sm text-sm leading-relaxed text-lo">
              Pick a conversation, or start a new one. Every message you send chooses its own lifespan on the dial —
              and when it expires, the ciphertext is deleted from the server.
            </p>
          </div>
        ) : (
          <>
            <ConversationHeader conversation={activeConversation} onBack={closeConversation} />
            <MessageList conversation={activeConversation} onReply={setReplyToId} />
            <Composer
              key={activeConversation.id}
              conversation={activeConversation}
              replyToId={replyToId}
              onClearReply={() => setReplyToId(null)}
            />
          </>
        )}
      </main>

      {showNew && <NewConversationDialog onClose={() => setShowNew(false)} />}
      <CallOverlay />

      {state.notice !== null && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-red/40 bg-ink-800 px-4 py-2.5 text-xs shadow-lg"
        >
          {state.notice}
          <button type="button" onClick={dismissNotice} className="text-lo hover:text-hi">
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}
