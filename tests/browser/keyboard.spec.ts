import { test, expect } from "@playwright/test";

test("preview tabs and code languages support arrow keys without moving upload controls", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("#chunked");
  const tabs = root.getByRole("tablist", {
    name: "A queue you can control",
    exact: true,
  });
  await tabs.getByRole("tab", { name: "Preview", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    tabs.getByRole("tab", { name: "Code", exact: true }),
  ).toBeFocused();
  await expect(root.locator("[data-panel=code]")).toBeVisible();
  const languages = root.getByRole("tablist", {
    name: "Code language",
    exact: true,
  });
  await languages.getByRole("tab", { name: "React", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(
    languages.getByRole("tab", { name: "Vanilla", exact: true }),
  ).toBeFocused();
  await expect(root.locator("pre")).toContainText("mountUploader");
  await page.keyboard.press("Home");
  await expect(
    languages.getByRole("tab", { name: "React", exact: true }),
  ).toHaveAttribute("tabindex", "0");
  await tabs.getByRole("tab", { name: "Code", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(root.locator("[data-upload-trigger]")).toBeVisible();
});

test("a native trigger opens file selection with the keyboard and upload stays operable", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("#chunked");
  const trigger = root.locator("[data-upload-trigger]");
  await expect(root.locator("[data-upload-root]")).toBeVisible();
  await expect(trigger).toBeEnabled();
  const [dialog] = await Promise.all([
    page.waitForEvent("filechooser"),
    trigger.press("Enter"),
  ]);
  await dialog.setFiles({
    name: "keyboard.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("keyboard"),
  });
  await root
    .getByRole("button", { name: "Upload files", exact: true })
    .press("Space");
  await expect(root.locator(".file-status")).toHaveText("completed");
  await expect(
    root.getByRole("progressbar", { name: "Upload progress", exact: true }),
  ).toHaveAttribute("aria-valuenow", "100");
  await expect(root.locator(".file-status")).toHaveAttribute(
    "aria-live",
    "polite",
  );
});
