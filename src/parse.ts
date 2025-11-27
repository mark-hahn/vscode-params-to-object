import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import * as utils from './utils';
import * as dialogs from './dialogs';

const { log } = utils.getLog('pars');

export interface SymbolResolution {
  resolvedTarget: any;
  canProceedWithoutSymbol: boolean;
}

export interface CallCandidate {
  filePath: string;
  start?: number;
  end?: number;
  rangeStart?: number;
  rangeEnd?: number;
  exprText: string;
  argsText: string[] | null;
  text?: string;
  reason?: string;
  score?: number;
}

export interface CollectedCalls {
  confirmed: CallCandidate[];
  fuzzy: CallCandidate[];
  shouldAbort: boolean;
  alreadyConvertedCount?: number;
}

/**
 * Resolve the symbol for a target function
 * Handles:
 * - Regular functions
 * - Arrow functions/function expressions in variables
 * - Object methods (Vue components) that don't have resolvable symbols
 */
export function resolveSymbol(
  project: Project,
  targetFunction: any,
  targetVariableDeclaration: any | null,
  fnName: string | null
): SymbolResolution {
  const typeChecker = project.getTypeChecker();
  let targetSym = targetFunction.getSymbol && targetFunction.getSymbol();

  // For arrow functions/function expressions in variables, get symbol from the variable
  if (!targetSym && targetVariableDeclaration) {
    targetSym =
      targetVariableDeclaration.getSymbol &&
      targetVariableDeclaration.getSymbol();
  }

  const resolvedTarget =
    targetSym &&
    (targetSym.getAliasedSymbol
      ? targetSym.getAliasedSymbol?.() || targetSym
      : targetSym);

  // Can proceed without a resolved symbol if:
  // 1. Function has a name (name-based matching for calls)
  // 2. Function is anonymous (no calls to find, just converting the definition)
  const canProceedWithoutSymbol = !resolvedTarget;

  return {
    resolvedTarget,
    canProceedWithoutSymbol,
  };
}

/**
 * Extract parameter types and build the type text for the destructured parameter
 */
export function extractParameterTypes(
  params: any[],
  paramNames: string[],
  sourceFile: SourceFile,
  isRestParameter: boolean,
  restTupleElements: string[]
): string {
  const isTypeScript =
    sourceFile.getFilePath().endsWith('.ts') ||
    sourceFile.getFilePath().endsWith('.tsx');

  if (!isTypeScript) {
    return '';
  }

  const paramTypes = params.map((p: any) => {
    if (isRestParameter && restTupleElements.length > 0) {
      const typeNode = p.getTypeNode();
      if (typeNode) {
        const typeText = typeNode.getText();
        const tupleMatch = typeText.match(/\[([^\]]+)\]/);
        if (tupleMatch) {
          const elements = tupleMatch[1]
            .split(',')
            .map((e: string) => e.trim());
          return elements.map((e: string) => {
            const colonIndex = e.indexOf(':');
            return colonIndex > 0 ? e.substring(colonIndex + 1).trim() : 'any';
          });
        }
      }
      return restTupleElements.map(() => 'any');
    }
    const typeNode = p.getTypeNode && p.getTypeNode();
    if (typeNode) return typeNode.getText();
    const pType = p.getType && p.getType();
    return pType ? pType.getText() : 'any';
  });

  if (isRestParameter) {
    const flatTypes = paramTypes.flat();
    return `{ ${paramNames
      .map((n: string, i: number) => {
        const param = params[0];
        const isOptional =
          param && param.hasQuestionToken && param.hasQuestionToken();
        const optionalMark = isOptional ? '?' : '';
        return `${n}${optionalMark}: ${flatTypes[i] || 'any'}`;
      })
      .join('; ')} }`;
  } else {
    return `{ ${paramNames
      .map((n: string, i: number) => {
        const param = params[i];
        const isOptional =
          param && param.hasQuestionToken && param.hasQuestionToken();
        const optionalMark = isOptional ? '?' : '';
        return `${n}${optionalMark}: ${paramTypes[i] || 'any'}`;
      })
      .join('; ')} }`;
  }
}

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

  // Use glob to find files (respects our exclude patterns, not .gitignore)
  const foundSet = new Set<string>();

  for (const p of includePatterns) {
    try {
      const matches = glob.sync(p, {
        cwd: workspaceRoot,
        ignore: excludePatterns,
        nodir: true,
        absolute: true,
      });
      for (const m of matches) foundSet.add(m);
    } catch (e) {
      // ignore pattern errors for individual include patterns
    }
  }

  const jsTsFiles = Array.from(foundSet);

  log('Found', jsTsFiles.length, 'files to add to project');
  log('Sample files:', jsTsFiles.slice(0, 5));

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

/**
 * Collect all calls to the target function across the workspace
 * Returns confirmed calls, fuzzy calls, and whether to abort
 */
export async function collectCalls(
  project: Project,
  workspaceRoot: string,
  fnName: string | null,
  resolvedTarget: any,
  paramNames: string[],
  originalEditor: vscode.TextEditor,
  originalSelection: vscode.Selection,
  sourceFilePath: string
): Promise<CollectedCalls> {
  const normalizeFsPath = (p?: string): string | undefined => {
    if (!p) return undefined;
    const normalized = path.normalize(p);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };

  const sourceFileNormalized = normalizeFsPath(sourceFilePath);
  const confirmed: CallCandidate[] = [];
  let fuzzy: CallCandidate[] = [];
  let alreadyConvertedCount = 0;

  const files = project.getSourceFiles();
  log(
    'scanning',
    files.length,
    'source files (node_modules excluded where possible)'
  );

  const localDefinitionCache = new Map<string, boolean>();

  const hasConflictingLocalDefinition = (sf: SourceFile): boolean => {
    if (!fnName) return false;
    const sfPath = sf.getFilePath();
    const normalizedSfPath = normalizeFsPath(sfPath);
    if (!normalizedSfPath || normalizedSfPath === sourceFileNormalized) {
      return false;
    }
    if (localDefinitionCache.has(normalizedSfPath)) {
      return localDefinitionCache.get(normalizedSfPath) ?? false;
    }

    let conflict = false;

    try {
      const funcDecls = sf.getFunctions?.() || [];
      conflict = funcDecls.some(
        (f: any) => typeof f.getName === 'function' && f.getName() === fnName
      );

      if (!conflict) {
        const varDecls = sf.getVariableDeclarations?.() || [];
        conflict = varDecls.some((v: any) => {
          if (typeof v.getName !== 'function' || v.getName() !== fnName) {
            return false;
          }
          const init = v.getInitializer && v.getInitializer();
          if (!init || typeof init.getKind !== 'function') {
            return false;
          }
          const kind = init.getKind();
          return (
            kind === SyntaxKind.FunctionExpression ||
            kind === SyntaxKind.ArrowFunction
          );
        });
      }
    } catch (e) {
      conflict = false;
    }

    localDefinitionCache.set(normalizedSfPath, conflict);
    return conflict;
  };

  for (const sf of files) {
    const sfPath = sf.getFilePath && sf.getFilePath();
    if (sfPath && sfPath.indexOf(path.sep + 'node_modules' + path.sep) >= 0)
      continue;

    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of calls) {
      const expr = call.getExpression();
      if (!expr) continue;
      const exprText = expr.getText();

      // Check for .call(), .apply(), .bind() - these have PropertyAccessExpression
      if (
        expr.getKind &&
        expr.getKind() === SyntaxKind.PropertyAccessExpression
      ) {
        const propAccess = expr as any;
        const propName = propAccess.getName && propAccess.getName();

        if (
          propName === 'call' ||
          propName === 'apply' ||
          propName === 'bind'
        ) {
          const objExpr =
            propAccess.getExpression && propAccess.getExpression();
          const objText = objExpr ? objExpr.getText() : '';

          // Check if the object being called is our target function
          if (objText === fnName || objText.endsWith('.' + fnName)) {
            const conflictFile = sf.getFilePath();
            log(`${propName}() detected in`, conflictFile, 'expr:', exprText);

            try {
              const doc = await vscode.workspace.openTextDocument(conflictFile);
              const callStartPos = doc.positionAt(call.getStart());
              const callEndPos = doc.positionAt(call.getEnd());

              await vscode.window.showTextDocument(doc, { preview: true });
              const tempEditor = vscode.window.activeTextEditor;

              if (tempEditor) {
                const topLine = Math.max(0, callStartPos.line - 5);
                const topPos = new vscode.Position(topLine, 0);
                tempEditor.revealRange(
                  new vscode.Range(topPos, topPos),
                  vscode.TextEditorRevealType.AtTop
                );

                const highlightDecoration =
                  vscode.window.createTextEditorDecorationType({
                    backgroundColor: 'rgba(255,100,100,0.3)',
                    border: '1px solid rgba(255,100,100,0.8)',
                  });
                tempEditor.setDecorations(highlightDecoration, [
                  new vscode.Range(callStartPos, callEndPos),
                ]);

                await vscode.window.showWarningMessage(
                  `Objectify Params: Cannot convert function.\n\ncall/apply/bind methods are not supported.`,
                  { modal: true }
                );

                highlightDecoration.dispose();

                log('User notified about', propName, '- stopping conversion');
                return { confirmed: [], fuzzy: [], shouldAbort: true };
              }
            } catch (e) {
              log('error showing call/apply/bind warning:', e);
            }
            continue;
          }
        }
      }

      if (!fnName) continue;
      const looksLikeCall =
        exprText === fnName ||
        exprText.endsWith('.' + fnName) ||
        exprText.endsWith('[' + fnName + ']');
      if (!looksLikeCall) continue;

      if (hasConflictingLocalDefinition(sf)) {
        await dialogs.showNameCollisionDialog(
          {
            filePath: sf.getFilePath(),
            start: call.getStart(),
            end: call.getEnd(),
          },
          originalEditor,
          originalSelection
        );
        return { confirmed: [], fuzzy: [], shouldAbort: true };
      }

      // Check for .call, .apply, or .bind usage
      const isCallApplyBind =
        exprText === `${fnName}.call` ||
        exprText === `${fnName}.apply` ||
        exprText === `${fnName}.bind` ||
        exprText.endsWith(`.${fnName}.call`) ||
        exprText.endsWith(`.${fnName}.apply`) ||
        exprText.endsWith(`.${fnName}.bind`);

      if (isCallApplyBind) {
        const conflictFile = sf.getFilePath();
        log('call/apply/bind detected in', conflictFile);

        try {
          const doc = await vscode.workspace.openTextDocument(conflictFile);
          const callStartPos = doc.positionAt(call.getStart());
          const callEndPos = doc.positionAt(call.getEnd());

          await vscode.window.showTextDocument(doc, { preview: true });
          const tempEditor = vscode.window.activeTextEditor;

          if (tempEditor) {
            const topLine = Math.max(0, callStartPos.line - 5);
            const topPos = new vscode.Position(topLine, 0);
            tempEditor.revealRange(
              new vscode.Range(topPos, topPos),
              vscode.TextEditorRevealType.AtTop
            );

            const highlightDecoration =
              vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(255,100,100,0.3)',
                border: '1px solid rgba(255,100,100,0.8)',
              });
            tempEditor.setDecorations(highlightDecoration, [
              new vscode.Range(callStartPos, callEndPos),
            ]);

            const response = await vscode.window.showWarningMessage(
              `Objectify Params: Cannot convert function.\n\ncall/apply/bind methods are not supported.`,
              { modal: true },
              'Cancel Scanning'
            );

            highlightDecoration.dispose();

            if (response === 'Cancel Scanning') {
              log('User cancelled scanning due to call/apply/bind');
              return { confirmed: [], fuzzy: [], shouldAbort: true };
            }
          }
        } catch (e) {
          log('error showing call/apply/bind warning:', e);
        }
        continue;
      }

      let calledSym;
      let resolvedCalled;
      try {
        calledSym = expr.getSymbol && expr.getSymbol();
        resolvedCalled =
          calledSym &&
          (calledSym.getAliasedSymbol
            ? calledSym.getAliasedSymbol?.() || calledSym
            : calledSym);
      } catch (e) {
        log('Error resolving called symbol:', e);
        calledSym = null;
        resolvedCalled = null;
      }

      if (looksLikeCall) {

      }

      if (resolvedCalled) {
        try {
          // Only compare symbols if we have a resolved target
          if (resolvedTarget) {
            // Compare by declaration location instead of just name
            let isMatch = false;
            
            try {
              const targetDecls = resolvedTarget.getDeclarations?.() || [];
              const calledDecls = resolvedCalled.getDeclarations?.() || [];
              
              if (targetDecls.length > 0 && calledDecls.length > 0) {
                // Check if any declaration locations match
                for (const tDecl of targetDecls) {
                  for (const cDecl of calledDecls) {
                    const tFile = tDecl.getSourceFile?.()?.getFilePath?.();
                    const cFile = cDecl.getSourceFile?.()?.getFilePath?.();
                    const tStart = tDecl.getStart?.();
                    const cStart = cDecl.getStart?.();
                    
                    if (tFile && cFile && tFile === cFile && tStart === cStart) {
                      isMatch = true;
                      break;
                    }
                  }
                  if (isMatch) break;
                }
              }
            } catch (e) {
              // Fall back to name comparison
              const fnId = resolvedTarget.getFullyQualifiedName
                ? resolvedTarget.getFullyQualifiedName()
                : resolvedTarget.getEscapedName &&
                  resolvedTarget.getEscapedName();
              const callId = resolvedCalled.getFullyQualifiedName
                ? resolvedCalled.getFullyQualifiedName()
                : resolvedCalled.getEscapedName &&
                  resolvedCalled.getEscapedName();
              isMatch = fnId && callId && fnId === callId;
            }

            const isCollision = !isMatch;

            if (isCollision) {
              const collisionCandidate = {
                filePath: sf.getFilePath(),
                start: call.getStart(),
                end: call.getEnd(),
              };

              log('Name collision detected while scanning calls:', {
                file: collisionCandidate.filePath,
                start: collisionCandidate.start,
                end: collisionCandidate.end,
                expr: expr.getText(),
              });

              await dialogs.showNameCollisionDialog(
                collisionCandidate,
                originalEditor,
                originalSelection
              );
              return { confirmed: [], fuzzy: [], shouldAbort: true };
            }
          }

          // Process the call (symbol matched or no symbol to compare)
          const args = call.getArguments();
          const argsText = args.map((a: any) =>
            a ? a.getText() : 'undefined'
          );
          if (
            argsText.length === 1 &&
            typeof argsText[0] === 'string' &&
            argsText[0].trim().startsWith('{')
          ) {
            log(
              'skipping already-object call at',
              sf.getFilePath(),
              'text:',
              argsText[0]
            );
            alreadyConvertedCount++;
          } else {
            // Check if argument count matches parameter count
            if (args.length > paramNames.length) {
              // More args than params - would lose data, must be fuzzy
              log(
                'too many arguments:',
                args.length,
                'args vs',
                paramNames.length,
                'params in',
                sf.getFilePath()
              );
              fuzzy.push({
                filePath: sf.getFilePath(),
                start: call.getStart(),
                end: call.getEnd(),
                exprText: expr.getText(),
                argsText,
                reason: 'too-many-args',
                score: 3,
              });
            } else {
              // args.length <= paramNames.length - safe to convert
              // Missing args will become undefined properties
              confirmed.push({
                filePath: sf.getFilePath(),
                start: call.getStart(),
                end: call.getEnd(),
                exprText: expr.getText(),
                argsText,
              });
            }
          }
        } catch (e) {
          log('Error during symbol comparison in', sf.getFilePath(), e);

          // Show error and abort - cannot safely parse this file
          const doc = await vscode.workspace.openTextDocument(sf.getFilePath());
          const callStartPos = doc.positionAt(call.getStart());
          const callEndPos = doc.positionAt(call.getEnd());

          await vscode.window.showTextDocument(doc, { preview: true });
          const tempEditor = vscode.window.activeTextEditor;

          if (tempEditor) {
            const errorDecoration =
              vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(255,100,100,0.3)',
                border: '1px solid rgba(255,100,100,0.8)',
              });
            tempEditor.setDecorations(errorDecoration, [
              new vscode.Range(callStartPos, callEndPos),
            ]);

            await vscode.window.showWarningMessage(
              `Objectify Params: Cannot convert function.\n\nCannot parse the file. Check for errors. Operation will be cancelled.`,
              { modal: true },
              'OK'
            );

            errorDecoration.dispose();
          }

          // Restore original editor
          if (originalEditor && originalSelection) {
            await vscode.window.showTextDocument(originalEditor.document, {
              selection: originalSelection,
              preserveFocus: false,
            });
          }

          log('Aborting conversion due to parse error');
          return { confirmed: [], fuzzy: [], shouldAbort: true };
        }
      } else {
        // Could not resolve symbol - check argument count to decide confirmed vs fuzzy
        const args = call.getArguments();
        const argsText = args.map((a: any) => (a ? a.getText() : 'undefined'));
        
        // Skip if already converted to object syntax
        if (
          argsText.length === 1 &&
          typeof argsText[0] === 'string' &&
          argsText[0].trim().startsWith('{')
        ) {
          log(
            'skipping already-object call at',
            sf.getFilePath(),
            'text:',
            argsText[0]
          );
          continue;
        }
        
        // If this is a property access (e.g., x.sendToWebview) and we couldn't resolve the symbol,
        // it's likely a different function with the same name - treat as fuzzy
        const isPropertyAccess = exprText !== fnName && (exprText.includes('.') || exprText.includes('['));

        if (
          resolvedTarget &&
          fnName &&
          !isPropertyAccess &&
          sf.getFilePath() &&
          sf.getFilePath() !== sourceFilePath
        ) {
          const hasLocalFunctionDefinition = (() => {
            try {
              const funcDecls = sf.getFunctions();
              if (
                funcDecls.some(
                  (f: any) =>
                    typeof f.getName === 'function' && f.getName() === fnName
                )
              ) {
                return true;
              }
              const varDecls = sf.getVariableDeclarations();
              return varDecls.some((v: any) => {
                if (typeof v.getName !== 'function' || v.getName() !== fnName) {
                  return false;
                }
                const init = v.getInitializer && v.getInitializer();
                if (!init || typeof init.getKind !== 'function') {
                  return false;
                }
                const kind = init.getKind();
                return (
                  kind === SyntaxKind.FunctionExpression ||
                  kind === SyntaxKind.ArrowFunction
                );
              });
            } catch (e) {
              return false;
            }
          })();

          if (hasLocalFunctionDefinition) {
            await dialogs.showNameCollisionDialog(
              {
                filePath: sf.getFilePath(),
                start: call.getStart(),
                end: call.getEnd(),
              },
              originalEditor,
              originalSelection
            );
            return { confirmed: [], fuzzy: [], shouldAbort: true };
          }
        }
        
        if (isPropertyAccess) {
          // Property access without symbol resolution - likely name collision
          fuzzy.push({
            filePath: sf.getFilePath(),
            start: call.getStart(),
            end: call.getEnd(),
            exprText: expr.getText(),
            argsText,
            reason: 'unresolved-property-access',
            score: 2,
          });
        } else if (args.length > paramNames.length) {
          // Too many args - must be fuzzy to avoid data loss
          fuzzy.push({
            filePath: sf.getFilePath(),
            start: call.getStart(),
            end: call.getEnd(),
            exprText: expr.getText(),
            argsText,
            reason: 'unresolved-too-many-args',
            score: 3,
          });
        } else {
          // Direct call with safe arg count - safe to auto-convert
          log('CONFIRMED CALL ADDED (unresolved symbol but safe arg count):', {
            file: sf.getFilePath(),
            start: call.getStart(),
            end: call.getEnd(),
            exprText: expr.getText(),
            argsText,
            callText: call.getText()
          });
          confirmed.push({
            filePath: sf.getFilePath(),
            start: call.getStart(),
            end: call.getEnd(),
            exprText: expr.getText(),
            argsText,
          });
        }
      }
    }
  }

  // Also search .vue and .svelte files in workspace for template calls
  const cfg = vscode.workspace.getConfiguration('objectifyParams');
  const excludeStr = (cfg.get('exclude') as string) || '**/node_modules/**';
  const excludePatterns = excludeStr.split(/\s+/).filter(Boolean);
  const templatePatterns = ['**/*.vue', '**/*.svelte'];
  let vueFilesRel: string[] = [];
  for (const p of templatePatterns) {
    try {
      vueFilesRel = vueFilesRel.concat(
        glob.sync(p, {
          cwd: workspaceRoot,
          ignore: excludePatterns,
          nodir: true,
        })
      );
    } catch (e) {}
  }
  vueFilesRel = Array.from(new Set(vueFilesRel));
  const vueFiles = vueFilesRel.map((f) => path.join(workspaceRoot, f));
  
  // Normalize file paths for comparison and collect existing ranges
  const normalizeFilePath = (fp: string) => fp.replace(/\\/g, '/').toLowerCase();
  const existingRanges: Array<{file: string, start: number, end: number}> = [];
  
  // Add confirmed ranges
  for (const c of confirmed) {
    if (c.start !== undefined && c.end !== undefined) {
      existingRanges.push({
        file: normalizeFilePath(c.filePath),
        start: c.start,
        end: c.end
      });
    }
  }
  
  // Add fuzzy ranges
  for (const f of fuzzy) {
    if (f.start !== undefined && f.end !== undefined) {
      existingRanges.push({
        file: normalizeFilePath(f.filePath),
        start: f.start,
        end: f.end
      });
    }
  }
  
  for (const vf of vueFiles) {
    const txt = fs.readFileSync(vf, 'utf8');
    const scriptRanges: Array<{ start: number; end: number }> = [];
    const scriptTagRegex = /<script\b[^>]*>/gi;
    let scriptMatch: RegExpExecArray | null;
    const scriptCloseTag = '</script>';
    while ((scriptMatch = scriptTagRegex.exec(txt)) !== null) {
      const scriptStart = scriptMatch.index;
      const closeIdx = txt.indexOf(scriptCloseTag, scriptTagRegex.lastIndex);
      if (closeIdx === -1) {
        scriptRanges.push({ start: scriptStart, end: txt.length });
        break;
      }
      const rangeEnd = closeIdx + scriptCloseTag.length;
      scriptRanges.push({ start: scriptStart, end: rangeEnd });
      scriptTagRegex.lastIndex = rangeEnd;
    }
    const re = new RegExp(fnName + '\\s*\\(', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) !== null) {
      const idx = m.index;
      const inScriptBlock = scriptRanges.some(
        (range) => idx >= range.start && idx < range.end
      );
      if (inScriptBlock) {
        log('SKIPPING script block match at offset', idx, 'in', vf);
        continue;
      }
      const contextStart = Math.max(0, idx - 50);
      const contextEnd = Math.min(txt.length, idx + 100);
      const context = txt.substring(contextStart, contextEnd);
      
      // Check if this is the function definition, not a call
      // Look for 'function functionName(' or 'async functionName(' or method declarations
      const beforeMatch = txt.substring(Math.max(0, idx - 20), idx);
      const isFunctionDef = /\bfunction\s+$/.test(beforeMatch) ||
                           /\basync\s+function\s+$/.test(beforeMatch) ||
                           /\basync\s+$/.test(beforeMatch);
      
      if (isFunctionDef) {
        log('SKIPPING function definition at offset', idx, 'in', vf);
        continue;
      }
      
      // Check if overlaps with any existing range (allowing for slight offset differences)
      const normalizedVf = normalizeFilePath(vf);
      const isDuplicate = existingRanges.some(r => 
        r.file === normalizedVf && 
        Math.abs(r.start - idx) < 20 // Within 20 chars is likely the same call
      );
      
      if (isDuplicate) {
        log('SKIPPING duplicate (already found by ts-morph) at offset', idx, 'in', vf);
        continue;
      }
      
      log('REGEX MATCH in', vf, 'at offset', idx, 'context:', context);
      fuzzy.push({
        filePath: vf,
        rangeStart: idx,
        rangeEnd: idx + fnName.length,
        text: txt.substr(idx, 200),
        reason: 'unresolved',
        score: 5,
        argsText: null,
        exprText: fnName,
      });
    }
  }

  const safeSerial = (arr: any[]) =>
    arr.map((c) => ({
      filePath: c.filePath,
      start: c.start,
      end: c.end,
      exprText: c.exprText,
      argsText: c.argsText,
      reason: c.reason,
    }));
  return { confirmed, fuzzy, shouldAbort: false, alreadyConvertedCount };
}
