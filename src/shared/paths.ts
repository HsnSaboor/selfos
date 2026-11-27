/**
 * Path containment shared by the notes vault and the reading library.
 *
 * A `startsWith(root)` test accepts a sibling whose name shares the prefix
 * (`…/library` vs `…/library-evil`); resolve + relative is the check that
 * actually means "inside".
 */
import { isAbsolute, relative, resolve } from "node:path";

export function isInside(root: string, abs: string): boolean {
  const rel = relative(resolve(root), resolve(abs));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
