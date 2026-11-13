import { ChevronDown } from "lucide-react";
import { BOOST_COPY } from "@/lib/launchpad/boost";

/** The rules page's Boost question; the page renders it only while the switch is on (boostEnabled, read per request). */
export default function BoostRulesEntry() {
  return (
    <details open id="boosted">
      <summary>What is the Boosted lane?<ChevronDown size={17} aria-hidden="true" /></summary>
      <div>
        <p>It is a separate, labelled row on the home page and the Base page. A place in it is paid for by sending TWIG to 0x…dEaD: the TWIG is gone, and nothing is paid to openlaunch or Twigpine. It is not part of the ranking above: the Live sort and the Trending board count outside wallets only, and no boost changes them.</p>
        <p>{BOOST_COPY.what} {BOOST_COPY.how}</p>
        <p>{BOOST_COPY.tag} {BOOST_COPY.final}</p>
      </div>
    </details>
  );
}
