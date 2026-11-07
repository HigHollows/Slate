import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton, Kbd, isMac } from '../../shared/ui';
import {
  commandTitleKey,
  eventToCombo,
  findConflict,
  isBindable,
  resolveBindings,
  useCommandsState,
  useCommandsStore,
  type Command,
} from '../commands';

export function ShortcutsTab({ commands }: { commands: Command[] }) {
  const { t } = useTranslation();
  const store = useCommandsStore();
  const overrides = useCommandsState((s) => s.overrides);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const bindings = resolveBindings(commands, overrides);
  const rows = commands.filter((c) => c.defaultShortcut || c.id in overrides || !c.hidden);

  const capture = (e: KeyboardEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setEditing(null);
      setMessage(null);
      return;
    }
    const combo = eventToCombo(e.nativeEvent, isMac());
    if (!combo) return; // simple modificateur : on attend la touche
    if (!isBindable(combo)) {
      setMessage(t('shortcuts.needModifier'));
      return;
    }
    const conflict = findConflict(bindings, id, combo);
    if (conflict?.kind === 'reserved') {
      setMessage(t('shortcuts.reserved'));
      return;
    }
    if (conflict?.kind === 'command') {
      const other = commands.find((c) => c.id === conflict.id);
      setMessage(
        t('shortcuts.conflict', { command: other ? t(commandTitleKey(other.id)) : conflict.id }),
      );
      return;
    }
    void store
      .getState()
      .setShortcut(id, combo)
      .then(() => {
        setEditing(null);
        setMessage(null);
      })
      .catch(() => undefined); // l'erreur est signalée par le store
  };

  return (
    <section aria-labelledby="tab-shortcuts">
      <h2 id="tab-shortcuts" className="sr-only">
        {t('settings.tabs.shortcuts')}
      </h2>
      <p className="pb-3 text-muted">{t('shortcuts.intro')}</p>
      <ul>
        {rows.map((c) => {
          const combo = bindings.get(c.id);
          const isEditing = editing === c.id;
          const customised = c.id in overrides;
          return (
            <li
              key={c.id}
              className="flex min-h-11 items-center gap-3 border-b border-line py-1.5 last:border-0"
            >
              <span className="flex-1">{t(commandTitleKey(c.id))}</span>
              {isEditing ? (
                <div
                  tabIndex={0}
                  role="textbox"
                  aria-label={t('shortcuts.capturing', { command: t(commandTitleKey(c.id)) })}
                  onKeyDown={(e) => capture(e, c.id)}
                  onBlur={() => {
                    setEditing(null);
                    setMessage(null);
                  }}
                  ref={(el) => el?.focus()}
                  className="rounded-md border border-accent px-2 py-1 text-muted"
                >
                  {message ?? t('shortcuts.pressKeys')}
                </div>
              ) : combo ? (
                <Kbd combo={combo} />
              ) : (
                <span className="text-muted">{t('shortcuts.none')}</span>
              )}
              {!isEditing ? (
                <>
                  <IconButton
                    icon="pen"
                    label={t('shortcuts.edit', { command: t(commandTitleKey(c.id)) })}
                    onClick={() => {
                      setEditing(c.id);
                      setMessage(null);
                    }}
                  />
                  {combo ? (
                    <IconButton
                      icon="cross"
                      label={t('shortcuts.remove', { command: t(commandTitleKey(c.id)) })}
                      onClick={() =>
                        void store
                          .getState()
                          .setShortcut(c.id, null)
                          .catch(() => undefined)
                      }
                    />
                  ) : null}
                  {customised ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void store
                          .getState()
                          .resetShortcut(c.id)
                          .catch(() => undefined)
                      }
                    >
                      {t('shortcuts.reset')}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
