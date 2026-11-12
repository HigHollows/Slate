import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { bus } from '../shared/bus';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { AuthClient, AuthSession } from '../features/account';
import {
  SyncError,
  createUnavailableSyncClient,
  type PullResult,
  type PushOp,
  type SyncClient,
} from '../features/sync';
import { renderApp } from '../test-utils';

const session: AuthSession = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: Date.now() + 3_600_000,
  user: { id: 'user-1', email: 'ada@example.com', emailConfirmed: true },
};
const auth = (): AuthClient => ({
  signUp: vi.fn(),
  signIn: vi.fn(async () => session),
  refresh: vi.fn(async () => session),
  signOut: vi.fn(async () => undefined),
  recover: vi.fn(),
  getProfile: vi.fn(async () => ({
    id: 'user-1',
    displayName: 'Ada',
    locale: 'fr' as const,
    timezone: 'Europe/Paris',
  })),
  updateProfile: vi.fn(),
});
const empty: PullResult = {
  nodes: [],
  node_cursor: null,
  more_nodes: false,
  docs: [],
  doc_cursor: null,
  more_docs: false,
};
const okClient = (over: Partial<SyncClient> = {}): SyncClient => {
  let created = false; // le serveur ne connaît l'espace personnel qu'une fois créé
  return {
    ...createUnavailableSyncClient(() => new Error('non prévu par ce test')),
    myMemberships: vi.fn(async () =>
      created ? [{ workspace_id: 'ws', role: 'admin' as const }] : [],
    ),
    ensureWorkspace: vi.fn(async () => {
      created = true;
    }),
    push: vi.fn(async (_w, ops) =>
      ops.map((o: PushOp) => ({ op_id: o.op_id, status: 'applied' as const, reason: null })),
    ),
    pull: vi.fn(async () => empty),
    pullStruct: vi.fn(async () => ({ items: [], cursor: null, more: false })),
    ...over,
  };
};

async function openAccount(
  user: ReturnType<typeof userEvent.setup>,
  signedIn = true,
  syncClient?: SyncClient,
) {
  const ctx = await renderApp({}, { authClient: auth(), ...(syncClient ? { syncClient } : {}) });
  if (signedIn) await ctx.account.getState().signIn('ada@example.com', 'motdepasse1');
  await user.keyboard('{Control>},{/Control}');
  await user.click(await screen.findByRole('button', { name: 'Compte' }));
  return ctx;
}

describe('connexion : synchronisation dans la foulée', () => {
  const signInViaForm = async (sync: boolean) => {
    const user = userEvent.setup();
    const ctx = await openAccount(user, false, okClient());
    await user.type(screen.getByLabelText('Adresse e-mail'), 'ada@example.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'motdepasse1');
    const box = screen.getByRole('checkbox', { name: 'Synchroniser cet appareil avec mon compte' });
    expect(box).toBeChecked();
    if (!sync) await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('heading', { name: 'Synchronisation' });
    return ctx;
  };
  it('case cochée (par défaut) : la synchronisation est activée dès la connexion', async () => {
    const ctx = await signInViaForm(true);
    await waitFor(() => expect(ctx.api.syncEnable).toHaveBeenCalledWith('ws'));
    expect(await screen.findByText(/À jour \(confirmé par le serveur\)/)).toBeInTheDocument();
  });
  it('case décochée : rien n’est envoyé, la synchronisation reste désactivée', async () => {
    const ctx = await signInViaForm(false);
    expect(await screen.findByText(/Désactivée/)).toBeInTheDocument();
    expect(ctx.api.syncEnable).not.toHaveBeenCalled();
  });
});

describe('synchronisation : interface', () => {
  it('invité : pas de section, seulement l’invitation à se connecter', async () => {
    const user = userEvent.setup();
    await openAccount(user, false);
    expect(screen.queryByRole('heading', { name: 'Synchronisation' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Connectez-vous pour retrouver vos pages, bases de données et commentaires/),
    ).toBeInTheDocument();
  });

  it('activer : crée l’espace, envoie la file, et n’affiche « À jour » qu’après l’accusé du serveur', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const client = okClient({
      push: vi.fn(async (_w, ops) => {
        await gate; // le serveur n'a pas encore répondu
        return ops.map((o: PushOp) => ({
          op_id: o.op_id,
          status: 'applied' as const,
          reason: null,
        }));
      }),
    });
    const ctx = await openAccount(user, true, client);
    const sec = await screen
      .findByRole('region', { name: 'Synchronisation' })
      .catch(() => screen.getByRole('heading', { name: 'Synchronisation' }).closest('section')!);
    expect(within(sec).getByText(/Désactivée/)).toBeInTheDocument();
    expect(await axe(sec)).toHaveNoViolations();
    await user.click(within(sec).getByRole('button', { name: 'Activer' }));
    await waitFor(() => expect(ctx.api.syncEnable).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(client.ensureWorkspace).toHaveBeenCalledWith(
        expect.any(String),
        'Personnel',
        'user-1',
      ),
    );
    // pendant l'attente du serveur : jamais « à jour »
    expect(within(sec).getByText(/Synchronisation en cours/)).toBeInTheDocument();
    expect(within(sec).queryByText(/À jour/)).not.toBeInTheDocument();
    release();
    expect(await within(sec).findByText(/À jour \(confirmé par le serveur\)/)).toBeInTheDocument();
    expect(client.push).toHaveBeenCalled();
    expect(ctx.api.syncAck).toHaveBeenCalled();
  });

  it('hors connexion : les modifications restent en attente et le message le dit', async () => {
    const user = userEvent.setup();
    const client = okClient({
      ensureWorkspace: vi.fn(async () => {
        throw new SyncError('network');
      }),
    });
    const ctx = await openAccount(user, true, client);
    await user.click(await screen.findByRole('button', { name: 'Activer' }));
    expect(
      await screen.findByText(/Hors connexion : 2 modification\(s\) en attente/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/À jour/)).not.toBeInTheDocument();
    expect(ctx.api.syncRecordError).toHaveBeenCalledWith('ws', 'network');
  });

  it('session expirée et erreur serveur : messages distincts, sans détail technique', async () => {
    const user = userEvent.setup();
    const a = await openAccount(
      user,
      true,
      okClient({
        ensureWorkspace: vi.fn(async () => {
          throw new SyncError('server', 503);
        }),
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Activer' }));
    expect(
      await screen.findByText(/Erreur de synchronisation : serveur indisponible/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/503/);
    void a;
  });

  it('opérations refusées : alerte visible ; désactiver conserve les données et repasse à « Désactivée »', async () => {
    const user = userEvent.setup();
    const ctx = await openAccount(user, true, okClient());
    await user.click(await screen.findByRole('button', { name: 'Activer' }));
    await screen.findByText(/À jour/);
    ctx.api.syncState.rejected = 2;
    await user.click(screen.getByRole('button', { name: 'Synchroniser maintenant' }));
    expect(
      await screen
        .findByRole('alert', { name: '' })
        .catch(() => screen.getByText(/2 modification\(s\) refusées par le serveur/)),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Désactiver' }));
    await waitFor(() => expect(ctx.api.syncDisable).toHaveBeenCalled());
    expect(await screen.findByText(/Désactivée/)).toBeInTheDocument();
    expect(screen.getByText(/ne supprime rien/)).toBeInTheDocument();
  });
});

describe('partage d’un espace', () => {
  const member = (over: Record<string, unknown> = {}) => ({
    user_id: '0192f0a0-0000-7000-8000-0000000000b1',
    role: 'admin' as const,
    display_name: 'Ada',
    email: 'ada@example.com',
    is_me: true,
    ...over,
  });
  const sharingClient = (over: Partial<SyncClient> = {}) =>
    okClient({
      listMembers: vi.fn(async () => [member()]),
      listInvitations: vi.fn(async () => []),
      createInvitation: vi.fn(async (_w, email, role) => ({
        id: 'i1',
        token: 'a'.repeat(64),
        email,
        role,
        expires_at: '2099-01-01T00:00:00Z',
      })),
      ...over,
    });

  it('sans synchronisation : le partage demande de l’activer d’abord', async () => {
    const user = userEvent.setup();
    await openAccount(user, true, sharingClient());
    expect(await screen.findByText(/activez d'abord la synchronisation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Créer l'invitation" })).not.toBeInTheDocument();
  });

  it('administrateur : crée une invitation, le jeton n’est montré qu’une fois', async () => {
    const user = userEvent.setup();
    const client = sharingClient();
    await openAccount(user, true, client);
    await user.click(await screen.findByRole('button', { name: 'Activer' }));
    await screen.findByText(/À jour/);
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'bob@example.com');
    await user.click(screen.getByRole('button', { name: "Créer l'invitation" }));
    expect(client.createInvitation).toHaveBeenCalledWith('ws', 'bob@example.com', 'editor');
    const tok = await screen.findByLabelText("Jeton d'invitation pour bob@example.com");
    expect(tok).toHaveValue('a'.repeat(64));
    expect(tok).toHaveAttribute('readonly');
  });

  it('rejoindre : accepte le jeton, rejoint l’espace localement et le dit', async () => {
    const user = userEvent.setup();
    const SHARED = '0192f0a0-0000-7000-8000-0000000000aa';
    const client = sharingClient({
      acceptInvitation: vi.fn(async () => ({
        workspace_id: SHARED,
        name: 'Équipe',
        role: 'editor' as const,
      })),
    });
    const ctx = await openAccount(user, true, client);
    await user.type(await screen.findByLabelText("Jeton d'invitation"), `  ${'b'.repeat(64)} `);
    await user.click(screen.getByRole('button', { name: 'Rejoindre' }));
    expect(client.acceptInvitation).toHaveBeenCalledWith('b'.repeat(64));
    await waitFor(() =>
      expect(ctx.api.syncJoinWorkspace).toHaveBeenCalledWith(SHARED, 'Équipe', 'editor'),
    );
    expect(await screen.findByText(/Espace « Équipe » rejoint/)).toBeInTheDocument();
    // l'espace rejoint est AFFICHÉ tout de suite (sinon on resterait sur son propre espace, vide) et repéré comme partagé
    await waitFor(() => expect(ctx.pages.getState().workspaceId).toBe(SHARED));
    const picker = await screen.findByRole('combobox', { name: 'Espace affiché' });
    expect(picker).toHaveValue(SHARED);
    expect(within(picker).getByRole('option', { name: 'Équipe (partagé)' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Personnel' })).toBeInTheDocument();
  });

  it('rejoindre : on peut coller le message d’invitation entier, le jeton y est retrouvé', async () => {
    const user = userEvent.setup();
    const client = sharingClient({
      acceptInvitation: vi.fn(async () => ({
        workspace_id: '0192f0a0-0000-7000-8000-0000000000ab',
        name: 'Équipe',
        role: 'viewer' as const,
      })),
    });
    await openAccount(user, true, client);
    const box = await screen.findByLabelText("Jeton d'invitation");
    await user.click(box);
    await user.paste(
      `Je t'invite sur Slate.\n1. Connecte-toi\n2. Colle ce message :\n${'C'.repeat(64)}\nÀ bientôt`,
    );
    await user.click(screen.getByRole('button', { name: 'Rejoindre' }));
    await waitFor(() => expect(client.acceptInvitation).toHaveBeenCalledWith('c'.repeat(64)));
  });

  it('copier l’invitation : un message prêt à envoyer, avec l’adresse et le jeton', async () => {
    const user = userEvent.setup();
    const client = sharingClient();
    await openAccount(user, true, client);
    await user.click(await screen.findByRole('button', { name: 'Activer' }));
    await screen.findByText(/À jour/);
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'bob@example.com');
    await user.click(screen.getByRole('checkbox', { name: /Envoyer aussi/ }));
    await user.click(screen.getByRole('button', { name: "Créer l'invitation" }));
    await user.click(await screen.findByRole('button', { name: "Copier l'invitation" }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('a'.repeat(64));
    expect(copied).toContain('bob@example.com');
    expect(copied).toContain('Rejoindre un espace');
    expect(await screen.findByRole('button', { name: 'Copié' })).toBeInTheDocument();
  });

  it('jeton refusé : message clair, sans détail serveur, rien n’est rejoint', async () => {
    const user = userEvent.setup();
    const client = sharingClient({
      acceptInvitation: vi.fn(async () => {
        throw new SyncError('invalid', 400, 'invitation_invalid');
      }),
    });
    const ctx = await openAccount(user, true, client);
    await user.type(await screen.findByLabelText("Jeton d'invitation"), 'c'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Rejoindre' }));
    expect(await screen.findByText(/Invitation invalide, expirée/)).toBeInTheDocument();
    expect(ctx.api.syncJoinWorkspace).not.toHaveBeenCalled();
  });

  describe('partage d’un dossier ou d’une page précis', () => {
    const open = async (client: SyncClient, enable = true) => {
      const user = userEvent.setup();
      const ctx = await openAccount(user, true, client);
      if (enable) {
        await user.click(await screen.findByRole('button', { name: 'Activer' }));
        await screen.findByText(/À jour/);
      }
      act(() => bus.emit('share-node', { id: 'n-folder', title: 'Projet', kind: 'folder' }));
      const dlg = await screen.findByRole('dialog', { name: 'Partager « Projet »' });
      return { user, ctx, dlg };
    };
    const nodeClient = (over: Partial<SyncClient> = {}) =>
      sharingClient({
        listNodeShares: vi.fn(async () => ({ shares: [], invitations: [] })),
        createNodeInvitation: vi.fn(async (_n, email, role) => ({
          id: 'i9',
          token: 'd'.repeat(64),
          email,
          role,
          expires_at: '2099-01-01T00:00:00Z',
        })),
        ...over,
      });

    it('invite sur CET élément seulement, avec un rôle lecteur ou éditeur (jamais administrateur)', async () => {
      const client = nodeClient();
      const { user, dlg } = await open(client);
      expect(
        within(dlg).getByText(/verra ce dossier et tout ce qu.il contient, rien d.autre/),
      ).toBeInTheDocument();
      const roles = within(dlg).getByRole('combobox', { name: 'Rôle' });
      expect(
        within(roles).queryByRole('option', { name: 'Administrateur' }),
      ).not.toBeInTheDocument();
      await user.type(within(dlg).getByLabelText('Adresse e-mail'), 'bob@example.com');
      await user.selectOptions(roles, 'viewer');
      await user.click(within(dlg).getByRole('button', { name: "Créer l'invitation" }));
      await waitFor(() =>
        expect(client.createNodeInvitation).toHaveBeenCalledWith(
          'n-folder',
          'bob@example.com',
          'viewer',
        ),
      );
      // jamais l'invitation d'espace entier
      expect(client.createInvitation).not.toHaveBeenCalled();
      expect(
        await within(dlg).findByLabelText("Jeton d'invitation pour bob@example.com"),
      ).toHaveValue('d'.repeat(64));
    });

    it('liste qui a accès et permet de retirer un accès ou de révoquer une invitation', async () => {
      const removeNodeShare = vi.fn(async () => undefined);
      const revokeInvitation = vi.fn(async () => undefined);
      const client = nodeClient({
        listNodeShares: vi.fn(async () => ({
          shares: [
            {
              user_id: 'u-bob',
              role: 'editor' as const,
              email: 'bob@example.com',
              display_name: 'Bob',
            },
          ],
          invitations: [
            {
              id: 'i-1',
              email: 'eve@example.com',
              role: 'viewer' as const,
              expires_at: '2099-01-01T00:00:00Z',
            },
          ],
        })),
        removeNodeShare,
        revokeInvitation,
      });
      const { user, dlg } = await open(client);
      expect(await within(dlg).findByText('Bob')).toBeInTheDocument();
      await user.click(within(dlg).getByRole('button', { name: "Retirer l'accès de Bob" }));
      await waitFor(() => expect(removeNodeShare).toHaveBeenCalledWith('n-folder', 'u-bob'));
      await user.click(
        within(dlg).getByRole('button', { name: "Révoquer l'invitation de eve@example.com" }),
      );
      await waitFor(() => expect(revokeInvitation).toHaveBeenCalledWith('i-1'));
    });

    it('sans synchronisation : explique quoi faire, aucun appel', async () => {
      const client = nodeClient();
      const { dlg } = await open(client, false);
      expect(
        within(dlg).getByText(/connectez-vous et activez la synchronisation/),
      ).toBeInTheDocument();
      expect(client.listNodeShares).not.toHaveBeenCalled();
    });
  });

  describe('envoi par e-mail', () => {
    const openInvite = async (client: SyncClient) => {
      const user = userEvent.setup();
      await openAccount(user, true, client);
      await user.click(await screen.findByRole('button', { name: 'Activer' }));
      await screen.findByText(/À jour/);
      await user.type(await screen.findByLabelText('Adresse e-mail'), 'bob@example.com');
      return user;
    };

    it("par défaut : demande l'envoi avec le jeton et la langue ; n'affirme « remis » qu'après confirmation du serveur", async () => {
      const client = sharingClient({ emailInvitation: vi.fn(async () => undefined) });
      const user = await openInvite(client);
      expect(
        screen.getByRole('checkbox', { name: /Envoyer aussi l'invitation par e-mail/ }),
      ).toBeChecked();
      await user.click(screen.getByRole('button', { name: "Créer l'invitation" }));
      await waitFor(() =>
        expect(client.emailInvitation).toHaveBeenCalledWith('a'.repeat(64), 'fr'),
      );
      expect(
        await screen.findByText(/E-mail remis au service d'envoi pour bob@example.com/),
      ).toBeInTheDocument();
      // le jeton reste affiché quoi qu’il arrive
      expect(await screen.findByLabelText("Jeton d'invitation pour bob@example.com")).toHaveValue(
        'a'.repeat(64),
      );
    });

    it('case décochée : aucun e-mail', async () => {
      const client = sharingClient({ emailInvitation: vi.fn(async () => undefined) });
      const user = await openInvite(client);
      await user.click(screen.getByRole('checkbox', { name: /Envoyer aussi/ }));
      await user.click(screen.getByRole('button', { name: "Créer l'invitation" }));
      await screen.findByLabelText("Jeton d'invitation pour bob@example.com");
      expect(client.emailInvitation).not.toHaveBeenCalled();
      expect(screen.queryByText(/E-mail remis/)).not.toBeInTheDocument();
    });

    it('envoi non configuré : le dit clairement (jamais « envoyé »), jeton affiché, pas de bouton Renvoyer', async () => {
      const client = sharingClient({
        emailInvitation: vi.fn(async () => {
          throw new SyncError('invalid', 503, 'not_configured');
        }),
      });
      const user = await openInvite(client);
      await user.click(screen.getByRole('button', { name: "Créer l'invitation" }));
      expect(
        await screen.findByText(/L'envoi d'e-mails n'est pas configuré sur ce projet/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/E-mail remis/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Jeton d'invitation pour bob@example.com")).toHaveValue(
        'a'.repeat(64),
      );
      expect(screen.queryByRole('button', { name: "Renvoyer l'e-mail" })).not.toBeInTheDocument();
    });

    it("échec du service d'envoi ou limite atteinte : message honnête et nouvelle tentative possible", async () => {
      const emailInvitation = vi
        .fn()
        .mockRejectedValueOnce(new SyncError('server', 502))
        .mockResolvedValueOnce(undefined);
      const user = await openInvite(sharingClient({ emailInvitation }));
      await user.click(screen.getByRole('button', { name: "Créer l'invitation" }));
      expect(await screen.findByText(/L'e-mail n'a pas pu être envoyé/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: "Renvoyer l'e-mail" }));
      expect(await screen.findByText(/E-mail remis au service d'envoi/)).toBeInTheDocument();
      expect(emailInvitation).toHaveBeenCalledTimes(2);
    });

    it("limite d'envois : message dédié", async () => {
      const client = sharingClient({
        emailInvitation: vi.fn(async () => {
          throw new SyncError('invalid', 429, 'rate_limited');
        }),
      });
      const user = await openInvite(client);
      await user.click(screen.getByRole('button', { name: "Créer l'invitation" }));
      expect(await screen.findByText(/Trop d'envois pour cette invitation/)).toBeInTheDocument();
    });
  });
});
