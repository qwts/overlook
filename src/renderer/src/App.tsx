import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import './app.css';
import { AppStateProvider } from './state/app-state-context';
import { Shell } from './shell/Shell';
import { RestoreOnboarding } from './restore/RestoreOnboarding';
import { LockScreen } from './lock/LockScreen';
import { CustodyScreen } from './lock/CustodyScreen';
import type { LibraryCustodyState } from '../../shared/library/custody.js';
import { EMPTY_COMMAND_MENU_CONTEXT } from '../../shared/commands/menu-contract.js';
import type { CommandId } from '../../shared/commands/registry.js';
import { AnnouncerProvider } from './components/LiveAnnouncer';
import { DetachedInspectorWindow } from './inspector/DetachedInspectorWindow';
import { LibrarySwitcher } from './shell/LibrarySwitcher';

type LockStatus = Awaited<ReturnType<typeof window.overlook.appLock.status>>;

// App root (#73): platform lookup + state provider around the composed
// shell. The token specimen moved to Storybook-only duty with this change.
export function App(): ReactElement {
  const detachedInspector = new URLSearchParams(window.location.search).get('surface') === 'inspector';
  // Until the platform round-trip resolves, render the mac variant: it draws
  // no controls, so a wrong first frame on win/linux flashes nothing broken.
  const [platform, setPlatform] = useState('darwin');
  const [fresh, setFresh] = useState<boolean | null>(null);
  const [lock, setLock] = useState<LockStatus | null>(null);
  const [custody, setCustody] = useState<LibraryCustodyState | null>(null);
  const [custodyEpoch, setCustodyEpoch] = useState(0);
  const [nativeCommand, setNativeCommand] = useState<{ readonly id: CommandId; readonly sequence: number } | null>(null);
  const [lockedLibrarySwitcherOpen, setLockedLibrarySwitcherOpen] = useState(false);
  const sequenceRef = useRef(0);
  const lockRef = useRef<LockStatus | null>(null);
  const custodyRef = useRef<LibraryCustodyState | null>(null);
  useEffect(() => {
    const unsubscribe = window.overlook.commands.onInvoked(({ id }) => {
      const currentLock = lockRef.current;
      const authorized = currentLock?.state === 'unconfigured-unlocked' || currentLock?.state === 'unlocked';
      if (currentLock !== null && (!authorized || custodyRef.current !== 'ok') && id === 'library.switch') {
        setLockedLibrarySwitcherOpen(true);
        return;
      }
      sequenceRef.current += 1;
      setNativeCommand({ id, sequence: sequenceRef.current });
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    void window.overlook.getPlatform().then(setPlatform);
    const receiveLock = (next: LockStatus): void => {
      lockRef.current = next;
      setLock(next);
      if (next.state === 'unconfigured-unlocked' || next.state === 'unlocked') setLockedLibrarySwitcherOpen(false);
    };
    void window.overlook.appLock.status().then(receiveLock);
    return window.overlook.appLock.onChanged(receiveLock);
  }, []);

  const authorized = lock?.state === 'unconfigured-unlocked' || lock?.state === 'unlocked';
  useEffect(() => {
    if (!authorized) return;
    let active = true;
    void window.overlook.library.custody().then(({ state }) => {
      if (!active) return;
      custodyRef.current = state;
      setCustody(state);
    });
    return () => {
      active = false;
    };
  }, [authorized, custodyEpoch]);

  useEffect(() => {
    if (authorized && custody === 'ok') {
      void window.overlook.restore.profileStatus().then(({ fresh: value }) => setFresh(value));
    }
  }, [authorized, custody]);

  useEffect(() => {
    if (lock === null) return;
    const contentReady = authorized && custody === 'ok';
    const context = {
      ...EMPTY_COMMAND_MENU_CONTEXT,
      surface: contentReady ? ('onboarding' as const) : ('locked' as const),
      hasLibrary: lock.libraryId !== null,
      appLockConfigured: lock.state !== 'unconfigured-unlocked',
    };
    void window.overlook.commands.ready(context);
  }, [authorized, custody, lock]);

  if (lock === null) return <></>;
  if (lock.state !== 'unconfigured-unlocked' && lock.state !== 'unlocked') {
    return (
      <AnnouncerProvider>
        <LockScreen
          platform={platform}
          state={lock.state}
          retryAfterMs={lock.retryAfterMs}
          attemptsRemaining={lock.attemptsRemaining}
          onSwitchLibrary={() => setLockedLibrarySwitcherOpen(true)}
        />
        {lockedLibrarySwitcherOpen ? <LibrarySwitcher switchOnly onClose={() => setLockedLibrarySwitcherOpen(false)} /> : null}
      </AnnouncerProvider>
    );
  }
  if (custody === null) return <></>;
  if (custody !== 'ok') {
    return (
      <AnnouncerProvider>
        <CustodyScreen
          platform={platform}
          state={custody}
          onRecovered={() => {
            custodyRef.current = 'ok';
            setCustody('ok');
          }}
          onSwitchLibrary={() => setLockedLibrarySwitcherOpen(true)}
        />
        {lockedLibrarySwitcherOpen ? (
          <LibrarySwitcher
            switchOnly
            onClose={() => {
              setLockedLibrarySwitcherOpen(false);
              custodyRef.current = null;
              setCustody(null);
              setCustodyEpoch((epoch) => epoch + 1);
            }}
          />
        ) : null}
      </AnnouncerProvider>
    );
  }

  return (
    <AnnouncerProvider>
      {detachedInspector ? (
        <DetachedInspectorWindow />
      ) : (
        <AppStateProvider>
          {fresh === true ? (
            <RestoreOnboarding platform={platform} onStartNew={() => setFresh(false)} />
          ) : fresh === false ? (
            <Shell platform={platform} lockConfigured={lock.state === 'unlocked'} nativeCommand={nativeCommand} />
          ) : null}
        </AppStateProvider>
      )}
    </AnnouncerProvider>
  );
}
