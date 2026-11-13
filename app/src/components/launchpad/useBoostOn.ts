"use client";

import { useEffect, useState } from "react";
import { useLive } from "./LiveProvider";

/**
 * Whether the BOOST switch is on, as the shared live poll last said. No request of its own. The root layout seeds it
 * from the server (so the first paint is right), every poll repeats it, and a poll from a machine that predates it
 * changes nothing. Switching BOOST off reaches open tabs within one poll.
 */
export function useBoostOn(): boolean {
  const { live, subscribe } = useLive();
  const [on, setOn] = useState(live.boost_on === true);
  useEffect(
    () =>
      subscribe((snap) => {
        if (snap.boost_on !== undefined) setOn(snap.boost_on);
      }),
    [subscribe],
  );
  return on;
}
