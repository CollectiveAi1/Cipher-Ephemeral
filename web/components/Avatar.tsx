type AvatarProps = {
  name: string;
  hue: number;
  size?: number;
  online?: boolean;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** Generated avatar from the server-assigned hue, so every client renders it alike. */
export function Avatar({ name, hue, size = 36, online }: AvatarProps) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        aria-hidden="true"
        className="flex h-full w-full items-center justify-center rounded-full font-semibold"
        style={{
          fontSize: size * 0.38,
          background: `linear-gradient(140deg, hsl(${hue} 70% 32%), hsl(${(hue + 40) % 360} 65% 20%))`,
          color: `hsl(${hue} 90% 88%)`,
          boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 45% / 0.45)`,
        }}
      >
        {initials(name)}
      </span>
      {online !== undefined && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-ink-800 ${
            online ? "bg-teal" : "bg-edge"
          }`}
          style={{ width: size * 0.3, height: size * 0.3 }}
          title={online ? "Online" : "Offline"}
        />
      )}
    </span>
  );
}
