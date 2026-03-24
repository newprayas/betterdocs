// This is a SERVER component — it must NOT have "use client".
// generateStaticParams is required for dynamic routes in static export mode.
// The real interactive page logic is in SessionPageClient.tsx (a client component).
import SessionPageClient from './SessionPageClient';

export function generateStaticParams() {
  // Next.js requires at least one parameter to compile the route in static export mode.
  // The client side router will handle arbitrary UUIDs dynamically at runtime.
  return [{ id: 'index' }];
}

export default function SessionPage() {
  return <SessionPageClient />;
}
