import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { AuthError, type AuthClient, type AuthSession } from '../features/account';
import { renderApp } from '../test-utils';

const session: AuthSession = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: Date.now() + 3_600_000,
  user: { id: 'u1', email: 'ada@example.com', emailConfirmed: true },
};

function fakeClient(over: Partial<AuthClient> = {}): AuthClient {
  return {
    signUp: vi.fn(async () => ({ session: null, needsConfirmation: true as const })),
    signIn: vi.fn(async () => session),
    refresh: vi.fn(async () => session),
    signOut: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({
      id: 'u1',
      displayName: 'Ada',
      locale: 'fr' as const,
      timezone: 'Europe/Paris',
    })),
    updateProfile: vi.fn(async (_t, _u, patch) => ({
      id: 'u1',
      displayName: 'Ada',
      locale: 'fr' as const,
      timezone: 'Europe/Paris',
      ...patch,
    })),
    ...over,
  };
}

const openTab = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard('{Control>},{/Control}');
  await user.click(await screen.findByRole('button', { name: 'Compte' }));
};

describe('onglet Compte', () => {
  it('cloud non configuré : le mode invité est annoncé honnêtement, sans formulaire', async () => {
    const user = userEvent.setup();
    await renderApp();
    await openTab(user);
    expect(await screen.findByText(/Le cloud n'est pas configuré/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mot de passe')).not.toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('connexion : appelle le client, affiche l’adresse et vide le mot de passe', async () => {
    const user = userEvent.setup();
    const authClient = fakeClient();
    await renderApp({}, { authClient });
    await openTab(user);
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'ada@example.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'motdepasse1');
    expect(await axe(document.body)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(authClient.signIn).toHaveBeenCalledWith('ada@example.com', 'motdepasse1');
    expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument();
  });

  it('identifiants refusés : message traduit, aucune session', async () => {
    const user = userEvent.setup();
    const authClient = fakeClient({
      signIn: vi.fn(async () => {
        throw new AuthError('invalid_credentials');
      }),
    });
    await renderApp({}, { authClient });
    await openTab(user);
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'ada@example.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'mauvais-mdp');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Adresse ou mot de passe incorrect.',
    );
    expect(screen.queryByRole('button', { name: 'Se déconnecter' })).not.toBeInTheDocument();
  });

  it('inscription : message de confirmation par e-mail, pas de connexion', async () => {
    const user = userEvent.setup();
    const authClient = fakeClient();
    await renderApp({}, { authClient });
    await openTab(user);
    await user.click(await screen.findByRole('radio', { name: 'Créer un compte' }));
    await user.type(screen.getByLabelText('Nom affiché'), 'Ada');
    await user.type(screen.getByLabelText('Adresse e-mail'), 'ada@example.com');
    await user.type(screen.getByLabelText(/Mot de passe/), 'motdepasse1');
    await user.click(screen.getByRole('button', { name: 'Créer un compte' }));
    expect(await screen.findByText(/e-mail de confirmation/)).toBeInTheDocument();
    expect(authClient.signUp).toHaveBeenCalledWith('ada@example.com', 'motdepasse1', 'Ada');
    expect(screen.queryByRole('button', { name: 'Se déconnecter' })).not.toBeInTheDocument();
  });

  it('mot de passe oublié : message neutre ; déconnexion : retour au formulaire', async () => {
    const user = userEvent.setup();
    const authClient = fakeClient();
    const ctx = await renderApp({}, { authClient });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: 'Mot de passe oublié ?' }));
    await user.type(screen.getByLabelText('Adresse e-mail'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Envoyer le lien' }));
    expect(await screen.findByText(/lien de réinitialisation/)).toBeInTheDocument();
    expect(authClient.recover).toHaveBeenCalledWith('ada@example.com');

    await ctx.account.getState().signIn('ada@example.com', 'motdepasse1');
    await user.click(await screen.findByRole('button', { name: 'Se déconnecter' }));
    await waitFor(() => expect(screen.getByLabelText('Mot de passe')).toBeInTheDocument());
    expect(authClient.signOut).toHaveBeenCalled();
  });
});
