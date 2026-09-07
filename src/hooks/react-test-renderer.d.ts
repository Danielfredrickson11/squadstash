// Minimal ambient type shim for react-test-renderer (Checkpoint 3D
// review follow-up). No @types/react-test-renderer package exists in
// this project's dependency tree, and this repo does not add new
// dependencies for a single test file - react-test-renderer itself is
// already an existing devDependency (used by Expo/RN tooling), only its
// type declarations are missing. Covers only the two exports
// useSavingsMoneyAction.test.tsx actually uses.
//
// Deliberately kept OUTSIDE __tests__/: Jest's default testMatch treats
// any .ts file under a __tests__ directory as a test file regardless of
// its content, so a .d.ts placed there fails with "must contain at
// least one test" - this file only needs to be reachable by
// tsconfig.json's existing **/*.ts include glob, not by Jest.
declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export interface TestRenderer {
    toJSON(): unknown;
    unmount(): void;
    update(element: ReactElement): void;
  }

  export function create(element: ReactElement): TestRenderer;
  export function act(callback: () => void | Promise<void>): Promise<void>;
}
