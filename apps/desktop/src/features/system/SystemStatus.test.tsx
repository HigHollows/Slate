import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SystemStatus } from './SystemStatus';
import { initI18n } from '../../shared/i18n';
import { SlateError } from '../../shared/ipc/errors';

const guest = { supabaseUrl: null, supabaseAnonKey: null, cloudEnabled: false };
const info = {
  appVersion: '0.1.0',
  schemaVersion: 1,
  deviceId: 'dev-1',
  dbPath: '/x/slate.sqlite',
  integrityOk: true,
};

beforeAll(async () => {
  await initI18n('fr');
});

describe('SystemStatus', () => {
  it('affiche les informations réelles renvoyées par le cœur', async () => {
    render(<SystemStatus ipc={{ systemInfo: vi.fn().mockResolvedValue(info) }} config={guest} />);
    expect(await screen.findByText('/x/slate.sqlite')).toBeInTheDocument();
    expect(screen.getByText('Invité (local uniquement)')).toBeInTheDocument();
  });
  it("affiche l'erreur et propose de réessayer quand elle est réessayable", async () => {
    const err = new SlateError('io', 'errors.io', true);
    render(<SystemStatus ipc={{ systemInfo: vi.fn().mockRejectedValue(err) }} config={guest} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Erreur d'accès au disque.");
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });
});
