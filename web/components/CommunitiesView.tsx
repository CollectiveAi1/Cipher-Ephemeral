import { useEffect, useState } from "react";
import type { Community, PublicUser } from "../../shared/protocol.ts";
import { formatLifespan, NOTCH_SECONDS } from "../../shared/burn-scale.ts";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { CommunityIcon, PlusIcon, ShieldIcon } from "./Icons.tsx";

export function CommunitiesView() {
  const { state, openConversation, createCommunity, createChannel, updateCommunity, leaveCommunity, addCommunityMember } =
    useCipher();
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch {
      setError("That did not work. Try again.");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-edge px-4 py-3">
        <h1 className="font-semibold tracking-tight">Communities</h1>
        <button
          type="button"
          onClick={() => setCreating((open) => !open)}
          aria-expanded={creating}
          aria-label="New community"
          className="ml-auto rounded-lg border border-edge p-1.5 text-lo hover:border-cyan hover:text-cyan"
        >
          <PlusIcon />
        </button>
      </header>

      {creating && (
        <NewCommunityForm
          onCancel={() => setCreating(false)}
          onCreate={async (name, description, maxTtlSeconds) => {
            await run(() => createCommunity(name, description, maxTtlSeconds));
            setCreating(false);
          }}
        />
      )}

      <div className="scroll-thin flex-1 overflow-y-auto">
        {error !== null && <p className="px-4 py-2 text-xs text-red">{error}</p>}

        {state.communities.length === 0 ? (
          <div className="px-4 py-6">
            <p className="text-xs leading-relaxed text-lo">
              A community groups channels under one retention policy. Whatever ceiling you set, no message in any of
              its channels can outlive it — the server enforces that, not the client.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-edge">
            {state.communities.map((community) => {
              const expanded = expandedId === community.id;
              return (
                <li key={community.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : community.id)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ink-700/40"
                  >
                    <Avatar name={community.name} hue={community.avatarHue} size={38} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{community.name}</span>
                      <span className="block truncate text-xs text-lo">
                        {community.memberCount} {community.memberCount === 1 ? "member" : "members"} ·{" "}
                        {community.channels.length} {community.channels.length === 1 ? "channel" : "channels"}
                      </span>
                    </span>
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber"
                      title="Nothing in this community outlives this"
                    >
                      <ShieldIcon className="h-3 w-3" />
                      {formatLifespan(community.maxTtlSeconds)}
                    </span>
                  </button>

                  {expanded && (
                    <CommunityDetail
                      community={community}
                      onOpenChannel={(channelId) => openConversation(channelId)}
                      onCreateChannel={(name, policy) => run(() => createChannel(community, name, policy))}
                      onCeilingChange={(seconds) =>
                        run(() => updateCommunity(community.id, { maxTtlSeconds: seconds }))
                      }
                      onAddMember={(peer) => run(() => addCommunityMember(community.id, peer))}
                      onLeave={() => run(() => leaveCommunity(community.id))}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

type NewCommunityFormProps = {
  onCreate: (name: string, description: string, maxTtlSeconds: number) => Promise<void>;
  onCancel: () => void;
};

function NewCommunityForm({ onCreate, onCancel }: NewCommunityFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [maxTtlSeconds, setMaxTtlSeconds] = useState(86_400);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || busy) return;
    setBusy(true);
    await onCreate(name.trim(), description.trim(), maxTtlSeconds);
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="space-y-2.5 border-b border-edge bg-ink-900/60 px-4 py-3">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Community name"
        aria-label="Community name"
        autoFocus
        className="w-full rounded-lg border border-edge bg-ink-900 px-3 py-2 text-sm placeholder:text-lo/60 focus:border-cyan focus:outline-none"
      />
      <input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="What is it for?"
        aria-label="Description"
        className="w-full rounded-lg border border-edge bg-ink-900 px-3 py-2 text-sm placeholder:text-lo/60 focus:border-cyan focus:outline-none"
      />

      <label className="flex flex-wrap items-center gap-2 text-xs text-lo">
        Nothing here outlives
        <select
          value={maxTtlSeconds}
          onChange={(event) => setMaxTtlSeconds(Number(event.target.value))}
          className="rounded-md border border-edge bg-ink-900 px-2 py-1 text-xs text-hi"
        >
          {NOTCH_SECONDS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {formatLifespan(seconds)}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || name.trim() === ""}
          className="flex-1 rounded-lg bg-cyan px-3 py-2 text-xs font-semibold text-ink-900 disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create community"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-edge px-3 py-2 text-xs text-lo">
          Cancel
        </button>
      </div>
    </form>
  );
}

type CommunityDetailProps = {
  community: Community;
  onOpenChannel: (channelId: string) => void;
  onCreateChannel: (name: string, postPolicy: "all" | "admins") => Promise<void>;
  onCeilingChange: (seconds: number) => Promise<void>;
  onAddMember: (peer: PublicUser) => Promise<void>;
  onLeave: () => Promise<void>;
};

function CommunityDetail({
  community,
  onOpenChannel,
  onCreateChannel,
  onCeilingChange,
  onAddMember,
  onLeave,
}: CommunityDetailProps) {
  const [channelName, setChannelName] = useState("");
  const [announcement, setAnnouncement] = useState(false);
  const isAdmin = community.role === "admin";

  return (
    <div className="space-y-3 border-t border-edge bg-ink-900/40 px-4 py-3">
      {community.description !== "" && <p className="text-xs leading-relaxed text-lo">{community.description}</p>}

      <div>
        <p className="mb-1.5 text-[11px] font-medium tracking-wide text-lo uppercase">Channels</p>
        {community.channels.length === 0 ? (
          <p className="text-xs text-lo">No channels yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {community.channels.map((channel) => (
              <li key={channel.id}>
                <button
                  type="button"
                  onClick={() => onOpenChannel(channel.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink-700"
                >
                  <CommunityIcon className="h-3.5 w-3.5 shrink-0 text-lo" />
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {channel.postPolicy === "admins" && (
                    <span className="shrink-0 text-[10px] text-amber">announcements</span>
                  )}
                  {channel.unreadCount > 0 && (
                    <span className="tabular shrink-0 rounded-full bg-cyan px-1.5 text-[10px] font-semibold text-ink-900">
                      {channel.unreadCount}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-medium tracking-wide text-lo uppercase">Members</p>
        <ul className="flex flex-wrap gap-1.5">
          {community.members.map((member) => (
            <li key={member.id} className="flex items-center gap-1.5 rounded-full border border-edge px-2 py-1 text-xs">
              <Avatar name={member.displayName} hue={member.avatarHue} size={16} />
              {member.displayName}
              {member.role === "admin" && <span className="text-[10px] text-lo">admin</span>}
            </li>
          ))}
        </ul>
      </div>

      {isAdmin && <AddMemberField community={community} onAdd={onAddMember} />}

      {isAdmin && (
        <>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (channelName.trim() === "") return;
              const name = channelName.trim();
              setChannelName("");
              await onCreateChannel(name, announcement ? "admins" : "all");
            }}
            className="space-y-2"
          >
            <input
              value={channelName}
              onChange={(event) => setChannelName(event.target.value)}
              placeholder="New channel name"
              aria-label="New channel name"
              className="w-full rounded-lg border border-edge bg-ink-900 px-3 py-1.5 text-xs placeholder:text-lo/60 focus:border-cyan focus:outline-none"
            />
            <label className="flex items-center gap-2 text-[11px] text-lo">
              <input
                type="checkbox"
                checked={announcement}
                onChange={(event) => setAnnouncement(event.target.checked)}
                className="accent-cyan"
              />
              Announcements only — admins post, everyone reads
            </label>
            <button
              type="submit"
              disabled={channelName.trim() === ""}
              className="w-full rounded-lg border border-edge px-3 py-1.5 text-xs text-hi hover:border-cyan disabled:opacity-40"
            >
              Add channel
            </button>
          </form>

          <label className="flex flex-wrap items-center gap-2 text-xs text-lo">
            Retention ceiling
            <select
              value={community.maxTtlSeconds}
              onChange={(event) => void onCeilingChange(Number(event.target.value))}
              className="rounded-md border border-edge bg-ink-900 px-2 py-1 text-xs text-hi"
            >
              {NOTCH_SECONDS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {formatLifespan(seconds)}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] leading-relaxed text-lo">
            Lowering this binds every new message. Messages already sent keep the lifespan their sender was promised.
          </p>
        </>
      )}

      <button type="button" onClick={() => void onLeave()} className="text-xs text-red hover:underline">
        Leave community
      </button>
    </div>
  );
}

type AddMemberFieldProps = {
  community: Community;
  onAdd: (peer: PublicUser) => Promise<void>;
};

/**
 * Adding someone hands them the key to each existing channel this admin can open, as
 * well as any channel made later — so joining the community is what grants access.
 */
function AddMemberField({ community, onAdd }: AddMemberFieldProps) {
  const { searchDirectory } = useCipher();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query.trim() === "") {
        setResults([]);
        return;
      }
      void searchDirectory(query)
        .then((people) => setResults(people.filter((person) => !community.members.some((m) => m.id === person.id))))
        .catch(() => setResults([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [community.members, query, searchDirectory]);

  // Derived rather than stored, so an empty box never shows a stale list mid-debounce.
  const visible = query.trim() === "" ? [] : results.slice(0, 5);

  return (
    <div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Add someone by username"
        aria-label="Add a community member"
        className="w-full rounded-lg border border-edge bg-ink-900 px-3 py-1.5 text-xs placeholder:text-lo/60 focus:border-cyan focus:outline-none"
      />
      {visible.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {visible.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                onClick={async () => {
                  setQuery("");
                  setResults([]);
                  await onAdd(person);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-ink-700"
              >
                <Avatar name={person.displayName} hue={person.avatarHue} size={20} />
                <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
                <span className="text-lo">@{person.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
