import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { useDetachedInspectorPhoto } from './use-detached-inspector-photo';
import { Inspector } from './Inspector';

import './detached-inspector-window.css';

type InspectorWindowState = Awaited<ReturnType<typeof window.overlook.inspectorWindow.snapshot>>;

const messages = defineMessages({
  windowLabel: { id: 'inspector.window.label', defaultMessage: 'Inspector window' },
});

export function DetachedInspectorWindow(): ReactElement {
  const intl = useIntl();
  const [state, setState] = useState<InspectorWindowState>({ photoId: null, providerLabel: 'Cloud', selectionPosition: null });
  const photo = useDetachedInspectorPhoto(state);

  useEffect(() => {
    void window.overlook.inspectorWindow.snapshot().then(setState);
    return window.overlook.inspectorWindow.onChanged(setState);
  }, []);

  const step = useCallback((delta: 1 | -1) => {
    void window.overlook.inspectorWindow.step(delta);
  }, []);

  return (
    <main className="ovl-detachedInspector" aria-label={intl.formatMessage(messages.windowLabel)}>
      <Inspector
        photo={photo?.id === state.photoId ? photo : null}
        providerLabel={state.providerLabel}
        selectionPosition={state.selectionPosition ?? undefined}
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      />
    </main>
  );
}
