import { useEffect, useRef, useState } from "react";
import type { PublicUser } from "../../shared/protocol.ts";
import { useCipher } from "../lib/store.tsx";
import { Avatar } from "./Avatar.tsx";
import { CloseIcon } from "./Icons.tsx";

type NewConversationDialogProps = {
  onClose: () => void;
};

const SEARCH_DEBOUNCE_MS = 200;

export function NewConversationDialog({ onClose }: NewConversationDialogProps) {
  const { searchDirectory, startDm, startGroup } = useCipher();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [groupName, setGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void searchDirectory(query)
        .then(setResults)
        .catch(() => setResults([]));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, searchDirectory]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (person: PublicUser) => {
    setSelected((current) =>
      current.some((item) => item.id === person.id)
        ? current.filter((item) => item.id !== person.id)
        : [...current, person],
    );
  };

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      if (selected.length === 1 && groupName.trim() === "") {
        const [only] = selected;
        if (only !== undefined) await startDm(only);
      } else if (selected.length >= 1) {
        if (groupName.trim() === "") {
          setError("Give the group a name.");
          return;
        }
        await startGroup(groupName.trim(), selected);
      } else {
        setError("Pick at least one person.");
        return;
      }
      onClose();
    } catch {
      setError("That conversation could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New conversation"
      onMouseDown={(event) => {
        if (!dialog.current?.contains(event.target as Node)) onClose();
      }}
    >
      <div ref={dialog} className="w-full max-w-md rounded-2xl border border-edge bg-ink-800 p-5">
        <div className="mb-4 flex items-center">
          <h2 className="text-sm font-semibold">New conversation</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-lo hover:text-hi">
            <CloseIcon />
          </button>
        </div>

        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people by username"
          aria-label="Search people"
          autoFocus
          className="mb-3 w-full rounded-lg border border-edge bg-ink-900 px-3 py-2 text-sm placeholder:text-lo/60 focus:border-cyan focus:outline-none"
        />

        {selected.length > 1 && (
          <input
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder="Group name"
            aria-label="Group name"
            className="mb-3 w-full rounded-lg border border-edge bg-ink-900 px-3 py-2 text-sm placeholder:text-lo/60 focus:border-cyan focus:outline-none"
          />
        )}

        <ul className="scroll-thin mb-4 max-h-64 overflow-y-auto">
          {results.length === 0 ? (
            <li className="py-6 text-center text-xs text-lo">No one found.</li>
          ) : (
            results.map((person) => {
              const picked = selected.some((item) => item.id === person.id);
              return (
                <li key={person.id}>
                  <button
                    type="button"
                    onClick={() => toggle(person)}
                    aria-pressed={picked}
                    className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left ${
                      picked ? "bg-cyan/10" : "hover:bg-ink-700"
                    }`}
                  >
                    <Avatar name={person.displayName} hue={person.avatarHue} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{person.displayName}</span>
                      <span className="block truncate text-xs text-lo">@{person.username}</span>
                    </span>
                    {picked && <span className="text-xs text-cyan">selected</span>}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        {error !== null && <p className="mb-3 text-xs text-red">{error}</p>}

        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || selected.length === 0}
          className="w-full rounded-lg bg-cyan px-4 py-2.5 text-sm font-semibold text-ink-900 disabled:opacity-40"
        >
          {selected.length > 1 ? "Create group" : "Start conversation"}
        </button>
      </div>
    </div>
  );
}
