import { test, expect } from "@playwright/test";
for (const framework of ["react", "vue", "svelte", "angular", "astro"]) {
  test(`${framework} renders custom rows and uploads through the real server`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/frameworks/${framework}/`);
    await page.getByLabel("Select files").setInputFiles({
      name: `${framework}-document.txt`,
      mimeType: "text/plain",
      buffer: Buffer.alloc(600000, 65),
    });
    const row = page.locator("article.custom-row");
    await expect(row).toContainText(`${framework}-document.txt`);
    if (framework !== "astro") {
      await expect(
        page.getByRole("button", { name: "Disabled upload", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Blocked upload", exact: true })
        .click();
      await expect(row).toHaveAttribute("data-state", "idle");
    }
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(row).toHaveAttribute("data-state", "completed");
    await expect(row.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    if (framework !== "astro") {
      await page.getByRole("button", { name: "Disable root" }).click();
      await expect(page.getByLabel("Select files")).toBeDisabled();
    } else
      await expect(page.locator("[data-upload-output]")).toContainText(
        "completed",
      );
    expect(errors).toEqual([]);
  });
}
test("HTTP and indeterminate recipes use the local single-request endpoint", async ({
  page,
}) => {
  await page.goto("/");
  for (const kind of ["http", "indeterminate"]) {
    const root = page.locator(`#${kind}`);
    await root.locator("[data-upload-input]").setInputFiles({
      name: `${kind}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("single request body"),
    });
    await root
      .getByRole("button", { name: "Upload files", exact: true })
      .click();
    await expect(root.locator(".file-status")).toHaveText("completed");
    await expect(root.locator("[data-percentage]")).toHaveText("100%");
  }
});

for (const framework of ["react", "vue", "svelte", "angular", "astro"]) {
  test(`${framework} retries after cancel without reusing the canceled session`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/frameworks/${framework}/`);
    await page.getByLabel("Select files").setInputFiles({
      name: `cancel-${framework}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.alloc(1024 * 1024, 67),
    });
    const row = page.locator("article.custom-row");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(row).toHaveAttribute("data-state", "uploading");
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row).toHaveAttribute("data-state", "canceled");
    await row.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(row).toHaveAttribute("data-state", "completed");
    expect(errors).toEqual([]);
  });
}

test("React releases an owned store on replacement without destroying a borrowed store", async ({
  page,
}) => {
  await page.goto("/frameworks/react/");
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__auditOwned))
    .toBe(true);
  await page
    .getByRole("button", { name: "Replace owned store", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          (window as any).__auditOwned.setOptions({ disabled: true });
          return false;
        } catch {
          return true;
        }
      }),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Unmount borrowed root", exact: true })
    .click();
  expect(
    await page.evaluate(() => {
      try {
        (window as any).__auditBorrowed.setOptions({ disabled: true });
        return true;
      } catch {
        return false;
      }
    }),
  ).toBe(true);
});
