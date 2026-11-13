import { Suspense } from "react";
import { notFound } from "next/navigation";
import EarnReview from "./EarnReview";

export const dynamic = "force-dynamic";

/** Local visual fixture for the Earn card and sheet. Never exposes a mock wallet or transaction on production. */
export default function EarnReviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <Suspense><EarnReview /></Suspense>;
}
