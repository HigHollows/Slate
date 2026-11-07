import { describe, expect, it } from 'vitest';
import {
  addDays,
  completionRate,
  countInWindow,
  currentStreak,
  localDay,
  longestStreak,
  weeklyGoalMet,
} from './habits';

const S = (...d: string[]) => new Set(d);

describe('statistiques d’habitudes', () => {
  it('addDays traverse mois, années et février bissextile', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30'); // changement d'heure : calcul en UTC, sans décalage
  });

  it('localDay utilise le jour local, pas UTC', () => {
    expect(localDay(new Date(2026, 5, 1, 0, 30))).toBe('2026-06-01');
    expect(localDay(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('la série en cours tolère « aujourd’hui pas encore pointé »', () => {
    const d = S('2026-06-01', '2026-06-02', '2026-06-03');
    expect(currentStreak(d, '2026-06-03')).toBe(3);
    expect(currentStreak(d, '2026-06-04')).toBe(3); // hier pointé, aujourd'hui pas encore
    expect(currentStreak(d, '2026-06-05')).toBe(0); // un jour manqué casse la série
    expect(currentStreak(S(), '2026-06-05')).toBe(0);
  });

  it('la plus longue série', () => {
    expect(longestStreak(S())).toBe(0);
    expect(
      longestStreak(S('2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05', '2026-06-06')),
    ).toBe(3);
    expect(longestStreak(S('2026-12-30', '2026-12-31', '2027-01-01'))).toBe(3);
  });

  it('fenêtres, taux et objectif hebdomadaire', () => {
    const d = S('2026-06-01', '2026-06-03', '2026-06-05', '2026-05-20');
    expect(countInWindow(d, '2026-06-07', 7)).toBe(3);
    expect(countInWindow(d, '2026-06-07', 30)).toBe(4);
    expect(completionRate(d, '2026-06-07', 30)).toBeCloseTo(4 / 30);
    expect(completionRate(d, '2026-06-07', 0)).toBe(0);
    expect(weeklyGoalMet(d, '2026-06-07', 3)).toBe(true);
    expect(weeklyGoalMet(d, '2026-06-07', 4)).toBe(false);
    expect(weeklyGoalMet(d, '2026-06-07', 0)).toBe(true); // borné à 1
    expect(weeklyGoalMet(d, '2026-06-07', 99)).toBe(false); // borné à 7
  });
});
