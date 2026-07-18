import { expect, test, type Page } from "@playwright/test";

async function interceptEmptyRuns(page: Page): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });
}

test("shows only the requested keyword-map option label", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize application" });
  const option = initializer.locator(".run-initializer__option");
  const checkbox = initializer.getByRole("checkbox", {
    name: "Generate resume to job Description keyword map",
    exact: true,
  });

  await expect(checkbox).toBeChecked();
  await expect(checkbox).not.toHaveAttribute("aria-describedby", /.+/);
  await expect(option).toHaveText("Generate resume to job Description keyword map");
  await expect(page.getByText("Generate keyword map PDF", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Creates a side-by-side visualization of your resume and the full job description.", { exact: true })).toHaveCount(0);
  await expect(option.locator("label")).toHaveCSS("color", "rgb(238, 241, 236)");
});
