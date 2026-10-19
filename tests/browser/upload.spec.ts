import { test, expect } from "@playwright/test";
test("real upload, per-item controls and code tabs remain independent", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("#chunked");
  await root.locator("input[type=file]").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(1024 * 1024, 65),
  });
  await expect(root.locator(".file-name")).toHaveText("sample.txt");
  await root.getByRole("button", { name: "Upload files", exact: true }).click();
  await expect(root.locator(".file-status")).toHaveText("completed");
  await expect(root.locator("[data-percentage]")).toHaveText("100%");
  await root.getByRole("tab", { name: "Code", exact: true }).click();
  await root.getByRole("tab", { name: "Svelte", exact: true }).click();
  await expect(root.locator("pre")).toContainText("<FileUploader.Root");
  await expect(page.locator('#resume [data-language="React"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await root.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(root.locator(".file-status")).toHaveText("completed");
});
test("disabled selection and custom validation state are visible", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("#limits");
  await root.getByLabel("Disabled", { exact: true }).check();
  await expect(root.locator("[data-upload-trigger]")).toBeDisabled();
  await root.getByLabel("Disabled", { exact: true }).uncheck();
  await root.locator("[data-upload-input]").setInputFiles({
    name: "document.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("example"),
  });
  await expect(root.locator("[data-item-error]")).toHaveText(
    "File format is not accepted",
  );
  await expect(root.locator('[data-upload-action="retry"]')).toBeHidden();
});
test("retry simulation can be canceled during the countdown", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("#retry");
  await root.locator("[data-upload-input]").setInputFiles({
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(1024 * 1024, 66),
  });
  await root.getByRole("button", { name: "Reject next request" }).click();
  await root.getByRole("button", { name: "Upload files", exact: true }).click();
  await expect(root.locator(".file-status")).toHaveText("retrying");
  await root.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(root.locator(".file-status")).toHaveText("canceled");
});
test("restores after reload and continues with the original file", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("#resume");
  const upload = {
    name: `resume-${Date.now()}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.alloc(8 * 1024 * 1024, 67),
  };
  await root.locator("[data-upload-input]").setInputFiles(upload);
  await root.getByRole("button", { name: "Upload files", exact: true }).click();
  await expect(root.locator("[data-confirmed]").first()).toBeVisible();
  await root.getByRole("button", { name: "Pause", exact: true }).click();
  await page.reload();
  const restored = page
    .locator("#resume .file-row")
    .filter({ hasText: upload.name });
  await expect(restored.locator(".file-status")).toHaveText("awaiting-file");
  await restored.locator("[data-original]").setInputFiles(upload);
  await expect(restored.locator(".file-status")).toHaveText("completed", {
    timeout: 15000,
  });
});
test("mobile layout does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("removing an uploaded file preserves its session and handles a missing download", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const upload = page.locator("#http");
  const name = `real-history-${Date.now()}.txt`;
  const content = Buffer.from("Completed file for removal");
  await upload
    .locator("[data-upload-input]")
    .setInputFiles({ name, mimeType: "text/plain", buffer: content });
  await upload
    .getByRole("button", { name: "Upload files", exact: true })
    .click();
  await expect(upload.locator(".file-status")).toHaveText("completed");
  const records = await (await request.get("/demo/history")).json();
  const saved = records.find(
    (item: { metadata: { name: string } }) => item.metadata.name === name,
  );
  expect(saved).toBeDefined();
  expect(await (await request.get(`/demo/files/${saved.id}`)).body()).toEqual(
    content,
  );
  const checkpoint = await (await request.get(`/uploads/${saved.id}`)).json();
  const history = page.locator("#history");
  await history
    .getByRole("button", { name: "Load uploaded files", exact: true })
    .click();
  const row = history.locator(".history-row").filter({ hasText: name });
  await history
    .getByRole("button", { name: "Reject next removal", exact: true })
    .click();
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toContainText("Could not remove the file");
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await request.get(`/demo/files/${saved.id}`)).status()).toBe(404);
  expect(await (await request.get(`/uploads/${saved.id}`)).json()).toEqual(
    checkpoint,
  );
  expect((await request.get("/demo/history")).ok()).toBe(true);
});

for (const example of [
  "http",
  "chunked",
  "resume",
  "retry",
  "parallel",
  "indeterminate",
  "gallery",
  "limits",
]) {
  test(`${example} can cancel and retry without an error flash`, async ({
    page,
  }) => {
    await page.goto("/");
    const root = page.locator("#" + example);
    // Block the real request until the UI has canceled it, including the single-request endpoint.
    await page.route(
      "**/demo/http",
      (route) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            void route
              .continue()
              .catch(() => {})
              .finally(resolve);
          }, 250);
        }),
    );
    await root
      .locator("[data-upload-input]")
      .setInputFiles({
        name: "cancel-" + example + ".png",
        mimeType: "image/png",
        buffer: Buffer.alloc(1024 * 1024, 65),
      });
    const row = root.locator(".file-row");
    await row.evaluate((element) => {
      const seen: string[] = [];
      (window as any).__cancelErrors = seen;
      new MutationObserver(() => {
        const text = element.querySelector("[data-item-error]")?.textContent;
        if (text) seen.push(text);
      }).observe(element, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await root
      .getByRole("button", { name: "Upload files", exact: true })
      .click();
    await expect(row.locator(".file-status")).toHaveText("uploading");
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row.locator(".file-status")).toHaveText("canceled");
    await expect(
      row.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await expect(root.locator(".cleanups")).toBeEmpty();
    await row.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(row.locator(".file-status")).toHaveText("completed");
    expect(await page.evaluate(() => (window as any).__cancelErrors)).toEqual(
      [],
    );
    await expect(root.locator(".cleanups")).toBeEmpty();
  });
}
