import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Guard for the client bundle (deploy/platform/SPEC.md §12, "Build fix").
 *
 * The self-hosted API modules run on the server only: `project-context.ts` holds an
 * `AsyncLocalStorage` from `node:async_hooks` and reads the registry with `node:fs`. When a page
 * reaches one of them through any chain of imports, `next build` (Turbopack) fails to write that
 * page ("the chunking context does not support external modules"), while tsc, ESLint and vitest
 * all pass. This happened once: `lib/integration-utils.ts` imported `isResponseOk` from
 * `lib/api/apiWrapper.ts`, which wraps every route in the project context.
 *
 * So this test walks the value imports (type-only imports are erased and skipped) from every
 * client file and fails, with the import chain, on any server-only module or Node builtin it
 * reaches. Client code that needs a helper from a server module takes it from a `*.browser.ts`
 * split instead (see `lib/api/apiWrapper.browser.ts`, `lib/api/snippets.browser.ts`).
 */

const STUDIO = resolve(__dirname, '../../..')
const CLIENT_ROOTS = ['pages', 'components', 'hooks', 'data', 'state', 'lib/constants']
const SERVER_ONLY = [
  /^lib\/api\/self-hosted\//,
  /^lib\/api\/self-hosted-admin\.ts$/,
  /^lib\/api\/apiWrapper\.ts$/,
  /^lib\/api\/apiHelpers\.ts$/,
]
const NODE_BUILTINS = new Set(builtinModules)

const isSource = (name: string) =>
  /\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !/\.(test|spec)\.tsx?$/.test(name)

function listSources(dir: string): string[] {
  return readdirSync(join(STUDIO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(path)
    return isSource(entry.name) ? [path] : []
  })
}

/** Specifiers of the imports that survive compilation: static, re-exported and dynamic. */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(STUDIO, file), 'utf8'),
    ts.ScriptTarget.Latest
  )
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly =
        clause?.isTypeOnly ||
        (clause !== undefined &&
          !clause.name &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly))
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!node.isTypeOnly) specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/** The studio file a specifier names, or undefined for a package. */
function resolveLocal(from: string, specifier: string): string | undefined {
  let base: string
  if (specifier.startsWith('@/')) base = join(STUDIO, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(join(STUDIO, from)), specifier)
  else return undefined
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]
  const found = candidates.find((path) => existsSync(path) && statSync(path).isFile())
  return found && relative(STUDIO, found)
}

describe('client import guard', () => {
  it('reaches no server-only module or Node builtin from client code', () => {
    const roots = CLIENT_ROOTS.flatMap(listSources).filter((file) => !file.startsWith('pages/api/'))
    const importedBy = new Map<string, string | null>(roots.map((file) => [file, null]))
    const queue = [...roots]
    const violations: string[] = []
    const chain = (file: string) => {
      const files: string[] = []
      for (let at: string | null | undefined = file; at; at = importedBy.get(at)) files.unshift(at)
      return files.join(' -> ')
    }

    while (queue.length > 0) {
      const file = queue.shift()!
      if (SERVER_ONLY.some((pattern) => pattern.test(file))) {
        violations.push(chain(file))
        continue
      }
      for (const specifier of valueImports(file)) {
        if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0])) {
          violations.push(`${chain(file)} -> ${specifier}`)
          continue
        }
        const target = resolveLocal(file, specifier)
        if (target && !importedBy.has(target)) {
          importedBy.set(target, file)
          queue.push(target)
        }
      }
    }

    expect(roots.length).toBeGreaterThan(1000)
    expect(violations).toEqual([])
  })
})
