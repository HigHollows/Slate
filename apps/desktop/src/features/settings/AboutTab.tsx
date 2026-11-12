import { useTranslation } from 'react-i18next';
import { SystemStatus } from '../system';
import { UpdatesSection } from '../updates';
import type { AppConfig } from '../../shared/config/env';
import type { Ipc } from '../../shared/ipc/client';

export function AboutTab({ ipc, config }: { ipc: Pick<Ipc, 'systemInfo'>; config: AppConfig }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="tab-about" className="space-y-6">
      <h2 id="tab-about" className="text-base font-semibold">
        {t('system.title')}
      </h2>
      <SystemStatus ipc={ipc} config={config} />
      <UpdatesSection />
      <div>
        <h3 className="mb-1 font-medium">{t('about.licenses')}</h3>
        <ul className="list-inside list-disc text-muted">
          <li>{t('about.papicons')}</li>
          <li>{t('about.inter')}</li>
          <li>{t('about.radix')}</li>
        </ul>
      </div>
    </section>
  );
}
