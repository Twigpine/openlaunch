import { ViewTransition } from "react";
import { tokenMorphNames } from "@/lib/launchpad/token-transition";

/*
 * The token's mark and name travel from the market row into the token page header as one object.
 * `share="morph"` animates the pair; `default="none"` keeps these names still during unrelated
 * transitions (a list re-sort, a filter change). Browsers without view transitions navigate normally.
 * Only one surface per page may carry a given name, so the market list wears it and the trending
 * strip, tape and search do not.
 */

export function MorphAvatar({ chain, token, children }: { chain: string; token: string; children: React.ReactNode }) {
  return (
    <ViewTransition name={tokenMorphNames(chain, token).avatar} share="morph" default="none">
      {children}
    </ViewTransition>
  );
}

export function MorphName({ chain, token, children }: { chain: string; token: string; children: React.ReactNode }) {
  return (
    <ViewTransition name={tokenMorphNames(chain, token).name} share="morph" default="none">
      {children}
    </ViewTransition>
  );
}
