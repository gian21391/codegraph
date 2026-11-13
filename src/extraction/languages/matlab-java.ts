/**
 * Java as MATLAB code reaches it through its JVM: `java.lang.String(…)`,
 * `import javax.swing.JFrame`. Never a project's names. Read by the MATLAB
 * extractor and by its pre-insert filter (matlab-builtins.ts).
 */

/** The roots of Java's packages (`java.lang.String`, `javax.swing.JFrame`). */
export const JAVA_PACKAGE_ROOTS: ReadonlySet<string> = new Set(['java', 'javax']);

/** `import java.util.ArrayList` / `import javax.swing.*`: Java's, which brings no project name into reach. */
export function isJavaImport(target: string): boolean {
  return JAVA_PACKAGE_ROOTS.has(target.split('.')[0]!);
}
