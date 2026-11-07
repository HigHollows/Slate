import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import fr from './locales/fr.json';
import en from './locales/en.json';

export const SUPPORTED_LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function detectLocale(lang: string | undefined): Locale {
  return lang?.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

export async function initI18n(lang?: string): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources: { fr: { translation: fr }, en: { translation: en } },
    lng: detectLocale(lang ?? navigator.language),
    fallbackLng: 'fr',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}
export { i18n };
