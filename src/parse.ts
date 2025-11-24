import * as vscode from 'vscode';
import * as path from 'path';
import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import * as utils from './utils';

const { log } = utils.getLog('pars');

export async function createProjectFromConfig(
  workspaceRoot: string
): Promise<Project> {
  const project = new Project({
    tsConfigFilePath: undefined,
    compilerOptions: { allowJs: true, checkJs: false },
  });

  // Read include/exclude globs from configuration (space-separated strings)
  const cfg = vscode.workspace.getConfiguration('objectifyParams');
  const includeStr = (cfg.get('include') as string) || '**/*.ts **/*.js';
  const excludeStr = (cfg.get('exclude') as string) || '**/node_modules/**';
  const includePatterns = includeStr.split(/\s+/).filter(Boolean);
  const excludePatterns = excludeStr.split(/\s+/).filter(Boolean);

  // Use VS Code's workspace.findFiles to respect glob include/exclude settings
  const foundSet = new Set<string>();
  const excludeGlob =
    excludePatterns.length > 0
      ? excludePatterns.length === 1
        ? excludePatterns[0]
        : `{${excludePatterns.join(',')}}`
      : undefined;

  for (const p of includePatterns) {
    try {
      const rel = new vscode.RelativePattern(workspaceRoot, p);
      const uris = await vscode.workspace.findFiles(rel, excludeGlob);
      for (const u of uris) foundSet.add(u.fsPath);
    } catch (e) {
      // ignore pattern errors for individual include patterns
    }
  }

  const jsTsFiles = Array.from(foundSet);

  if (jsTsFiles.length > 0) {
    project.addSourceFilesAtPaths(jsTsFiles);
  } else {
    // Fallback: glob returned nothing (dev-host or config quirks). Add common JS/TS globs directly
    const fallbackGlob = path.join(
      workspaceRoot,
      '**/*.{js,ts,jsx,tsx,mjs,cjs}'
    );
    log('glob found no files; adding fallback project glob:', fallbackGlob);
    try {
      project.addSourceFilesAtPaths(fallbackGlob);
    } catch (e) {
      log('fallback addSourceFilesAtPaths failed', e);
    }
  }

  return project;
}

export function resolveSymbol(node: any): any {
  const sym = node.getSymbol ? node.getSymbol() : null;
  return sym && sym.getAliasedSymbol ? sym.getAliasedSymbol() || sym : sym;
}

export function getSymbolName(symbol: any): string | null {
  if (!symbol) return null;
  return symbol.getFullyQualifiedName
    ? symbol.getFullyQualifiedName()
    : symbol.getEscapedName
    ? symbol.getEscapedName()
    : null;
}

export function findFunctionsInFile(
  sourceFile: SourceFile
): Array<{ node: any; name: string | null }> {
  const result: Array<{ node: any; name: string | null }> = [];

  const funcDecls = sourceFile.getFunctions();
  for (const f of funcDecls) {
    result.push({ node: f, name: f.getName ? f.getName() : null });
  }

  const varDecls = sourceFile.getVariableDeclarations().filter((v: any) => {
    const init = v.getInitializer && v.getInitializer();
    if (!init) return false;
    const k = init.getKind && init.getKind();
    return (
      k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression
    );
  });

  for (const v of varDecls) {
    const init = v.getInitializer();
    result.push({ node: init, name: v.getName() });
  }

  return result;
}
