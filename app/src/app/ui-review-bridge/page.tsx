import type { Metadata } from "next";
import { notFound } from "next/navigation";
import BridgeReview from "./BridgeReview";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Bridge review" };

/** Local visual fixture. Never exposes a mock wallet or transfer on production. */
export default function BridgeReviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <BridgeReview />;
}
