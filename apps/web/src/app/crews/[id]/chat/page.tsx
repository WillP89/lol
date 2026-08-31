'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * Crew and Chat merged into one screen (see apps/web/src/app/crews/[id]/page.tsx and
 * docs/DECISIONS.md#crew-chat-merge) — this route only exists so an old bookmark or a stale
 * link never dead-ends.
 */
export default function LegacyCrewChatRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/crews/${id}`);
  }, [id, router]);
  return null;
}
