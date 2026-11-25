import { test, expect } from "@playwright/test";

test.use({ headless: true });

test.describe("Soroban Anchor Gate Web Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/SorobanAnchor/);
  });

  test.describe("Escrow creation flow", () => {
    test("renders the escrow creation form and wallet connect button", async ({
      page,
    }) => {
      await expect(
        page.getByRole("button", { name: /Connect Freighter/ })
      ).toBeVisible();
      await expect(
        page.getByPlaceholder(/Beneficiary Stellar Public Key/)
      ).toBeVisible();
      await expect(page.getByPlaceholder(/100\.00/)).toBeVisible();
      await expect(
        page.getByPlaceholder(/e\.g\. IBAN:/)
      ).toBeVisible();
    });

    test("fills escrow creation form and reports wallet required on submit", async ({
      page,
    }) => {
      await page
        .getByPlaceholder(/Beneficiary Stellar Public Key/)
        .fill("GAAAAA1111111111111111111111111111111111111111111111111111");
      await page.getByPlaceholder(/100\.00/).fill("100");
      await page.getByPlaceholder(/e\.g\. IBAN:/).fill("IBAN: DE89370400440532013000");
      await page.getByPlaceholder(/7/).fill("7");

      await page.getByRole("button", { name: /Initialize Escrow on Testnet/ }).click();

      await expect(page.getByText(/Status: failed/)).toBeVisible({ timeout: 10000 });
      await expect(
        page.getByText(/Invalid payer wallet address/)
      ).toBeVisible({ timeout: 10000 });
    });

    test("connect wallet button opens the wallet connection flow", async ({
      page,
    }) => {
      await page.getByRole("button", { name: /Connect Freighter/ }).click();
      await expect(
        page.getByText(/Freighter wallet extension not found/)
      ).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe("Filterable dashboard table", () => {
    test("renders all sample escrow rows by default", async ({ page }) => {
      await expect(page.getByRole("heading", { name: /Escrow Dashboard/ })).toBeVisible();
      for (const id of ["E-001", "E-002", "E-003", "E-004", "E-005"]) {
        await expect(page.getByText(id, { exact: true })).toBeVisible();
      }
    });

    test("filters rows by status", async ({ page }) => {
      await page.getByRole("button", { name: "Disbursed" }).click();
      await expect(page.getByText("E-002", { exact: true })).toBeVisible();
      await expect(page.getByText("E-001", { exact: true })).not.toBeVisible();
      await expect(page.getByText("E-003", { exact: true })).not.toBeVisible();
      await expect(page.getByText("E-004", { exact: true })).not.toBeVisible();
      await expect(page.getByText("E-005", { exact: true })).not.toBeVisible();
    });

    test("searches rows by escrow id", async ({ page }) => {
      await page
        .getByPlaceholder(/Escrow ID, recipient, or token\.\.\./)
        .fill("E-003");
      await expect(page.getByText("E-003", { exact: true })).toBeVisible();
      await expect(page.getByText("E-001", { exact: true })).not.toBeVisible();
    });

    test("clears filters and restores all rows", async ({ page }) => {
      await page.getByRole("button", { name: "Disbursed" }).click();
      await expect(page.getByText("E-001", { exact: true })).not.toBeVisible();
      await page.getByRole("button", { name: /Clear/ }).click();
      for (const id of ["E-001", "E-002", "E-003", "E-004", "E-005"]) {
        await expect(page.getByText(id, { exact: true })).toBeVisible();
      }
    });
  });
});
