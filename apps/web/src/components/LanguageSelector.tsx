"use client";

import React from "react";
import { Globe } from "lucide-react";
import { LOCALE_OPTIONS, isSupportedLocale, useI18n } from "@/locales";

export interface LanguageSelectorProps {
  className?: string;
}

/**
 * Accessible header dropdown allowing users to switch between EN, ES, PT, and FR.
 */
export function LanguageSelector({ className = "" }: LanguageSelectorProps) {
  const { locale, setLocale, t } = useI18n();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (isSupportedLocale(next)) {
      setLocale(next);
    }
  };

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-xl border border-border bg-input/60 px-2.5 py-1.5 text-xs text-foreground ${className}`}
      data-testid="language-selector"
    >
      <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
      <label htmlFor="soroban-language-select" className="sr-only">
        {t("common.selectLanguage")}
      </label>
      <select
        id="soroban-language-select"
        aria-label={t("common.selectLanguage")}
        value={locale}
        onChange={handleChange}
        className="bg-transparent font-medium text-foreground focus:outline-none cursor-pointer pr-1"
      >
        {LOCALE_OPTIONS.map((option) => (
          <option
            key={option.code}
            value={option.code}
            className="bg-card text-foreground"
          >
            {option.flag} {option.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
