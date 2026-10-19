import type { StorageAdapter } from "../types";
/** Partial overrides must explicitly retain the base adapter's reference/receipt contract. */
export function withStorageOverrides(
  base: StorageAdapter,
  overrides: Partial<StorageAdapter>,
  options: { compatibleReferences: boolean },
): StorageAdapter {
  if (
    !options.compatibleReferences &&
    !["begin", "writePart", "probe", "finish", "inspectResult", "abort"].every(
      (key) => key in overrides,
    )
  )
    throw new Error(
      "Changed references require begin, writePart, probe, finish, inspectResult and abort overrides",
    );
  return {
    ...base,
    ...overrides,
    capabilities: overrides.capabilities ?? base.capabilities,
  };
}
