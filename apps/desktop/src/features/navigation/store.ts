import { create } from 'zustand';

export type SettingsTab =
  'appearance' | 'language' | 'account' | 'security' | 'shortcuts' | 'about';
export type Route =
  | { name: 'home' }
  | { name: 'settings'; tab: SettingsTab }
  | { name: 'page'; id: string }
  | { name: 'database'; id: string }
  | { name: 'trash' };

interface NavState {
  stack: Route[];
  index: number;
  route: Route;
  canBack: boolean;
  canForward: boolean;
  navigate(r: Route): void;
  back(): void;
  forward(): void;
}

const same = (a: Route, b: Route) => {
  if (a.name !== b.name) return false;
  if (a.name === 'settings' && b.name === 'settings') return a.tab === b.tab;
  if (a.name === 'page' && b.name === 'page') return a.id === b.id;
  if (a.name === 'database' && b.name === 'database') return a.id === b.id;
  return true;
};

const derive = (stack: Route[], index: number) => ({
  stack,
  index,
  route: stack[index] as Route,
  canBack: index > 0,
  canForward: index < stack.length - 1,
});

export const useNav = create<NavState>((set, get) => ({
  ...derive([{ name: 'home' }], 0),
  navigate(r) {
    const { stack, index, route } = get();
    if (same(route, r)) return;
    set(derive([...stack.slice(0, index + 1), r].slice(-100), Math.min(index + 1, 99)));
  },
  back: () => set((s) => (s.index > 0 ? derive(s.stack, s.index - 1) : s)),
  forward: () => set((s) => (s.index < s.stack.length - 1 ? derive(s.stack, s.index + 1) : s)),
}));
