import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const TickContext = createContext<number>(Date.now());

/**
 * One interval drives every countdown on screen. A timer per message bubble would be
 * hundreds of timers in a busy conversation, which is what the 60fps budget forbids.
 */
export function TickProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <TickContext.Provider value={tick}>{children}</TickContext.Provider>;
}

/** Current client time, refreshed once a second. */
export function useTick(): number {
  return useContext(TickContext);
}
