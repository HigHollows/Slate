import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { compile, FormulaError, FUNCTION_NAMES } from '@slate/formula';
import { Button, Dialog } from '../../shared/ui';
import { useDatabase, useDatabasesStore } from './context';
import { CREATABLE_TYPES } from './registry';
import { OPTION_COLORS, optionsOf, STATUS_GROUPS, type Property, type PropertyType } from './types';

const field =
  'h-9 w-full select-text rounded-md border border-line bg-surface px-2 outline-none focus-visible:border-accent';
/** Miroir de la matrice de conversions sans perte du cœur Rust (le cœur reste l'arbitre). */
const CONVERTIBLE: Record<string, string[]> = {
  text: ['text', 'longtext', 'url', 'email', 'phone'],
  longtext: ['longtext', 'text'],
  url: ['url', 'text', 'longtext'],
  email: ['email', 'text', 'longtext'],
  phone: ['phone', 'text', 'longtext'],
  number: ['number', 'percent'],
  percent: ['percent', 'number'],
  date: ['date', 'datetime'],
  select: ['select', 'multiselect', 'status'],
  status: ['status', 'select'],
};

interface Opt {
  id?: string;
  name: string;
  color: string;
  group?: string;
}

export function PropertyDialog({
  dbId,
  property,
  databases,
  open,
  onClose,
}: {
  dbId: string;
  property: Property | null;
  databases: { id: string; title: string }[];
  open: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const store = useDatabasesStore();
  const db = useDatabase(dbId);
  const editing = property !== null;
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('text');
  const [options, setOptions] = useState<Opt[]>([]);
  const [decimals, setDecimals] = useState(0);
  const [prefix, setPrefix] = useState('');
  const [suffix, setSuffix] = useState('');
  const [expression, setExpression] = useState('');
  const [target, setTarget] = useState('');
  const [twoWay, setTwoWay] = useState(true);
  const [reverseName, setReverseName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setFailed(false);
    if (property) {
      setName(property.name);
      setType(property.type);
      setOptions(
        optionsOf(property).map((o) => ({
          id: o.id,
          name: o.name,
          color: o.color,
          ...(o.group ? { group: o.group } : {}),
        })),
      );
      setDecimals(
        typeof property.config['decimals'] === 'number' ? property.config['decimals'] : 0,
      );
      setPrefix(String(property.config['prefix'] ?? ''));
      setSuffix(String(property.config['suffix'] ?? ''));
      setExpression(String(property.config['expression'] ?? ''));
      setTarget(String(property.config['targetDatabaseId'] ?? ''));
    } else {
      setName('');
      setType('text');
      setOptions([]);
      setDecimals(0);
      setPrefix('');
      setSuffix('');
      setExpression('');
      setTarget(databases[0]?.id ?? '');
      setTwoWay(true);
      setReverseName(db?.node?.title ?? '');
    }
  }, [open, property, databases, db?.node?.title]);

  const formulaError = useMemo(() => {
    if (type !== 'formula' || expression.trim() === '') return null;
    try {
      compile(expression);
      return null;
    } catch (e) {
      return e instanceof FormulaError ? e : null;
    }
  }, [type, expression]);

  const types = editing ? (CONVERTIBLE[property.type] ?? [property.type]) : CREATABLE_TYPES;
  const config = (): Record<string, unknown> => {
    switch (type) {
      case 'select':
      case 'multiselect':
      case 'status':
        return {
          options: options
            .filter((o) => o.name.trim())
            .map((o) => ({
              ...(o.id ? { id: o.id } : {}),
              name: o.name.trim(),
              color: o.color,
              ...(type === 'status' ? { group: o.group ?? 'todo' } : {}),
            })),
        };
      case 'number':
      case 'percent':
        return { decimals, prefix, suffix };
      case 'formula':
        return { expression };
      case 'id':
        return { prefix };
      case 'relation':
        return { targetDatabaseId: target };
      default:
        return {};
    }
  };
  const valid =
    name.trim() !== '' && !formulaError && (type !== 'relation' || target !== '' || editing);

  const save = async () => {
    setBusy(true);
    const ok = editing
      ? await store.getState().updateProperty(dbId, property.id, {
          ...(name.trim() !== property.name ? { name: name.trim() } : {}),
          config: config(),
          ...(type !== property.type ? { type } : {}),
        })
      : await store.getState().addProperty(dbId, {
          name: name.trim(),
          type,
          config: config(),
          ...(type === 'relation' && twoWay
            ? { twoWayName: reverseName.trim() || (db?.node?.title ?? t('pages.untitled')) }
            : {}),
        });
    setBusy(false);
    setFailed(!ok);
    if (ok) onClose();
  };

  const optionEditable = type === 'select' || type === 'multiselect' || type === 'status';
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={editing ? t('databases.editProperty') : t('databases.addProperty')}
      className="w-[min(92vw,34rem)]"
    >
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void save();
        }}
      >
        <label className="block space-y-1">
          <span className="font-medium">{t('databases.propertyName')}</span>
          <input
            autoFocus
            className={field}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {property?.type !== 'title' ? (
          <label className="block space-y-1">
            <span className="font-medium">{t('databases.propertyType')}</span>
            <select
              className={field}
              value={type}
              onChange={(e) => setType(e.target.value as PropertyType)}
              disabled={editing && types.length <= 1}
            >
              {types.map((k) => (
                <option key={k} value={k}>
                  {t(`databases.type.${k}`)}
                </option>
              ))}
            </select>
            {editing && types.length > 1 ? (
              <span className="text-xs text-muted">{t('databases.typeLossless')}</span>
            ) : null}
          </label>
        ) : null}

        {optionEditable ? (
          <fieldset className="space-y-1.5">
            <legend className="font-medium">{t('databases.options')}</legend>
            {options.map((o, i) => (
              <div key={o.id ?? i} className="flex items-center gap-1.5">
                <input
                  aria-label={t('databases.optionName')}
                  className={`${field} flex-1`}
                  value={o.name}
                  onChange={(e) =>
                    setOptions(
                      options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <select
                  aria-label={t('databases.optionColor')}
                  className="h-9 rounded-md border border-line bg-surface px-1"
                  value={o.color}
                  onChange={(e) =>
                    setOptions(
                      options.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)),
                    )
                  }
                >
                  {OPTION_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {t(`databases.color.${c}`)}
                    </option>
                  ))}
                </select>
                {type === 'status' ? (
                  <select
                    aria-label={t('databases.optionGroup')}
                    className="h-9 rounded-md border border-line bg-surface px-1"
                    value={o.group ?? 'todo'}
                    onChange={(e) =>
                      setOptions(
                        options.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)),
                      )
                    }
                  >
                    {STATUS_GROUPS.map((g) => (
                      <option key={g} value={g}>
                        {t(`databases.statusGroup.${g}`)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button
                  variant="ghost"
                  aria-label={t('databases.removeOption', { name: o.name })}
                  onClick={() => setOptions(options.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              icon="plus"
              onClick={() =>
                setOptions([
                  ...options,
                  { name: '', color: 'gray', ...(type === 'status' ? { group: 'todo' } : {}) },
                ])
              }
            >
              {t('databases.addOption')}
            </Button>
            {editing ? (
              <p className="text-xs text-muted">{t('databases.removeOptionHint')}</p>
            ) : null}
          </fieldset>
        ) : null}

        {type === 'number' || type === 'percent' ? (
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1">
              <span className="font-medium">{t('databases.decimals')}</span>
              <input
                type="number"
                min={0}
                max={8}
                className={field}
                value={decimals}
                onChange={(e) => setDecimals(Math.min(8, Math.max(0, Number(e.target.value))))}
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium">{t('databases.prefix')}</span>
              <input
                className={field}
                maxLength={12}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium">{t('databases.suffix')}</span>
              <input
                className={field}
                maxLength={12}
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
              />
            </label>
          </div>
        ) : null}
        {type === 'id' ? (
          <label className="block space-y-1">
            <span className="font-medium">{t('databases.prefix')}</span>
            <input
              className={field}
              maxLength={12}
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </label>
        ) : null}

        {type === 'formula' ? (
          <div className="space-y-1">
            <label className="block space-y-1">
              <span className="font-medium">{t('databases.formula')}</span>
              <textarea
                aria-label={t('databases.formula')}
                aria-invalid={!!formulaError}
                rows={3}
                className={`${field} h-auto select-text py-1.5 font-mono`}
                value={expression}
                maxLength={2000}
                onChange={(e) => setExpression(e.target.value)}
                placeholder='prop("Prix") * prop("Quantité")'
              />
            </label>
            {formulaError ? (
              <p role="alert" className="text-danger">
                {t(`databases.formulaError.${formulaError.code}`)} — {formulaError.message}
              </p>
            ) : null}
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{t('databases.formulaHelp')}</summary>
              <p className="mt-1 break-words font-mono">{FUNCTION_NAMES.join(', ')}</p>
            </details>
          </div>
        ) : null}

        {type === 'relation' && !editing ? (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="font-medium">{t('databases.relationTarget')}</span>
              <select className={field} value={target} onChange={(e) => setTarget(e.target.value)}>
                {databases.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title.trim() || t('pages.untitled')}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={twoWay}
                onChange={(e) => setTwoWay(e.target.checked)}
                className="size-4 accent-[var(--accent)]"
              />
              {t('databases.twoWay')}
            </label>
            {twoWay ? (
              <label className="block space-y-1">
                <span className="font-medium">{t('databases.reverseName')}</span>
                <input
                  className={field}
                  value={reverseName}
                  onChange={(e) => setReverseName(e.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {failed ? (
          <p role="alert" className="text-danger">
            {t('databases.saveFailed')}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 pt-1">
          {editing && property.type !== 'title' ? (
            confirmDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-muted">{t('databases.deletePropertyConfirm')}</span>
                <Button
                  variant="danger"
                  onClick={() =>
                    void store
                      .getState()
                      .removeProperty(dbId, property.id)
                      .then((ok) => ok && onClose())
                  }
                >
                  {t('databases.deleteProperty')}
                </Button>
              </span>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                {t('databases.deleteProperty')}
              </Button>
            )
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={!valid || busy}>
              {editing ? t('common.apply') : t('databases.create')}
            </Button>
          </span>
        </div>
      </form>
    </Dialog>
  );
}
