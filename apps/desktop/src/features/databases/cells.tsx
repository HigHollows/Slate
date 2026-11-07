import { Icon } from '@slate/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalize } from '../../shared/text';
import { cx } from '../../shared/ui';
import type { Evaluator } from './engine';
import { formatNumber, typeDef } from './registry';
import { optionsOf, relationTarget, type Property, type Row, type SelectOption } from './types';
import { useDatabase } from './context';

export type EditorKind = 'input' | 'picker' | 'toggle' | 'none';
export function editorKind(p: Property): EditorKind {
  const d = typeDef(p.type);
  if (!d.editable) return 'none';
  if (p.type === 'checkbox') return 'toggle';
  if (
    p.type === 'select' ||
    p.type === 'status' ||
    p.type === 'multiselect' ||
    p.type === 'relation'
  )
    return 'picker';
  return 'input';
}

const chipClass = (c: string) => `chip chip-${c}`;

function fmtDate(v: string, time: boolean, locale: string): string {
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat(
    locale,
    time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium', timeZone: 'UTC' },
  ).format(d);
}

/** Affichage en lecture d'une cellule. Jamais de HTML injecté : tout est du texte. */
export function CellDisplay({
  row,
  prop,
  ev,
  locale,
  relationTitle,
}: {
  row: Row;
  prop: Property;
  ev: Evaluator;
  locale: string;
  relationTitle?: ((id: string) => string | undefined) | undefined;
}) {
  const { t } = useTranslation();
  const v = ev.raw(row, prop);
  switch (prop.type) {
    case 'select':
    case 'status': {
      const o = optionsOf(prop).find((x) => x.id === v);
      return o ? <span className={chipClass(o.color)}>{o.name}</span> : null;
    }
    case 'multiselect': {
      const opts = optionsOf(prop);
      const list = Array.isArray(v)
        ? v.map((id) => opts.find((o) => o.id === id)).filter((o): o is SelectOption => !!o)
        : [];
      return (
        <span className="flex min-w-0 flex-wrap gap-1">
          {list.map((o) => (
            <span key={o.id} className={chipClass(o.color)}>
              {o.name}
            </span>
          ))}
        </span>
      );
    }
    case 'relation': {
      const ids = Array.isArray(v) ? (v as string[]) : [];
      return (
        <span className="flex min-w-0 flex-wrap gap-1">
          {ids.map((id) => {
            const title = relationTitle?.(id);
            if (title === undefined) return null; // ligne supprimée ou base non chargée : masquée
            return (
              <span key={id} className="chip">
                {title.trim() === '' ? t('pages.untitled') : title}
              </span>
            );
          })}
        </span>
      );
    }
    case 'checkbox':
      return (
        <span
          aria-label={v === true ? t('databases.checked') : t('databases.unchecked')}
          className={cx(
            'grid size-4 place-items-center rounded border',
            v === true ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-elevated',
          )}
        >
          {v === true ? <Icon name="check" size={11} /> : null}
        </span>
      );
    case 'date':
    case 'datetime':
    case 'created_time':
    case 'last_edited_time':
      return typeof v === 'string' && v ? (
        <span>{fmtDate(v, prop.type !== 'date', locale)}</span>
      ) : null;
    case 'number':
    case 'percent':
      return typeof v === 'number' ? (
        <span className="tabular-nums">
          {formatNumber(v, prop, locale, prop.type === 'percent')}
        </span>
      ) : null;
    case 'id':
      return typeof v === 'number' ? (
        <span className="tabular-nums text-muted">{typeDef('id').toText(v, prop)}</span>
      ) : null;
    case 'formula': {
      const r = ev.formula(row, prop);
      if (!r.ok) {
        return (
          <span className="flex items-center gap-1 text-danger" title={r.error.message}>
            <Icon name="alert-circle" size={13} />
            <span className="truncate">{t(`databases.formulaError.${r.error.code}`)}</span>
          </span>
        );
      }
      const val = r.value;
      if (typeof val === 'boolean')
        return <span>{val ? t('databases.yes') : t('databases.no')}</span>;
      return (
        <span className={cx(typeof val === 'number' && 'tabular-nums')}>
          {ev.text(row, prop, locale)}
        </span>
      );
    }
    case 'url':
    case 'email':
    case 'phone':
      return typeof v === 'string' && v ? (
        <span className="truncate underline decoration-line underline-offset-2">{v}</span>
      ) : null;
    case 'title':
      return (
        <span className={cx('truncate', row.title.trim() === '' && 'text-muted')}>
          {row.title.trim() === '' ? t('pages.untitled') : row.title}
        </span>
      );
    default:
      return typeof v === 'string' && v ? <span className="truncate">{v}</span> : null;
  }
}

const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (s: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(s.trim())) return null;
  const d = new Date(s.trim().replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(0, 19)}Z`;
};

/** Éditeur en ligne (texte, nombre, date…). Entrée valide, Échap annule, Tab valide et passe à la cellule suivante. */
export function InlineInput({
  row,
  prop,
  ev,
  initial,
  onCommit,
  onCancel,
  onTab,
  className,
}: {
  row: Row;
  prop: Property;
  ev: Evaluator;
  /** Caractère tapé pour démarrer l'édition (remplace la valeur). */
  initial?: string | undefined;
  /** `value` : valeur normalisée ; `null` efface. Retourne `false` si refusée (le champ reste ouvert). */
  onCommit(value: unknown): boolean | void;
  onCancel(): void;
  onTab?(dir: 1 | -1): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const def = typeDef(prop.type);
  const current = ev.raw(row, prop);
  const startText =
    initial ??
    (prop.type === 'datetime' && typeof current === 'string'
      ? toLocalInput(current)
      : def.toText(current, prop));
  const [text, setText] = useState(startText);
  const [bad, setBad] = useState(false);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (initial === undefined) ref.current?.select?.();
    else ref.current?.setSelectionRange?.(initial.length, initial.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (): boolean => {
    let value: unknown;
    if (prop.type === 'datetime')
      value = text.trim() === '' ? null : (fromLocalInput(text) ?? undefined);
    else value = def.fromText(text, prop);
    if (value === undefined) {
      setBad(true);
      return false;
    }
    if (done.current) return true;
    // Marqué AVANT l'appel : le parent peut déplacer le focus (blur synchrone) sans déclencher un second enregistrement.
    done.current = true;
    const r = onCommit(value);
    if (r === false) {
      done.current = false;
      setBad(true);
      return false;
    }
    return true;
  };

  const common = {
    ref,
    value: text,
    'aria-label': prop.name,
    'aria-invalid': bad,
    onChange: (e: { target: { value: string } }) => {
      setText(e.target.value);
      setBad(false);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !(prop.type === 'longtext' && e.shiftKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done.current = true;
        onCancel();
      } else if (e.key === 'Tab' && onTab) {
        e.preventDefault();
        if (commit()) onTab(e.shiftKey ? -1 : 1);
      }
    },
    onBlur: () => {
      if (!done.current) {
        if (!commit()) {
          done.current = true;
          onCancel();
        }
      }
    },
    className: cx(
      'h-full w-full min-w-0 select-text rounded-sm border-0 bg-elevated px-2 outline-2 outline-accent',
      bad && 'outline-danger',
      className,
    ),
    placeholder:
      prop.type === 'date'
        ? t('databases.datePlaceholder')
        : prop.type === 'datetime'
          ? t('databases.datetimePlaceholder')
          : undefined,
  };
  return prop.type === 'longtext' ? (
    <textarea
      {...common}
      rows={3}
      className={cx(
        common.className,
        'absolute inset-x-0 top-0 z-10 h-24 resize-none py-1 shadow-pop',
      )}
    />
  ) : (
    <input
      {...common}
      type="text"
      inputMode={prop.type === 'number' || prop.type === 'percent' ? 'decimal' : undefined}
    />
  );
}

/** Liste de choix pour select / statut / multi-sélection. Les options peuvent être créées à la volée (sauf statut). */
export function OptionPicker({
  prop,
  value,
  onChange,
  onCreate,
  onClose,
}: {
  prop: Property;
  value: unknown;
  onChange(v: string | string[] | null): void;
  onCreate?: ((name: string) => Promise<string | undefined>) | undefined;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const multi = prop.type === 'multiselect';
  const options = optionsOf(prop);
  const selected = new Set(
    Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [],
  );
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const shown = useMemo(
    () => options.filter((o) => normalize(o.name).includes(normalize(q.trim()))),
    [options, q],
  );
  const exact = options.some((o) => normalize(o.name) === normalize(q.trim()));
  const canCreate = !!onCreate && prop.type !== 'status' && q.trim() !== '' && !exact;
  const total = shown.length + (canCreate ? 1 : 0);

  const pick = async (i: number) => {
    const o = shown[i];
    if (o) {
      if (multi) {
        const next = new Set(selected);
        if (next.has(o.id)) next.delete(o.id);
        else next.add(o.id);
        onChange(next.size ? [...next] : null);
      } else {
        onChange(selected.has(o.id) ? null : o.id);
        onClose();
      }
    } else if (canCreate && onCreate) {
      const id = await onCreate(q.trim());
      if (id) {
        onChange(multi ? [...selected, id] : id);
        setQ('');
        if (!multi) onClose();
      }
    }
  };

  return (
    <div role="presentation" className="w-60">
      <input
        autoFocus
        aria-label={t('databases.searchOptions')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') setActive((a) => Math.min(total - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter') void pick(active);
          else if (e.key === 'Escape') onClose();
          else return;
          e.preventDefault();
        }}
        placeholder={t('databases.searchOptions')}
        className="mb-1 h-8 w-full select-text rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent"
      />
      <ul
        role="listbox"
        aria-label={prop.name}
        aria-multiselectable={multi}
        className="max-h-60 overflow-y-auto"
      >
        {shown.map((o, i) => (
          <li
            key={o.id}
            role="option"
            aria-selected={selected.has(o.id)}
            onMouseMove={() => setActive(i)}
            onClick={() => void pick(i)}
            className={cx(
              'flex h-8 cursor-default items-center gap-2 rounded-md px-2',
              i === active && 'bg-hover',
            )}
          >
            <span className={chipClass(o.color)}>{o.name}</span>
            {selected.has(o.id) ? (
              <Icon name="check" size={13} className="ml-auto text-muted" />
            ) : null}
          </li>
        ))}
        {canCreate ? (
          <li
            role="option"
            aria-selected={false}
            onMouseMove={() => setActive(shown.length)}
            onClick={() => void pick(shown.length)}
            className={cx(
              'flex h-8 cursor-default items-center gap-2 rounded-md px-2',
              active === shown.length && 'bg-hover',
            )}
          >
            <Icon name="plus" size={13} className="text-muted" />
            {t('databases.createOption', { name: q.trim() })}
          </li>
        ) : null}
        {shown.length === 0 && !canCreate ? (
          <li role="presentation" className="px-2 py-2 text-muted">
            {t('databases.noOptions')}
          </li>
        ) : null}
      </ul>
      {selected.size > 0 ? (
        <button
          type="button"
          onClick={() => {
            onChange(null);
            if (!multi) onClose();
          }}
          className="mt-1 w-full rounded-md px-2 py-1 text-left text-muted hover:bg-hover"
        >
          {t('databases.clear')}
        </button>
      ) : null}
    </div>
  );
}

/** Sélection de lignes d'une base liée. */
export function RelationPicker({
  prop,
  value,
  onChange,
  onClose,
}: {
  prop: Property;
  value: unknown;
  onChange(v: string[] | null): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const target = relationTarget(prop) ?? '';
  const db = useDatabase(target);
  const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const rows = useMemo(
    () =>
      (db?.rows ?? [])
        .filter((r) => normalize(r.title).includes(normalize(q.trim())))
        .slice(0, 100),
    [db, q],
  );
  const toggle = (i: number) => {
    const r = rows[i];
    if (!r) return;
    const next = new Set(selected);
    if (next.has(r.id)) next.delete(r.id);
    else next.add(r.id);
    onChange(next.size ? [...next] : null);
  };
  if (!db || db.status === 'loading')
    return (
      <p role="status" className="w-60 p-2 text-muted">
        {t('databases.loading')}
      </p>
    );
  return (
    <div role="presentation" className="w-64">
      <input
        autoFocus
        aria-label={t('databases.searchRows')}
        placeholder={t('databases.searchRows')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') setActive((a) => Math.min(rows.length - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter') toggle(active);
          else if (e.key === 'Escape') onClose();
          else return;
          e.preventDefault();
        }}
        className="mb-1 h-8 w-full select-text rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent"
      />
      <ul
        role="listbox"
        aria-label={prop.name}
        aria-multiselectable
        className="max-h-60 overflow-y-auto"
      >
        {rows.map((r, i) => (
          <li
            key={r.id}
            role="option"
            aria-selected={selected.has(r.id)}
            onMouseMove={() => setActive(i)}
            onClick={() => toggle(i)}
            className={cx(
              'flex h-8 cursor-default items-center gap-2 rounded-md px-2',
              i === active && 'bg-hover',
            )}
          >
            <Icon name="paper" size={13} className="text-muted" />
            <span className="truncate">
              {r.title.trim() === '' ? t('pages.untitled') : r.title}
            </span>
            {selected.has(r.id) ? (
              <Icon name="check" size={13} className="ml-auto text-muted" />
            ) : null}
          </li>
        ))}
        {rows.length === 0 ? (
          <li role="presentation" className="px-2 py-2 text-muted">
            {t('databases.noRows')}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
