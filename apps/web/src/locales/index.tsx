"use client";

import React, { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import en from "./en.json";
import es from "./es.json";
import pt from "./pt.json";
import fr from "./fr.json";

export const SUPPORTED_LOCALES = ["en", "es", "pt", "fr"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "soroban_anchor_locale";

export interface LocaleOption {
  code: Locale;
  label: string;
  nativeName: string;
  flag: string;
}

export const LOCALE_OPTIONS: LocaleOption[] = [
  { code: "en", label: "English", nativeName: "English", flag: "🇺🇸" },
  { code: "es", label: "Spanish", nativeName: "Español", flag: "🇪🇸" },
  { code: "pt", label: "Portuguese", nativeName: "Português", flag: "🇧🇷" },
  { code: "fr", label: "French", nativeName: "Français", flag: "🇫🇷" },
];

export type TranslationDictionary = typeof en;

export const DICTIONARIES: Record<Locale, TranslationDictionary> = {
  en,
  es,
  pt,
  fr,
};

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolves a dot-separated translation key against a dictionary object.
 */
export function resolveKey(dict: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * Pure translation helper supporting English fallback and `{var}` interpolation.
 */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>
): string {
  const primary = resolveKey(DICTIONARIES[locale] as unknown as Record<string, unknown>, key);
  const fallback = resolveKey(DICTIONARIES[DEFAULT_LOCALE] as unknown as Record<string, unknown>, key);
  let text = primary ?? fallback ?? key;

  if (vars) {
    for (const [varName, varValue] of Object.entries(vars)) {
      text = text.replaceAll(`{${varName}}`, String(varValue));
    }
  }
  return text;
}

/**
 * Recursively collects all leaf translation keys in dot notation.
 */
export function collectTranslationKeys(
  obj: Record<string, unknown>,
  prefix = ""
): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...collectTranslationKeys(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
});

const localeListeners = new Set<() => void>();

function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", listener);
  }
  return () => {
    localeListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", listener);
    }
  };
}

function getClientLocaleSnapshot(fallback: Locale): Locale {
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(saved)) {
      return saved;
    }
    const browserLang = window.navigator.language?.slice(0, 2).toLowerCase();
    if (isSupportedLocale(browserLang)) {
      return browserLang;
    }
  } catch {
    // Ignore storage access errors in restricted browser contexts
  }
  return fallback;
}

export function I18nProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
}) {
  const locale = useSyncExternalStore(
    subscribeLocale,
    () => getClientLocaleSnapshot(initialLocale),
    () => initialLocale
  );

  useEffect(() => {
    try {
      document.documentElement.lang = locale;
    } catch {
      // Ignore DOM access errors
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Ignore storage access errors in restricted browser contexts
    }
    for (const listener of localeListeners) {
      listener();
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale]
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
