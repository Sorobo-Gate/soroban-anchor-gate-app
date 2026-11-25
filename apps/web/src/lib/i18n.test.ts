import assert from "node:assert";
import { describe, test } from "node:test";
import en from "../locales/en.json";
import es from "../locales/es.json";
import pt from "../locales/pt.json";
import fr from "../locales/fr.json";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALE_OPTIONS,
  collectTranslationKeys,
  isSupportedLocale,
  resolveKey,
  translate,
} from "../locales";

describe("Multi-Language Localization (i18n) Framework", () => {
  const enKeys = collectTranslationKeys(en as Record<string, unknown>);

  test("all supported locales (en, es, pt, fr) have identical translation keys", () => {
    assert.ok(enKeys.length > 0, "English dictionary must contain translation keys");

    const dicts: Record<string, Record<string, unknown>> = { en, es, pt, fr };
    for (const locale of SUPPORTED_LOCALES) {
      const localeKeys = collectTranslationKeys(dicts[locale]);
      const missingInLocale = enKeys.filter((k) => !localeKeys.includes(k));
      const extraInLocale = localeKeys.filter((k) => !enKeys.includes(k));

      assert.deepStrictEqual(
        missingInLocale,
        [],
        `Locale '${locale}' is missing keys: ${missingInLocale.join(", ")}`
      );
      assert.deepStrictEqual(
        extraInLocale,
        [],
        `Locale '${locale}' has extra unmapped keys: ${extraInLocale.join(", ")}`
      );
    }
  });

  test("no translation value is empty or whitespace-only across any locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const dict = DICTIONARIES[locale] as unknown as Record<string, unknown>;
      for (const key of enKeys) {
        const value = resolveKey(dict, key);
        assert.strictEqual(typeof value, "string", `Expected string for ${locale}.${key}`);
        assert.ok(
          value && value.trim().length > 0,
          `Translation ${locale}.${key} must not be empty`
        );
      }
    }
  });

  test("interpolation placeholders match English across all locales", () => {
    const extractPlaceholders = (text: string): string[] => {
      const matches = text.match(/\{[a-zA-Z0-9_]+\}/g);
      return matches ? [...matches].sort() : [];
    };

    for (const key of enKeys) {
      const enVal = resolveKey(en as unknown as Record<string, unknown>, key) ?? "";
      const expectedVars = extractPlaceholders(enVal);

      for (const locale of SUPPORTED_LOCALES) {
        const val =
          resolveKey(DICTIONARIES[locale] as unknown as Record<string, unknown>, key) ?? "";
        assert.deepStrictEqual(
          extractPlaceholders(val),
          expectedVars,
          `Placeholder mismatch in ${locale}.${key}`
        );
      }
    }
  });

  test("translate() interpolates variables and falls back gracefully on unknown keys", () => {
    assert.strictEqual(DEFAULT_LOCALE, "en");
    assert.strictEqual(translate("en", "escrowForm.tokensUnit", { amount: "42.50" }), "42.50 tokens");
    assert.strictEqual(translate("fr", "escrowForm.tokensUnit", { amount: "42.50" }), "42.50 jetons");
    assert.strictEqual(translate("es", "common.connectWallet"), "Conectar Freighter");
    assert.strictEqual(translate("pt", "common.connectWallet"), "Conectar Freighter");
    assert.strictEqual(translate("es", "nonexistent.key"), "nonexistent.key");
  });

  test("isSupportedLocale and LOCALE_OPTIONS cover exactly en, es, pt, fr", () => {
    assert.strictEqual(isSupportedLocale("en"), true);
    assert.strictEqual(isSupportedLocale("es"), true);
    assert.strictEqual(isSupportedLocale("pt"), true);
    assert.strictEqual(isSupportedLocale("fr"), true);
    assert.strictEqual(isSupportedLocale("de"), false);
    assert.strictEqual(isSupportedLocale(null), false);
    assert.deepStrictEqual(
      LOCALE_OPTIONS.map((o) => o.code),
      ["en", "es", "pt", "fr"]
    );
  });
});
