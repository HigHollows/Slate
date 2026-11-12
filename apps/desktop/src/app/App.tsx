import { AppRoot, type AppDeps } from './AppRoot';
import {
  accountStore,
  reportError,
  commandsStore,
  databasesStore,
  pagesStore,
  preferencesStore,
  securityStore,
  syncControl,
  syncStore,
  presenceService,
  updatesStore,
} from './stores';
import { readConfig } from '../shared/config/env';
import { ipc } from '../shared/ipc/client';

const deps: AppDeps = {
  preferences: preferencesStore,
  commands: commandsStore,
  pages: pagesStore,
  databases: databasesStore,
  security: securityStore,
  account: accountStore,
  sync: { store: syncStore, control: syncControl },
  presence: presenceService,
  updates: updatesStore,
  onError: reportError,
  ipc,
  config: readConfig(),
};

export function App() {
  return <AppRoot deps={deps} />;
}
