import { TABS, type Tab } from "../lib/reducer.ts";
import { useCipher } from "../lib/store.tsx";
import { CallIcon, CommunityIcon, SettingsIcon, ChatIcon } from "./Icons.tsx";

const LABELS: Record<Tab, string> = {
  chats: "Chats",
  calls: "Calls",
  communities: "Communities",
  settings: "Settings",
};

const ICONS: Record<Tab, (props: { className?: string }) => React.ReactElement> = {
  chats: ChatIcon,
  calls: CallIcon,
  communities: CommunityIcon,
  settings: SettingsIcon,
};

/**
 * The section switcher. Sits at the foot of the left panel so it stays reachable with a
 * thumb on a phone and out of the way of the conversation on a desktop.
 */
export function NavRail() {
  const { state, setTab } = useCipher();

  const unread = state.conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);
  const missed = state.calls.filter(
    (entry) => entry.status === "missed" && entry.initiatorId !== null,
  ).length;

  const badgeFor = (tab: Tab) => (tab === "chats" ? unread : tab === "calls" ? missed : 0);

  return (
    <nav aria-label="Sections" className="border-t border-edge bg-ink-800">
      <ul className="flex">
        {TABS.map((tab) => {
          const Icon = ICONS[tab];
          const active = state.tab === tab;
          const badge = badgeFor(tab);
          return (
            <li key={tab} className="flex-1">
              <button
                type="button"
                onClick={() => setTab(tab)}
                aria-current={active ? "page" : undefined}
                className={`relative flex h-16 w-full flex-col items-center justify-center gap-1 transition-colors ${
                  active ? "text-cyan" : "text-lo hover:text-hi"
                }`}
              >
                <span
                  className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${
                    active ? "bg-cyan/12" : ""
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-[10px] font-medium">{LABELS[tab]}</span>
                {badge > 0 && (
                  <span className="tabular absolute top-2 right-1/2 translate-x-5 rounded-full bg-cyan px-1.5 text-[10px] font-semibold text-ink-900">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
