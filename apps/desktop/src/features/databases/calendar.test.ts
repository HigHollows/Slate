import { afterAll, describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayOfValue,
  isYmd,
  localYmd,
  monthGrid,
  moveValueToDay,
  startOfWeek,
  weekDays,
  weekdayIndex,
} from './calendar';

describe('calcul calendaire', () => {
  it('jours et mois, bornes, années bissextiles', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -2)).toBe('2025-11-15');
    expect(isYmd('2026-02-29')).toBe(false);
    expect(isYmd('2024-02-29')).toBe(true);
  });
  it('semaines commençant le lundi', () => {
    expect(weekdayIndex('2026-06-15')).toBe(0); // lundi
    expect(weekdayIndex('2026-06-21')).toBe(6); // dimanche
    expect(startOfWeek('2026-06-17')).toBe('2026-06-15');
    expect(weekDays('2026-06-17')).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
    ]);
  });
  it('grille mensuelle : semaines complètes, couvre tout le mois', () => {
    const g = monthGrid('2026-02-10'); // février 2026 : du dimanche 1er au samedi 28
    expect(g.length).toBe(5);
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[0]?.[0]).toBe('2026-01-26');
    expect(g[4]?.[6]).toBe('2026-03-01');
    const feb = monthGrid('2021-02-01'); // février 2021 : exactement 4 semaines
    expect(feb.length).toBe(4);
    expect(monthGrid('2026-08-01').length).toBe(6);
    const flat = monthGrid('2026-06-01').flat();
    for (let d = 1; d <= 30; d++) expect(flat).toContain(`2026-06-${String(d).padStart(2, '0')}`);
  });
});

describe('fuseaux horaires', () => {
  const old = process.env['TZ'];
  afterAll(() => {
    if (old === undefined) delete process.env['TZ'];
    else process.env['TZ'] = old;
  });

  it('une date est un jour civil : jamais décalée', () => {
    for (const tz of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
      process.env['TZ'] = tz;
      expect(dayOfValue('2026-03-10', 'date')).toBe('2026-03-10');
      expect(moveValueToDay('2026-03-10', 'date', '2026-03-15')).toBe('2026-03-15');
    }
  });
  it('une date-heure est placée dans le jour LOCAL', () => {
    process.env['TZ'] = 'Pacific/Auckland'; // UTC+13 en mars (heure d'été)
    expect(dayOfValue('2026-03-10T23:30:00Z', 'datetime')).toBe('2026-03-11');
    process.env['TZ'] = 'America/Los_Angeles'; // UTC-7
    expect(dayOfValue('2026-03-10T02:00:00Z', 'datetime')).toBe('2026-03-09');
    process.env['TZ'] = 'UTC';
    expect(dayOfValue('2026-03-10T02:00:00Z', 'datetime')).toBe('2026-03-10');
    expect(localYmd('pas une date')).toBeNull();
  });
  it('déplacer une date-heure conserve son heure locale, y compris à travers un changement d’heure', () => {
    process.env['TZ'] = 'Europe/Paris';
    // 10:00 locale le 25/03/2026 (CET, UTC+1) → même heure locale le 30/03/2026 (CEST, UTC+2)
    const moved = moveValueToDay('2026-03-25T09:00:00Z', 'datetime', '2026-03-30');
    expect(moved).toBe('2026-03-30T08:00:00Z');
    expect(new Date(moved).getHours()).toBe(10);
    expect(dayOfValue(moved, 'datetime')).toBe('2026-03-30');
  });
  it('sans valeur précédente, une date-heure démarre à 9 h locale', () => {
    process.env['TZ'] = 'Europe/Paris';
    const v = moveValueToDay(null, 'datetime', '2026-01-10');
    expect(new Date(v).getHours()).toBe(9);
  });
  it('valeurs invalides ignorées', () => {
    expect(dayOfValue(42, 'date')).toBeNull();
    expect(dayOfValue('2026-13-01', 'date')).toBeNull();
    expect(dayOfValue('', 'datetime')).toBeNull();
  });
});
