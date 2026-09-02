import { useEffect, useState } from 'react';

import type { DisclosurePreview, DisclosurePreviewRequest } from '../../../shared/ipc/disclosure-channels.js';

// ADR-0032 §6 (#509): before a crossing the dialog asks main for the exact
// preview — main compiles the plan from the same intent the run will carry.
// Null while loading, on failure, or for a stale request: a null preview
// never lets a crossing start.

interface Answer {
  readonly request: string;
  readonly preview: DisclosurePreview;
}

export function useDisclosurePreview(request: DisclosurePreviewRequest | null): DisclosurePreview | null {
  const key = request === null ? '' : JSON.stringify(request);
  const [answer, setAnswer] = useState<Answer | null>(null);
  useEffect(() => {
    if (request === null) return;
    let live = true;
    void Promise.resolve()
      .then(() => window.overlook.disclosure.preview(request))
      .then((preview) => {
        if (live) setAnswer({ request: key, preview });
      })
      .catch(() => {
        if (live) setAnswer(null);
      });
    return () => {
      live = false;
    };
    // The serialized request is the dependency; the object identity is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return request !== null && answer !== null && answer.request === key ? answer.preview : null;
}
