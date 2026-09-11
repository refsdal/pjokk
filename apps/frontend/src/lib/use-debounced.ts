import { useEffect, useState } from "react";

// A value that settles `ms` after it last changed — for a search box that
// asks the server, so typing "berg" is one request rather than four.
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}
