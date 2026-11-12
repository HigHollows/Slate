import { beforeEach, describe, expect, it } from 'vitest';
import { useNav } from './store';

describe('historique de navigation', () => {
  beforeEach(() => useNav.getState().reset());
  it('avance, recule et tronque l’avenir après une nouvelle navigation', () => {
    const n = useNav.getState();
    n.navigate({ name: 'settings', tab: 'appearance' });
    n.navigate({ name: 'settings', tab: 'language' });
    expect(useNav.getState().canBack).toBe(true);
    useNav.getState().back();
    expect(useNav.getState().route).toEqual({ name: 'settings', tab: 'appearance' });
    expect(useNav.getState().canForward).toBe(true);
    useNav.getState().navigate({ name: 'home' });
    expect(useNav.getState().canForward).toBe(false);
    expect(useNav.getState().stack).toHaveLength(3);
  });
  it('n’empile pas deux fois la même route', () => {
    useNav.getState().navigate({ name: 'home' });
    expect(useNav.getState().stack).toHaveLength(1);
  });
  it('ne dépasse pas les bornes', () => {
    useNav.getState().back();
    useNav.getState().forward();
    expect(useNav.getState().index).toBe(0);
  });
});
