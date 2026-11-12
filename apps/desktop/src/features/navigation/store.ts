import { create } from 'zustand';

export type SettingsTab =
  'appearance' | 'language' | 'account' | 'security' | 'shortcuts' | 'about';
export type Route =
  | { name: 'home' }
  | { name: 'settings'; tab: SettingsTab }
  | { name: 'page'; id: string }
  | { name: 'database'; id: string }
  | { name: 'trash' };

/** Un onglet = son propre historique (précédent / suivant), comme dans un navigateur. */
export interface Tab {
  id: string;
  stack: Route[];
  index: number;
}

/** Au plus 30 onglets ouverts : au-delà, ouvrir « dans un nouvel onglet » remplace l'onglet actif. */
export const MAX_TABS = 30;
const MAX_HISTORY = 100;
const MAX_CLOSED = 10;

interface NavState {
  /** Onglets ouverts, dans l'ordre d'affichage. Il y en a toujours au moins un. */
  tabs: Tab[];
  activeId: string;
  /** Routes des onglets fermés récemment (le plus récent en dernier) : « rouvrir l'onglet fermé ». */
  closed: Route[];
  // Vue de l'onglet actif (conservée pour tout le code qui ne connaît pas les onglets).
  stack: Route[];
  index: number;
  route: Route;
  canBack: boolean;
  canForward: boolean;
  /** Va à une route DANS l'onglet actif (cas général : cliquer une page de l'arbre). */
  navigate(r: Route): void;
  back(): void;
  forward(): void;
  /** Ouvre dans un nouvel onglet (ou active l'onglet qui montre déjà cette route). */
  openTab(r?: Route, opts?: { background?: boolean }): void;
  activateTab(id: string): void;
  closeTab(id: string): void;
  closeOthers(id: string): void;
  closeToRight(id: string): void;
  moveTab(id: string, toIndex: number): void;
  cycleTab(dir: 1 | -1): void;
  reopenClosed(): void;
  /** Remet un seul onglet « accueil » (tests, déconnexion). */
  reset(): void;
  /** Restaure des onglets enregistrés (validés : tout ce qui est invalide est ignoré). */
  hydrate(saved: unknown): void;
}

export const sameRoute = (a: Route, b: Route): boolean => {
  if (a.name !== b.name) return false;
  if (a.name === 'settings' && b.name === 'settings') return a.tab === b.tab;
  if (a.name === 'page' && b.name === 'page') return a.id === b.id;
  if (a.name === 'database' && b.name === 'database') return a.id === b.id;
  return true;
};

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const newTab = (r: Route = { name: 'home' }): Tab => ({ id: uid(), stack: [r], index: 0 });
const routeOf = (t: Tab): Route => t.stack[t.index] as Route;

function view(tabs: Tab[], activeId: string) {
  const t = tabs.find((x) => x.id === activeId) ?? (tabs[0] as Tab);
  return {
    tabs,
    activeId: t.id,
    stack: t.stack,
    index: t.index,
    route: routeOf(t),
    canBack: t.index > 0,
    canForward: t.index < t.stack.length - 1,
  };
}

const SETTINGS_TABS = new Set([
  'appearance',
  'language',
  'account',
  'security',
  'shortcuts',
  'about',
]);
const ID = /^[0-9a-zA-Z-]{1,64}$/;
function parseRoute(v: unknown): Route | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { name?: unknown; id?: unknown; tab?: unknown };
  switch (r.name) {
    case 'home':
    case 'trash':
      return { name: r.name };
    case 'settings':
      return typeof r.tab === 'string' && SETTINGS_TABS.has(r.tab)
        ? { name: 'settings', tab: r.tab as SettingsTab }
        : null;
    case 'page':
    case 'database':
      return typeof r.id === 'string' && ID.test(r.id) ? { name: r.name, id: r.id } : null;
    default:
      return null;
  }
}

const initial = () => {
  const t = newTab();
  return { ...view([t], t.id), closed: [] as Route[] };
};

export const useNav = create<NavState>((set, get) => {
  /** Remplace l'onglet actif par `fn(onglet)`. */
  const mutateActive = (fn: (t: Tab) => Tab) =>
    set((s) =>
      view(
        s.tabs.map((t) => (t.id === s.activeId ? fn(t) : t)),
        s.activeId,
      ),
    );
  const remember = (closed: Route[], r: Route): Route[] =>
    r.name === 'home' ? closed : [...closed.filter((x) => !sameRoute(x, r)), r].slice(-MAX_CLOSED);

  return {
    ...initial(),

    navigate(r) {
      if (sameRoute(get().route, r)) return;
      mutateActive((t) => {
        const stack = [...t.stack.slice(0, t.index + 1), r].slice(-MAX_HISTORY);
        return { ...t, stack, index: stack.length - 1 };
      });
    },
    back: () => mutateActive((t) => (t.index > 0 ? { ...t, index: t.index - 1 } : t)),
    forward: () =>
      mutateActive((t) => (t.index < t.stack.length - 1 ? { ...t, index: t.index + 1 } : t)),

    openTab(r = { name: 'home' }, opts) {
      const s = get();
      // Déjà ouverte quelque part : on y va (jamais deux onglets identiques), sauf onglet vide « accueil ».
      const existing = r.name === 'home' ? undefined : s.tabs.find((t) => sameRoute(routeOf(t), r));
      if (existing) {
        if (!opts?.background) set(view(s.tabs, existing.id));
        return;
      }
      if (s.tabs.length >= MAX_TABS) {
        if (!opts?.background) get().navigate(r);
        return;
      }
      const t = newTab(r);
      const at = s.tabs.findIndex((x) => x.id === s.activeId) + 1; // à droite de l'onglet actif
      const tabs = [...s.tabs.slice(0, at), t, ...s.tabs.slice(at)];
      set(view(tabs, opts?.background ? s.activeId : t.id));
    },

    activateTab(id) {
      const s = get();
      if (s.activeId !== id && s.tabs.some((t) => t.id === id)) set(view(s.tabs, id));
    },

    closeTab(id) {
      const s = get();
      const i = s.tabs.findIndex((t) => t.id === id);
      if (i < 0) return;
      const closed = remember(s.closed, routeOf(s.tabs[i] as Tab));
      if (s.tabs.length === 1) {
        // Le dernier onglet ne disparaît jamais : il revient à l'accueil.
        const t = newTab();
        set({ ...view([t], t.id), closed });
        return;
      }
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Si on ferme l'onglet actif, on passe au voisin de droite (sinon de gauche), comme un navigateur.
      const next = id === s.activeId ? (tabs[Math.min(i, tabs.length - 1)] as Tab).id : s.activeId;
      set({ ...view(tabs, next), closed });
    },

    closeOthers(id) {
      const s = get();
      const keep = s.tabs.find((t) => t.id === id);
      if (!keep) return;
      const closed = s.tabs
        .filter((t) => t.id !== id)
        .reduce((acc, t) => remember(acc, routeOf(t)), s.closed);
      set({ ...view([keep], keep.id), closed });
    },

    closeToRight(id) {
      const s = get();
      const i = s.tabs.findIndex((t) => t.id === id);
      if (i < 0 || i === s.tabs.length - 1) return;
      const gone = s.tabs.slice(i + 1);
      const tabs = s.tabs.slice(0, i + 1);
      const closed = gone.reduce((acc, t) => remember(acc, routeOf(t)), s.closed);
      set({ ...view(tabs, tabs.some((t) => t.id === s.activeId) ? s.activeId : id), closed });
    },

    moveTab(id, toIndex) {
      const s = get();
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from < 0) return;
      const to = Math.max(0, Math.min(s.tabs.length - 1, toIndex));
      if (from === to) return;
      const tabs = [...s.tabs];
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t as Tab);
      set(view(tabs, s.activeId));
    },

    cycleTab(dir) {
      const s = get();
      if (s.tabs.length < 2) return;
      const i = s.tabs.findIndex((t) => t.id === s.activeId);
      const next = s.tabs[(i + dir + s.tabs.length) % s.tabs.length] as Tab;
      set(view(s.tabs, next.id));
    },

    reopenClosed() {
      const s = get();
      const r = s.closed[s.closed.length - 1];
      if (!r) return;
      set({ closed: s.closed.slice(0, -1) });
      get().openTab(r);
    },

    reset: () => set(initial()),

    hydrate(saved) {
      if (!saved || typeof saved !== 'object') return;
      const sv = saved as { tabs?: unknown; active?: unknown };
      if (!Array.isArray(sv.tabs)) return;
      const tabs: Tab[] = [];
      for (const raw of sv.tabs.slice(0, MAX_TABS)) {
        const r = parseRoute(raw);
        if (r && !(r.name !== 'home' && tabs.some((t) => sameRoute(routeOf(t), r))))
          tabs.push(newTab(r));
      }
      if (tabs.length === 0) return;
      const ai = typeof sv.active === 'number' && Number.isInteger(sv.active) ? sv.active : 0;
      set({
        ...view(tabs, (tabs[Math.max(0, Math.min(tabs.length - 1, ai))] as Tab).id),
        closed: [],
      });
    },
  };
});

/** Ce qu'on enregistre pour retrouver ses onglets au prochain démarrage : la route courante de chaque onglet (pas l'historique). */
export function snapshotTabs(s: Pick<NavState, 'tabs' | 'activeId'>): {
  tabs: Route[];
  active: number;
} {
  return {
    tabs: s.tabs.map(routeOf),
    active: Math.max(
      0,
      s.tabs.findIndex((t) => t.id === s.activeId),
    ),
  };
}
