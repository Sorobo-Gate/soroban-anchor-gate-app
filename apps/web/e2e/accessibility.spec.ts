import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core"), "utf8");

const ROUTES = ["/", "/create", "/disputes"] as const;

test.describe("WCAG 2.1 AA axe-core accessibility & keyboard navigation audit", () => {
  for (const route of ROUTES) {
    test(`${route} has zero axe-core WCAG 2.1 AA violations`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await page.addScriptTag({ content: axeSource });

      const results = await page.evaluate(async () => {
        const win = window as unknown as {
          axe: {
            run: (
              context: Document,
              options: { runOnly: { type: string; values: string[] } }
            ) => Promise<{ violations: Array<{ id: string; impact?: string; description: string; nodes: Array<{ html: string }> }> }>;
          };
        };
        return win.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
        });
      });

      expect(
        results.violations,
        `Accessibility violations on ${route}:\n${JSON.stringify(results.violations, null, 2)}`
      ).toEqual([]);
    });
  }

  test("skip link moves keyboard focus to main content on Tab + Enter", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("dashboard workspace switcher responds to Enter and ArrowRight/ArrowLeft", async ({ page }) => {
    await page.goto("/");
    const createBtn = page.getByRole("button", { name: /Deposit Milestone Escrow/ });
    const manageBtn = page.getByRole("button", { name: /Manage Escrow/ });

    await createBtn.focus();
    await expect(createBtn).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight");
    await expect(manageBtn).toHaveAttribute("aria-pressed", "true");
    await expect(manageBtn).toBeFocused();

    await page.keyboard.press("ArrowLeft");
    await expect(createBtn).toHaveAttribute("aria-pressed", "true");
  });
});
