import * as vscode from 'vscode';
import * as path from 'path';
import { SyntaxKind } from 'ts-morph';
import glob from 'glob';
import * as fs from 'fs';
import * as utils from './utils';
import * as parse from './parse';

const { log } = utils.getLog('cmds');

// Helper function to monitor and show confirmed calls
async function monitorConfirmedCalls(
  confirmed: any[],
  totalCalls: number,
  startIdx: number,
  paramNames: string[],
  highlightDelay: number,
  originalEditor: vscode.TextEditor | undefined,
  originalSelection: vscode.Selection | undefined
): Promise<boolean> {
  const buildReplacement = (exprText: string, argsTextArr: string[]) => {
    const props = paramNames.map((name, idx) => {
      const aText = argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
      if (aText === name) return `${name}`;
      return `${name}:${aText}`;
    }).join(', ');
    return `${exprText}({ ${props} })`;
  };
  
  const yellowDecoration = vscode.window.createTextEditorDecorationType({ 
    backgroundColor: 'rgba(255,255,0,0.4)'
  });
  const greenDecoration = vscode.window.createTextEditorDecorationType({ 
    backgroundColor: 'rgba(100,255,100,0.3)'
  });
  
  let callIdx = startIdx;
  for (const c of confirmed) {
    callIdx++;
    
    try {
      const doc = await vscode.workspace.openTextDocument(c.filePath);
      const startPos = doc.positionAt(c.start);
      const endPos = doc.positionAt(c.end);
      
      await vscode.window.showTextDocument(doc, { preview: true });
      const editor = vscode.window.activeTextEditor;
      
      if (editor) {
        const topLine = Math.max(0, startPos.line - 5);
        const topPos = new vscode.Position(topLine, 0);
        editor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
        
        const repl = buildReplacement(c.exprText, c.argsText);
        
        if (highlightDelay === 0) {
          // Show green preview immediately
          await editor.edit(editBuilder => {
            editBuilder.replace(new vscode.Range(startPos, endPos), repl);
          });
          const newEndPos = doc.positionAt(c.start + repl.length);
          editor.setDecorations(greenDecoration, [new vscode.Range(startPos, newEndPos)]);
        } else {
          // Show original in yellow
          editor.setDecorations(yellowDecoration, [new vscode.Range(startPos, endPos)]);
        }
        
        // Show dialog immediately (while highlight is visible)
        const choice = await vscode.window.showInformationMessage(
          `Objectify Params: Processing function call ${callIdx} of ${totalCalls}.`,
          { modal: true },
          'Next'
        );
        
        if (choice === undefined) {
          yellowDecoration.dispose();
          greenDecoration.dispose();
          void vscode.window.showInformationMessage('Objectify Params: Operation cancelled — no changes made.');
          if (originalEditor && originalSelection) {
            await vscode.window.showTextDocument(originalEditor.document, { 
              selection: originalSelection, 
              preserveFocus: false 
            });
          }
          if (highlightDelay === 0) {
            await vscode.commands.executeCommand('undo');
          }
          return true; // aborted
        }
        
        if (highlightDelay === 0) {
          editor.setDecorations(greenDecoration, []);
          await vscode.commands.executeCommand('undo');
        } else {
          // Clear yellow, show green preview, then wait
          editor.setDecorations(yellowDecoration, []);
          
          await editor.edit(editBuilder => {
            editBuilder.replace(new vscode.Range(startPos, endPos), repl);
          });
          
          const newEndPos = doc.positionAt(c.start + repl.length);
          editor.setDecorations(greenDecoration, [new vscode.Range(startPos, newEndPos)]);
          
          await new Promise(r => setTimeout(r, highlightDelay));
          
          await vscode.commands.executeCommand('undo');
          editor.setDecorations(greenDecoration, []);
        }
      }
    } catch (e) {
      log('Error showing monitor preview:', e);
    }
  }
  
  yellowDecoration.dispose();
  greenDecoration.dispose();
  
  return false; // not aborted
}

// Helper function to apply edits and highlight the function signature
async function applyFunctionEditAndHighlight(
  sourceFile: any,
  originalFunctionText: string,
  newFnText: string,
  targetStart: number,
  targetEnd: number,
  originalEditor: vscode.TextEditor | undefined,
  originalSelection: vscode.Selection | undefined,
  highlightDelay: number,
  convertedCount: number
): Promise<void> {
  const uri = vscode.Uri.file(sourceFile.getFilePath());
  const doc = await vscode.workspace.openTextDocument(uri);
  const full = doc.getText();
  const idx = full.indexOf(originalFunctionText);
  const startPosReplace = idx >= 0 ? doc.positionAt(idx) : doc.positionAt(targetStart);
  const endPosReplace = idx >= 0 ? doc.positionAt(idx + originalFunctionText.length) : doc.positionAt(targetEnd);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(startPosReplace, endPosReplace), newFnText);
  const ok = await vscode.workspace.applyEdit(edit);
  log('applied function text edit:', ok);
  
  // Calculate the range of the updated function signature for highlighting
  let parenDepth = 0;
  let signatureEnd = 0;
  for (let i = 0; i < newFnText.length; i++) {
    if (newFnText[i] === '(') parenDepth++;
    if (newFnText[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        const remaining = newFnText.substring(i + 1);
        const braceIdx = remaining.indexOf('{');
        signatureEnd = braceIdx >= 0 ? i + 1 + braceIdx : i + 1;
        break;
      }
    }
  }
  if (signatureEnd === 0) signatureEnd = newFnText.indexOf('{');
  if (signatureEnd <= 0) signatureEnd = newFnText.length;
  
  const newSignatureEndPos = idx >= 0 ? doc.positionAt(idx + signatureEnd) : doc.positionAt(targetStart + signatureEnd);
  const functionRange = new vscode.Range(startPosReplace, newSignatureEndPos);
  
  log('Highlighting function definition, range:', functionRange, 'highlightDelay:', highlightDelay);
  
  if (originalEditor && originalSelection) {
    await vscode.window.showTextDocument(originalEditor.document, { selection: originalSelection, preserveFocus: false });
    
    if (highlightDelay > 0) {
      const highlightColor = convertedCount > 0 ? 'rgba(100,255,100,0.3)' : 'rgba(255,100,100,0.3)';
      log('Creating decoration with color:', highlightColor);
      const defDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: highlightColor });
      const currentEditor = vscode.window.activeTextEditor;
      if (currentEditor) {
        currentEditor.setDecorations(defDecoration, [functionRange]);
        log('Decoration applied, waiting for', highlightDelay, 'ms');
        await new Promise(r => setTimeout(r, highlightDelay));
        log('Disposing decoration');
        defDecoration.dispose();
      }
    }
  }
}

export async function convertCommandHandler(...args: any[]): Promise<void> {
  const context = utils.getWorkspaceContext();
  if (!context) return;

  const { editor, workspaceRoot, filePath } = context;
  log('activeFile:', filePath);
  log('chosen workspaceRoot:', workspaceRoot);

  const originalEditor = vscode.window.activeTextEditor;
  const originalSelection = originalEditor ? originalEditor.selection : undefined;
  const cursorOffset = editor.document.offsetAt(editor.selection.active);

  try {
    const project = await parse.createProjectFromConfig(workspaceRoot);

    // Ensure current file is in the project
    let sourceFile = project.getSourceFile(filePath);
    if (!sourceFile) {
      sourceFile = project.createSourceFile(filePath, editor.document.getText(), { overwrite: true });
    }

    // Find function declaration or function expression at cursor
    let targetFunction: any = null;
    let targetVariableDeclaration: any = null;
    const functions = sourceFile.getFunctions();
    for (const f of functions) {
      if (f.getStart() <= cursorOffset && cursorOffset <= f.getEnd()) {
        targetFunction = f;
        break;
      }
    }

    if (!targetFunction) {
      // check variable declarations for arrow or function expressions
      const vars = sourceFile.getVariableDeclarations();
      for (const v of vars) {
        const init = v.getInitializer && v.getInitializer();
        if (!init) continue;
        const kind = init.getKind && init.getKind();
        const isFunction = kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression;
        if (!isFunction) continue;
        
        // Check if cursor is on the variable name or anywhere in the function
        const varStart = v.getStart();
        const varEnd = v.getEnd();
        if (varStart <= cursorOffset && cursorOffset <= varEnd) {
          targetFunction = init;
          targetVariableDeclaration = v;
          break;
        }
      }
    }

    if (!targetFunction) {
      // check class methods
      const classes = sourceFile.getClasses();
      for (const cls of classes) {
        const methods = cls.getMethods();
        for (const method of methods) {
          if (method.getStart() <= cursorOffset && cursorOffset <= method.getEnd()) {
            targetFunction = method;
            break;
          }
        }
        if (targetFunction) break;
      }
    }

    if (!targetFunction) {
      void vscode.window.showInformationMessage('Objectify Params: Not on a function.');
      return;
    }

    const params = targetFunction.getParameters();
    if (!params || params.length === 0) {
      void vscode.window.showInformationMessage('Objectify Params: Function has zero parameters — nothing to convert.');
      return;
    }

    // Check for parameter properties (TypeScript constructor parameters with public/private/protected/readonly)
    const hasParameterProperties = params.some((p: any) => {
      try {
        const scope = p.getScope && p.getScope();
        const isReadonly = p.isReadonly && p.isReadonly();
        return scope || isReadonly;
      } catch {
        return false;
      }
    });

    if (hasParameterProperties) {
      await vscode.window.showWarningMessage(
        `Objectify Params\n\n⚠️ This function cannot be converted\n\n` +
        `This function uses TypeScript parameter properties (public/private/protected/readonly).\n\n` +
        `Converting would lose the automatic property assignment behavior.\n\n` +
        `Parameter properties are only valid in constructors and automatically create class fields.`,
        { modal: true }
      );
      return;
    }

    // Check for TypeScript function overloads
    const hasOverloads = targetFunction.getOverloads && targetFunction.getOverloads().length > 0;
    if (hasOverloads) {
      await vscode.window.showWarningMessage(
        `Objectify Params\n\n⚠️ This function cannot be converted\n\n` +
        `This function uses TypeScript overload signatures.\n\n` +
        `Converting the implementation signature would break the overload signatures, ` +
        `which would need to be manually updated to match the new object parameter pattern.\n\n` +
        `All overload signatures must be updated before converting the implementation.`,
        { modal: true }
      );
      return;
    }

    // Check for rest parameters and extract tuple element names
    let paramNames: string[] = [];
    let isRestParameter = false;
    let restTupleElements: string[] = [];
    
    if (params.length === 1 && params[0].isRestParameter && params[0].isRestParameter()) {
      isRestParameter = true;
      const restParam = params[0];
      const restParamName = restParam.getName();
      const typeNode = restParam.getTypeNode();
      
      // Try to extract tuple element names from type like: [cmd: string, val: any]
      if (typeNode) {
        const typeText = typeNode.getText();
        const tupleMatch = typeText.match(/\[([^\]]+)\]/);
        if (tupleMatch) {
          const elements = tupleMatch[1].split(',').map(e => e.trim());
          restTupleElements = elements.map(e => {
            const colonIndex = e.indexOf(':');
            return colonIndex > 0 ? e.substring(0, colonIndex).trim() : e;
          }).filter(Boolean);
        }
      }
      
      // Show appropriate dialog based on whether we have named tuple elements
      if (restTupleElements.length > 0) {
        paramNames = restTupleElements;
        
        const choice = await vscode.window.showWarningMessage(
          `Objectify Params\n\n⚠️ Rest parameter conversion\n\n` +
          `The rest parameter "...${restParamName}: [${restTupleElements.join(', ')}]" will be converted to destructured parameters { ${paramNames.join(', ')} }.\n\n` +
          `⚠️ Important: You must manually update the function body:\n` +
          `• Change ${restParamName}[0] → ${paramNames[0] || 'param'}\n` +
          `• Change ${restParamName}[1] → ${paramNames[1] || 'param'}\n` +
          `• etc.\n\n` +
          `Continue with conversion?`,
          { modal: true },
          'Continue',
          'Cancel'
        );
        
        if (choice !== 'Continue') {
          void vscode.window.showInformationMessage('Objectify Params: Operation cancelled — no changes made.');
          return;
        }
      } else {
        await vscode.window.showWarningMessage(
          `Objectify Params\n\n⚠️ This function cannot be converted\n\n` +
          `The rest parameter "...${restParamName}" does not have named tuple elements.\n\n` +
          `To convert, you need a tuple type with named elements:\n` +
          `...${restParamName}: [param1: type1, param2: type2]\n\n` +
          `Without named elements, the extension cannot determine how to map call arguments to object properties.`,
          { modal: true },
          'OK'
        );
        return;
      }
    } else {
      paramNames = params.map((p: any) => p.getName());
    }
    
    let fnName = targetFunction.getName ? targetFunction.getName() : null;
    
    // If arrow function or function expression assigned to variable, get name from variable
    if (!fnName && targetVariableDeclaration) {
      fnName = targetVariableDeclaration.getName();
    }
    
    const targetStart = targetFunction.getStart();
    const targetEnd = targetFunction.getEnd();
    const originalFunctionText = targetFunction.getText();

    // Check if function already uses object destructuring pattern
    const hasObjectDestructuring = params.length === 1 && params[0].getStructure && (() => {
      try {
        const paramText = params[0].getText();
        return paramText.trim().startsWith('{');
      } catch {
        return false;
      }
    })();

    if (hasObjectDestructuring) {
      void vscode.window.showInformationMessage('Objectify Params: This function already uses object destructuring parameters.');
      return;
    }

    const transformFunctionText = (fnText: string, paramNames: string[], paramTypeText: string, isTypeScript: boolean) => {
      const open = fnText.indexOf('(');
      if (open < 0) return fnText;
      let i = open + 1;
      let depth = 1;
      while (i < fnText.length && depth > 0) {
        const ch = fnText[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      const close = i - 1;
      const before = fnText.slice(0, open + 1);
      const after = fnText.slice(close);
      
      // Build destructured params with defaults preserved
      // For rest parameters, use the extracted paramNames, not the original param names
      let paramsWithDefaults: string;
      if (isRestParameter) {
        // Rest parameters don't have defaults, just use the tuple element names
        paramsWithDefaults = paramNames.join(', ');
      } else {
        paramsWithDefaults = params.map((p: any) => {
          const name = p.getName();
          const hasDefault = p.hasInitializer && p.hasInitializer();
          if (hasDefault) {
            const initializer = p.getInitializer();
            const defaultValue = initializer ? initializer.getText() : undefined;
            return defaultValue ? `${name} = ${defaultValue}` : name;
          }
          return name;
        }).join(', ');
      }
      
      const newParams = isTypeScript 
        ? `{ ${paramsWithDefaults} }: ${paramTypeText}`
        : `{ ${paramsWithDefaults} }`;
      const newFn = before + newParams + after;
      return newFn;
    };

    // Resolve target symbol
    const typeChecker = project.getTypeChecker();
    let targetSym = targetFunction.getSymbol && targetFunction.getSymbol();
    
    // For arrow functions/function expressions in variables, get symbol from the variable
    if (!targetSym && targetVariableDeclaration) {
      targetSym = targetVariableDeclaration.getSymbol && targetVariableDeclaration.getSymbol();
    }
    
    const resolvedTarget = targetSym && (targetSym.getAliasedSymbol ? (targetSym.getAliasedSymbol() || targetSym) : targetSym);
    if (!resolvedTarget) {
      void vscode.window.showInformationMessage('Objectify Params: This function cannot be converted — cannot resolve symbol for the selected function.');
      return;
    }

    const confirmed: any[] = [];
    let fuzzy: any[] = [];
    let scanCallIndex = 0;
    let totalScannedCalls = 0;

    const files = project.getSourceFiles();
    log('scanning', files.length, 'source files (node_modules excluded where possible)');
    for (const sf of files) {
      const sfPath = sf.getFilePath && sf.getFilePath();
      if (sfPath && sfPath.indexOf(path.sep + 'node_modules' + path.sep) >= 0) continue;
      const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression();
        if (!expr) continue;
        const exprText = expr.getText();

        // Check for .call(), .apply(), .bind() - these have PropertyAccessExpression
        if (expr.getKind && expr.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expr as any;
          const propName = propAccess.getName && propAccess.getName();
          
          if (propName === 'call' || propName === 'apply' || propName === 'bind') {
            const objExpr = propAccess.getExpression && propAccess.getExpression();
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
                  tempEditor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
                  
                  const highlightDecoration = vscode.window.createTextEditorDecorationType({ 
                    backgroundColor: 'rgba(255,100,100,0.3)',
                    border: '1px solid rgba(255,100,100,0.8)'
                  });
                  tempEditor.setDecorations(highlightDecoration, [new vscode.Range(callStartPos, callEndPos)]);
                  
                  const response = await vscode.window.showWarningMessage(
                    `Objectify Params: Cannot convert function.\n\ncall/apply/bind methods are not supported.`,
                    { modal: true }
                  );
                  
                  highlightDecoration.dispose();
                  
                  log('User notified about', propName, '- stopping conversion');
                  return;
                }
              } catch (e) {
                log('error showing call/apply/bind warning:', e);
              }
              continue;
            }
          }
        }

        if (!fnName) continue;
        const looksLikeCall = (exprText === fnName || exprText.endsWith('.' + fnName) || exprText.endsWith('[' + fnName + ']'));
        if (!looksLikeCall) continue;

        // Check for .call, .apply, or .bind usage
        const isCallApplyBind = exprText === `${fnName}.call` || exprText === `${fnName}.apply` || exprText === `${fnName}.bind` ||
                                exprText.endsWith(`.${fnName}.call`) || exprText.endsWith(`.${fnName}.apply`) || exprText.endsWith(`.${fnName}.bind`);
        
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
              tempEditor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
              
              const highlightDecoration = vscode.window.createTextEditorDecorationType({ 
                backgroundColor: 'rgba(255,100,100,0.3)',
                border: '1px solid rgba(255,100,100,0.8)'
              });
              tempEditor.setDecorations(highlightDecoration, [new vscode.Range(callStartPos, callEndPos)]);
              
              const response = await vscode.window.showWarningMessage(
                `Objectify Params: Cannot convert function.\n\ncall/apply/bind methods are not supported.`,
                { modal: true },
                'Cancel Scanning'
              );
              
              highlightDecoration.dispose();
              
              if (response === 'Cancel Scanning') {
                log('User cancelled scanning due to call/apply/bind');
                return;
              }
            }
          } catch (e) {
            log('error showing call/apply/bind warning:', e);
          }
          continue;
        }

        const calledSym = expr.getSymbol && expr.getSymbol();
        const resolvedCalled = calledSym && (calledSym.getAliasedSymbol ? (calledSym.getAliasedSymbol() || calledSym) : calledSym);

        if (looksLikeCall) {
          try {
            const dbgArgs = call.getArguments().map((a: any) => a ? a.getText() : 'undefined');
            log('candidate call:', { file: sf.getFilePath(), exprText, args: dbgArgs, resolvedCalled: !!resolvedCalled });
          } catch (e) {
            log('candidate call (could not read args) ', { file: sf.getFilePath(), exprText, resolvedCalled: !!resolvedCalled });
          }
        }

        if (resolvedCalled) {
          try {
            const fnId = resolvedTarget.getFullyQualifiedName ? resolvedTarget.getFullyQualifiedName() : resolvedTarget.getEscapedName && resolvedTarget.getEscapedName();
            const callId = resolvedCalled.getFullyQualifiedName ? resolvedCalled.getFullyQualifiedName() : resolvedCalled.getEscapedName && resolvedCalled.getEscapedName();
            
            // Only check for collision if we have valid IDs to compare
            const canCompare = fnId && callId;
            const isMatch = canCompare && fnId === callId;
            const isCollision = canCompare && fnId !== callId;
            
            if (isMatch || !canCompare) {
              const args = call.getArguments();
              const argsText = args.map((a: any) => a ? a.getText() : 'undefined');
              if (argsText.length === 1 && typeof argsText[0] === 'string' && argsText[0].trim().startsWith('{')) {
                log('skipping already-object call at', sf.getFilePath(), 'text:', argsText[0]);
              } else {
                // Check if argument count matches parameter count
                if (args.length !== paramNames.length) {
                  log('argument count mismatch:', args.length, 'args vs', paramNames.length, 'params in', sf.getFilePath());
                  fuzzy.push({ filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'arg-count-mismatch', score: 3 });
                } else if (args.length === 0) {
                  fuzzy.push({ filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'no-args', score: 10 });
                } else {
                  const firstArgText = (argsText[0] || '').trim();
                  if (firstArgText === 'undefined' || firstArgText === 'void 0') {
                    fuzzy.push({ filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'undefined-arg', score: 10 });
                  } else {
                    confirmed.push({ filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText });
                  }
                }
              }
            } else if (isCollision) {
              // Store name collision for later processing
              fuzzy.push({ filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText: [], reason: 'name-collision', score: 1 });
              continue;
            }
          } catch (e) {
            const args = call.getArguments();
            const argsText = args.map((a: any) => a ? a.getText() : 'undefined');
            fuzzy.push({ filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'symbol-compare-error', score: 5 });
          }
        } else {
          const args = call.getArguments();
          const argsText = args.map((a: any) => a ? a.getText() : 'undefined');
          fuzzy.push({ filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'unresolved', score: expr.getKind() === SyntaxKind.PropertyAccessExpression ? 8 : 4 });
        }
      }
    }

    // Also search .vue files in workspace for template calls (simple textual search)
    const cfg = vscode.workspace.getConfiguration('objectifyParams');
    const excludeStr = (cfg.get('exclude') as string) || '**/node_modules/**';
    const excludePatterns = excludeStr.split(/\s+/).filter(Boolean);
    const vuePatterns = ['**/*.vue'];
    let vueFilesRel: string[] = [];
    for (const p of vuePatterns) {
      try { vueFilesRel = vueFilesRel.concat(glob.sync(p, { cwd: workspaceRoot, ignore: excludePatterns, nodir: true })); } catch (e) { }
    }
    vueFilesRel = Array.from(new Set(vueFilesRel));
    const vueFiles = vueFilesRel.map(f => path.join(workspaceRoot, f));
    for (const vf of vueFiles) {
      const txt = fs.readFileSync(vf, 'utf8');
      const re = new RegExp(fnName + '\\s*\\(', 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        const idx = m.index;
        const before = txt.slice(0, idx);
        const line = before.split('\n').length;
        fuzzy.push({ filePath: vf, rangeStart: idx, rangeEnd: idx + fnName.length, text: txt.substr(idx, 200), reason: 'vue-template', score: 9, argsText: null });
      }
    }

    const safeSerial = (arr: any[]) => arr.map(c => ({ filePath: c.filePath, start: c.start, end: c.end, exprText: c.exprText, argsText: c.argsText, reason: c.reason }));
    log('confirmed call count:', confirmed.length, 'fuzzy count:', fuzzy.length);
    try {
      log('confirmed details:', JSON.stringify(safeSerial(confirmed), null, 2));
      log('fuzzy details:', JSON.stringify(safeSerial(fuzzy), null, 2));
    } catch (e) {
      log('confirmed examples:', confirmed.slice(0, 10));
      log('fuzzy examples:', fuzzy.slice(0, 10));
    }

    // Get monitor conversions setting early as it's used in multiple places
    const monitorConversions = cfg.get('monitorConversions') as boolean;
    const highlightDelay = (cfg.get('highlightDelay') as number) ?? 1000;

    // If no calls found, still convert the function signature
    if (confirmed.length === 0 && fuzzy.length === 0) {
      log('No calls found, converting function signature only');
      
      // Get types and build the converted signature
      const isTypeScript = sourceFile.getFilePath().endsWith('.ts') || sourceFile.getFilePath().endsWith('.tsx');
      const paramTypes = params.map((p: any) => {
        if (isRestParameter && restTupleElements.length > 0) {
          const typeNode = p.getTypeNode();
          if (typeNode) {
            const typeText = typeNode.getText();
            const tupleMatch = typeText.match(/\[([^\]]+)\]/);
            if (tupleMatch) {
              const elements = tupleMatch[1].split(',').map((e: string) => e.trim());
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

      let paramTypeText = '';
      if (isTypeScript) {
        if (isRestParameter) {
          const flatTypes = paramTypes.flat();
          paramTypeText = `{ ${paramNames.map((n: string, i: number) => {
            const param = params[0];
            const isOptional = param && param.hasQuestionToken && param.hasQuestionToken();
            const optionalMark = isOptional ? '?' : '';
            return `${n}${optionalMark}: ${flatTypes[i] || 'any'}`;
          }).join('; ')} }`;
        } else {
          paramTypeText = `{ ${paramNames.map((n: string, i: number) => {
            const param = params[i];
            const isOptional = param && param.hasQuestionToken && param.hasQuestionToken();
            const optionalMark = isOptional ? '?' : '';
            return `${n}${optionalMark}: ${paramTypes[i] || 'any'}`;
          }).join('; ')} }`;
        }
      }

      const newFnText = transformFunctionText(originalFunctionText, paramNames, paramTypeText, isTypeScript);
      
      const edit = new vscode.WorkspaceEdit();
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const startPos = doc.positionAt(targetStart);
      const endPos = doc.positionAt(targetEnd);
      edit.replace(uri, new vscode.Range(startPos, endPos), newFnText);
      
      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        // Flash the converted function for 1 second
        if (originalEditor) {
          await vscode.window.showTextDocument(originalEditor.document, { 
            selection: new vscode.Selection(startPos, startPos),
            preserveFocus: false 
          });
          
          const flashDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(100,255,100,0.3)',
            border: '1px solid rgba(100,255,100,0.8)'
          });
          
          originalEditor.setDecorations(flashDecoration, [new vscode.Range(startPos, doc.positionAt(targetStart + newFnText.length))]);
          await new Promise(r => setTimeout(r, highlightDelay));
          flashDecoration.dispose();
        }
        
        void vscode.window.showInformationMessage(`Objectify Params: Updated function signature (no calls found in workspace).`);
      }
      return;
    }

    if (fuzzy.length === 0 && confirmed.length > 0) {
      let aborted = false;
      
      // Check if monitor conversions is enabled (already retrieved above)
      if (monitorConversions) {
        aborted = await monitorConfirmedCalls(
          confirmed,
          confirmed.length,
          0,
          paramNames,
          highlightDelay,
          originalEditor,
          originalSelection
        );
        
        if (aborted) {
          return;
        }
      }
      
      const edit = new vscode.WorkspaceEdit();
      const docsToSave = new Map<string, vscode.TextDocument>();
      const replByFile = new Map<string, string>();
      const buildReplacement = (exprText: string, argsTextArr: string[]) => {
        const props = paramNames.map((name, idx) => {
          const aText = argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
          if (aText === name) return `${name}`;
          return `${name}:${aText}`;
        }).join(', ');
        return `${exprText}({ ${props} })`;
      };
      for (const c of confirmed) {
        const uri = vscode.Uri.file(c.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        docsToSave.set(c.filePath, doc);
        const startPos = doc.positionAt(c.start);
        const endPos = doc.positionAt(c.end);
        const orig = doc.getText().slice(c.start, c.end);
        const repl = buildReplacement(c.exprText, c.argsText);
        log('preparing replace in', c.filePath);
        log('---orig---\n' + orig + '\n---repl---\n' + repl);
        edit.replace(uri, new vscode.Range(startPos, endPos), repl);
      }
      const ok = await vscode.workspace.applyEdit(edit);
      log('applyEdit result:', ok);
      log('modified', docsToSave.size, 'file(s) - files are marked dirty, user can save manually');

      const paramTypes = params.map((p: any) => {
        const tn = p.getTypeNode && p.getTypeNode();
        if (tn) return tn.getText();
        try { return p.getType().getText(); } catch (e) { return 'any'; }
      });
      
      let paramTypeText: string;
      if (isRestParameter && restTupleElements.length > 0) {
        // Extract individual types from tuple type [cmd: string, val: any]
        const restParam = params[0];
        const typeNode = restParam.getTypeNode();
        const typeText = typeNode ? typeNode.getText() : '';
        const tupleMatch = typeText.match(/\[([^\]]+)\]/);
        
        if (tupleMatch) {
          const elements = tupleMatch[1].split(',').map(e => e.trim());
          const types = elements.map(e => {
            const colonIndex = e.indexOf(':');
            return colonIndex > 0 ? e.substring(colonIndex + 1).trim() : 'any';
          });
          paramTypeText = `{ ${paramNames.map((n, i) => `${n}: ${types[i] || 'any'}`).join('; ')} }`;
        } else {
          paramTypeText = `{ ${paramNames.map(n => `${n}: any`).join('; ')} }`;
        }
      } else {
        paramTypeText = `{ ${paramNames.map((n, i) => {
          const param = params[i];
          const isOptional = param && param.hasQuestionToken && param.hasQuestionToken();
          const optionalMark = isOptional ? '?' : '';
          return `${n}${optionalMark}: ${paramTypes[i] || 'any'}`;
        }).join('; ')} }`;
      }
      
      const isTypeScript = sourceFile.getFilePath().endsWith('.ts') || sourceFile.getFilePath().endsWith('.tsx');
      const newFnText = transformFunctionText(originalFunctionText, paramNames, paramTypeText, isTypeScript);
      
      try {
        await applyFunctionEditAndHighlight(
          sourceFile,
          originalFunctionText,
          newFnText,
          targetStart,
          targetEnd,
          originalEditor,
          originalSelection,
          highlightDelay,
          confirmed.length
        );
      } catch (e) {
        log('error applying function text edit', e);
      }
      if (confirmed.length > 0) {
        void vscode.window.showInformationMessage(`Objectify Params: Converted ${confirmed.length} call(s) and updated function.`);
      } else {
        void vscode.window.showInformationMessage('Objectify Params: Updated function signature (no calls were converted).');
      }
      return;
    }

    const confirmedSet = new Set(confirmed.map(c => `${c.filePath}:${c.start}:${c.end}`));
    const initialFuzzyCount = fuzzy.length;
    fuzzy = fuzzy.filter(f => {
      const key = f.start !== undefined && f.end !== undefined ? `${f.filePath}:${f.start}:${f.end}` : null;
      return !key || !confirmedSet.has(key);
    });
    if (fuzzy.length !== initialFuzzyCount) log('removed', initialFuzzyCount - fuzzy.length, 'fuzzy candidates that matched confirmed calls');
    fuzzy.sort((a, b) => (b.score || 0) - (a.score || 0));

    let aborted = false;
    
    log('monitorConversions:', monitorConversions, 'confirmed.length:', confirmed.length);
    
    // Process fuzzy calls first, then confirmed calls (when monitoring is enabled)


    const highlightDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(255,255,0,0.4)' });
    const greenDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(100,255,100,0.3)' });
    const redDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(255,100,100,0.3)' });
    const totalCalls = confirmed.length + fuzzy.length;
    const totalFuzzy = fuzzy.length;
    let callIdx = 0; // Start fuzzy calls at index 1
    const acceptedFuzzy: typeof fuzzy = []; // Track which fuzzy calls were accepted
    for (const candidate of fuzzy) {
      callIdx++;
      
      // Handle name collisions
      if (candidate.reason === 'name-collision') {
        const conflictFile = candidate.filePath;
        log('Name collision detected in', conflictFile);
        
        try {
          const doc = await vscode.workspace.openTextDocument(conflictFile);
          const callStartPos = doc.positionAt(candidate.start);
          const callEndPos = doc.positionAt(candidate.end);
          
          await vscode.window.showTextDocument(doc, { preview: true });
          const tempEditor = vscode.window.activeTextEditor;
          
          if (tempEditor) {
            const topLine = Math.max(0, callStartPos.line - 5);
            const topPos = new vscode.Position(topLine, 0);
            tempEditor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
            
            const collisionDecoration = vscode.window.createTextEditorDecorationType({ 
              backgroundColor: 'rgba(255,100,100,0.3)',
              border: '1px solid rgba(255,100,100,0.8)'
            });
            tempEditor.setDecorations(collisionDecoration, [new vscode.Range(callStartPos, callEndPos)]);
            
            const choice = await vscode.window.showWarningMessage(
              `Objectify Params: Processing function call ${callIdx} of ${totalCalls}.\n\nName collision detected. This call will not be converted.`,
              { modal: true },
              'Continue'
            );
            
            collisionDecoration.dispose();
            
            // Restore original editor
            if (originalEditor) {
              await vscode.window.showTextDocument(originalEditor.document, { 
                selection: originalSelection, 
                preserveFocus: false 
              });
            }
            
            if (choice === undefined) {
              log('User cancelled scanning due to name collision');
              highlightDecoration.dispose();
              greenDecoration.dispose();
              redDecoration.dispose();
              void vscode.window.showInformationMessage('Objectify Params: Operation cancelled — no changes made.');
              return;
            }
          }
        } catch (e) {
          log('Error showing collision warning', e);
        }
        
        continue;
      }
      let doc: vscode.TextDocument | undefined;
      let startPos: vscode.Position | undefined;
      let endPos: vscode.Position | undefined;
      if (candidate.filePath && typeof candidate.start === 'number' && typeof candidate.end === 'number') {
        doc = await vscode.workspace.openTextDocument(candidate.filePath);
        startPos = doc.positionAt(candidate.start);
        endPos = doc.positionAt(candidate.end);
        await vscode.window.showTextDocument(doc, { preview: true });
        const editor2 = vscode.window.activeTextEditor;
        if (editor2) {
          const topLine = Math.max(0, startPos.line - 6);
          const topPos = new vscode.Position(topLine, 0);
          editor2.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
          // Show yellow (original) since we don't know user's choice yet
          editor2.setDecorations(highlightDecoration, [new vscode.Range(startPos, endPos)]);
        }
      } else if (candidate.filePath && typeof candidate.rangeStart === 'number') {
        doc = await vscode.workspace.openTextDocument(candidate.filePath);
        await vscode.window.showTextDocument(doc, { preview: true });
        const editor2 = vscode.window.activeTextEditor;
        if (editor2) {
          startPos = doc.positionAt(candidate.rangeStart);
          endPos = doc.positionAt(candidate.rangeEnd || (candidate.rangeStart + 1));
          const topLine = Math.max(0, startPos.line - 6);
          const topPos = new vscode.Position(topLine, 0);
          editor2.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
          // Show yellow (original) since we don't know user's choice yet
          editor2.setDecorations(highlightDecoration, [new vscode.Range(startPos, endPos)]);
        }
      }

      // Check if converting this call would lose arguments
      const argCount = candidate.argsText ? candidate.argsText.length : 0;
      const willLoseArgs = argCount > paramNames.length;
      
      let choice: string | undefined;
      if (willLoseArgs) {
        // Change to red (won't convert)
        let currentEditor = vscode.window.activeTextEditor;
        if (currentEditor && startPos && endPos) {
          currentEditor.setDecorations(highlightDecoration, []);
          currentEditor.setDecorations(redDecoration, [new vscode.Range(startPos, endPos)]);
        }
        
        choice = await vscode.window.showWarningMessage(
          `Objectify Params: Processing function call ${callIdx} of ${totalCalls}.\n\n` +
          `Argument count mismatch. This call has ${argCount} argument(s) but the function has ${paramNames.length} parameter(s). ` +
          `Converting would lose ${argCount - paramNames.length} argument(s): ` +
          `${candidate.argsText?.slice(paramNames.length).join(', ')}. ` +
          `This function cannot be converted safely.`,
          { modal: true },
          'Skip This Call'
        );
        
        currentEditor = vscode.window.activeTextEditor;
        if (currentEditor) {
          currentEditor.setDecorations(highlightDecoration, []);
          currentEditor.setDecorations(redDecoration, []);
        }
        
        if (choice === undefined) {
          highlightDecoration.dispose();
          greenDecoration.dispose();
          redDecoration.dispose();
          void vscode.window.showInformationMessage('Objectify Params: Operation cancelled — no changes made.');
          if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, { selection: originalSelection, preserveFocus: false });
          return;
        }
        
        // Skip this call and continue to next fuzzy
        continue;
      } else {
        choice = await vscode.window.showInformationMessage(
          `Objectify Params: Processing function call ${callIdx} of ${totalCalls}.\n\nIs this a call to the correct function? Should it be converted?`,
          { modal: true },
          'Convert',
          'Skip'
        );
        
        // Handle cancel (×) button - abort entire conversion
        if (choice === undefined) {
          log('User clicked cancel (×) in validation dialog');
          highlightDecoration.dispose();
          greenDecoration.dispose();
          redDecoration.dispose();
          void vscode.window.showInformationMessage('Objectify Params: Operation cancelled — no changes made.');
          if (originalEditor && originalSelection) {
            await vscode.window.showTextDocument(originalEditor.document, { 
              selection: originalSelection, 
              preserveFocus: false 
            });
          }
          return;
        }
        
        // Change color based on choice
        const currentEditor = vscode.window.activeTextEditor;
        if (currentEditor && startPos && endPos) {
          // Clear previous decorations
          currentEditor.setDecorations(highlightDecoration, []);
          currentEditor.setDecorations(greenDecoration, []);
          currentEditor.setDecorations(redDecoration, []);
          
          // Only show post-dialog preview if delay > 0 AND user chose Skip
          if (highlightDelay > 0 && choice === 'Skip') {
            // Red for won't convert
            currentEditor.setDecorations(redDecoration, [new vscode.Range(startPos, endPos)]);
            await new Promise(r => setTimeout(r, highlightDelay));
          }
        }
        
        if (choice !== 'Convert') {
          if (currentEditor) {
            currentEditor.setDecorations(redDecoration, []);
          }
          // Skip this call and continue with the rest
          continue;
        }
      }

      // User chose to convert this fuzzy call
      acceptedFuzzy.push(candidate);

      try {
        if (candidate.argsText && candidate.argsText.length >= paramNames.length) {
          const props = paramNames.map((name, idx) => {
            const aText = candidate.argsText[idx] ? candidate.argsText[idx] : 'undefined';
            if (aText === name) return `${name}`;
            return `${name}:${aText}`;
          }).join(', ');
          const repl = `${candidate.exprText}({ ${props} })`;

          // Only show preview if highlightDelay > 0
          if (highlightDelay > 0) {
            const visibleEditors = vscode.window.visibleTextEditors || [];
            let targetEditor = visibleEditors.find(e => e.document && e.document.fileName === candidate.filePath);
            if (!targetEditor) {
              try {
                const docToOpen = await vscode.workspace.openTextDocument(candidate.filePath);
                targetEditor = await vscode.window.showTextDocument(docToOpen, { preview: true });
              } catch (e) {
                const activeEditor = vscode.window.activeTextEditor || originalEditor;
                if (activeEditor && activeEditor.document && activeEditor.document.fileName === candidate.filePath) targetEditor = activeEditor;
              }
            }

            if (targetEditor) {
              const doc = targetEditor.document;
              const startP = doc.positionAt(candidate.start);
              const endP = doc.positionAt(candidate.end);
              const priorSelections = targetEditor.selections.slice();
              const priorVisibleRanges = targetEditor.visibleRanges.slice();
              try { targetEditor.setDecorations(highlightDecoration, []); } catch (e) { }
              try { targetEditor.setDecorations(greenDecoration, []); } catch (e) { }
              await targetEditor.edit(editBuilder => { editBuilder.replace(new vscode.Range(startP, endP), repl); });
              const callRange = new vscode.Range(startP, doc.positionAt(candidate.start + repl.length));
              targetEditor.setDecorations(greenDecoration, [callRange]);
              await new Promise(r => setTimeout(r, highlightDelay));
              await vscode.commands.executeCommand('undo');
              try { targetEditor.setDecorations(highlightDecoration, []); } catch (e) { }
              try { targetEditor.setDecorations(greenDecoration, []); } catch (e) { }
              try { targetEditor.setDecorations(redDecoration, []); } catch (e) { }
              try { targetEditor.selections = priorSelections; } catch (e) { }
              try { if (priorVisibleRanges && priorVisibleRanges.length) targetEditor.revealRange(priorVisibleRanges[0], vscode.TextEditorRevealType.Default); } catch (e) { }
            } else {
              const previewText = repl;
              void vscode.window.showInformationMessage(`Preview: ${previewText}`);
            }
          }
        }
      } catch (e) {
        log('preview error', e);
      }
    }

    // If monitoring, show preview for confirmed calls AFTER fuzzy calls
    if (monitorConversions && confirmed.length > 0 && !aborted) {
      log('Entering confirmed monitoring block');
      aborted = await monitorConfirmedCalls(
        confirmed, 
        totalCalls, 
        fuzzy.length,
        paramNames, 
        highlightDelay, 
        originalEditor, 
        originalSelection
      );
      
      if (aborted) {
        return;
      }
    }

    if (aborted) {
      log('Aborted after confirmed monitoring');
      if (originalEditor && originalSelection) {
        await vscode.window.showTextDocument(originalEditor.document, { 
          selection: originalSelection, 
          preserveFocus: false 
        });
      }
      return;
    }

    const editAll = new vscode.WorkspaceEdit();
    const docsToSaveAll = new Map<string, vscode.TextDocument>();
    const buildReplacementAll = (exprText: string, argsTextArr: string[]) => {
      const props = paramNames.map((name, idx) => {
        const aText = argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
        if (aText === name) return `${name}`;
        return `${name}:${aText}`;
      }).join(', ');
      return `${exprText}({ ${props} })`;
    };

    const allCandidates = [...confirmed, ...acceptedFuzzy];
    log('allCandidates count:', allCandidates.length, '(confirmed:', confirmed.length, 'acceptedFuzzy:', acceptedFuzzy.length, ')');
    
    if (allCandidates.length === 0) {
      log('No candidates to convert after fuzzy review');
      void vscode.window.showInformationMessage('Objectify Params: No calls were converted.');
      if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, { selection: originalSelection, preserveFocus: false });
      return;
    }
    
    const replAllMap = new Map<string, string>();
    for (const c of allCandidates) {
      if (c.filePath && typeof c.start === 'number' && typeof c.end === 'number') {
        const uri = vscode.Uri.file(c.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        docsToSaveAll.set(c.filePath, doc);
        const startP = doc.positionAt(c.start);
        const endP = doc.positionAt(c.end);
        const replAll = buildReplacementAll(c.exprText, c.argsText);
        log('scheduling replace (all) in', c.filePath, 'range', c.start, c.end);
        editAll.replace(uri, new vscode.Range(startP, endP), replAll);
      } else if (c.filePath && typeof c.rangeStart === 'number') {
        const uri = vscode.Uri.file(c.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        docsToSaveAll.set(c.filePath, doc);
        const full = doc.getText();
        const after = full.slice(c.rangeStart);
        const parenIndex = after.indexOf('(');
        const closeIndex = after.indexOf(')');
        if (parenIndex >= 0 && closeIndex > parenIndex) {
          const argsText = after.slice(parenIndex + 1, closeIndex);
          const argParts = argsText.split(',').map((s: string) => s.trim()).filter((s: string) => s.length);
          if (argParts.length === paramNames.length) {
            const props = paramNames.map((name, idx) => `${name}:${argParts[idx]}`).join(', ');
            const replaced = after.slice(0, parenIndex + 1) + `{ ${props} }` + after.slice(closeIndex);
            const newFull = full.slice(0, c.rangeStart) + replaced;
            editAll.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(full.length)), newFull);
          }
        }
      }
    }

    const ok2 = await vscode.workspace.applyEdit(editAll);
    log('applyEdit(all) result:', ok2);
    log('modified', docsToSaveAll.size, 'file(s) - files are marked dirty, user can save manually');

    const paramTypes2 = params.map((p: any) => {
      const tn = p.getTypeNode && p.getTypeNode();
      if (tn) return tn.getText();
      try { return p.getType().getText(); } catch (e) { return 'any'; }
    });
    
    let paramTypeText2: string;
    if (isRestParameter && restTupleElements.length > 0) {
      // Extract individual types from tuple type [cmd: string, val: any]
      const restParam = params[0];
      const typeNode = restParam.getTypeNode();
      const typeText = typeNode ? typeNode.getText() : '';
      const tupleMatch = typeText.match(/\[([^\]]+)\]/);
      
      if (tupleMatch) {
        const elements = tupleMatch[1].split(',').map(e => e.trim());
        const types = elements.map(e => {
          const colonIndex = e.indexOf(':');
          return colonIndex > 0 ? e.substring(colonIndex + 1).trim() : 'any';
        });
        paramTypeText2 = `{ ${paramNames.map((n, i) => `${n}: ${types[i] || 'any'}`).join('; ')} }`;
      } else {
        paramTypeText2 = `{ ${paramNames.map(n => `${n}: any`).join('; ')} }`;
      }
    } else {
      paramTypeText2 = `{ ${paramNames.map((n, i) => {
        const param = params[i];
        const isOptional = param && param.hasQuestionToken && param.hasQuestionToken();
        const optionalMark = isOptional ? '?' : '';
        return `${n}${optionalMark}: ${paramTypes2[i] || 'any'}`;
      }).join('; ')} }`;
    }
    
    const isTypeScript2 = sourceFile.getFilePath().endsWith('.ts') || sourceFile.getFilePath().endsWith('.tsx');
    const newFnText2 = transformFunctionText(originalFunctionText, paramNames, paramTypeText2, isTypeScript2);
    
    try {
      const totalConverted = confirmed.length + acceptedFuzzy.length;
      await applyFunctionEditAndHighlight(
        sourceFile,
        originalFunctionText,
        newFnText2,
        targetStart,
        targetEnd,
        originalEditor,
        originalSelection,
        highlightDelay,
        totalConverted
      );
    } catch (e) {
      log('error applying function text edit (all)', e);
    }

    void vscode.window.showInformationMessage(`Objectify Params: Converted ${confirmed.length + acceptedFuzzy.length} call(s) and updated function.`);
  } catch (err) {
    console.error(err);
    void vscode.window.showErrorMessage('An error occurred: ' + (err.message || err));
  }
}
