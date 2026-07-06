// @testing-library/jest-dom matchers for bun:test (mirror of @testing-library/jest-dom/types/bun.d.ts).
// The package does not expose this subpath via its exports map, so we inline the module
// augmentation here to make matchers like toBeInTheDocument / toHaveAttribute / toHaveTextContent
// available in tsc's view of `import { expect } from "bun:test"`.
import type { expect } from "bun:test"
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers"

declare module "bun:test" {
  interface Matchers<T = unknown>
    extends TestingLibraryMatchers<
      ReturnType<typeof expect.stringContaining>,
      T
    > {}
}
