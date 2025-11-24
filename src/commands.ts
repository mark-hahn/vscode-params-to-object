import * as vscode from 'vscode';
import * as path from 'path';
import { SyntaxKind } from 'ts-morph';
import glob from 'glob';
import * as fs from 'fs';
import * as utils from './utils';
import * as parse from './parse';

const { log } = utils.getLog('cmds');

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
        if ((kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) && init.getStart() <= cursorOffset && cursorOffset <= init.getEnd()) {
          targetFunction = init;
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
      void vscode.window.showInformationMessage('Not on a function.');
      return;
    }

    const params = targetFunction.getParameters();
    if (!params || params.length === 0) {
      void vscode.window.showInformationMessage('Function has zero parameters — nothing to convert.');
      return;
    }

    const objectParamName = '$params$';

    if (params.length === 1 && params[0].getName && params[0].getName() === objectParamName) {
      void vscode.window.showInformationMessage('Function already uses object parameter — nothing to do.');
      return;
    }

    const paramNames = params.map((p: any) => p.getName());
    const fnName = targetFunction.getName ? targetFunction.getName() : null;
    const targetStart = targetFunction.getStart();
    const targetEnd = targetFunction.getEnd();
    const originalFunctionText = targetFunction.getText();

    // Check if function already uses object destructuring pattern
    const hasObjectDestructuring = params.length === 1 && params[0].getStructure && (() => {
      try {
        const paramText = params[0].getText();
        return paramText.trim().startsWith('{') && paramText.includes(':');
      } catch {
        return false;
      }
    })();

    if (hasObjectDestructuring) {
      // Show function definition at top with highlight
      const funcStartPos = editor.document.positionAt(targetStart);
      const funcEndPos = editor.document.positionAt(targetEnd);
      const topLine = Math.max(0, funcStartPos.line - 3);
      const topPos = new vscode.Position(topLine, 0);
      editor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
      
      const highlightDecoration = vscode.window.createTextEditorDecorationType({ 
        backgroundColor: 'rgba(255,200,0,0.3)',
        border: '1px solid rgba(255,200,0,0.6)'
      });
      editor.setDecorations(highlightDecoration, [new vscode.Range(funcStartPos, funcEndPos)]);

      const choice = await vscode.window.showWarningMessage(
        `Function "${fnName || '<anonymous>'}" appears to already use object destructuring. Continue anyway?`,
        { modal: true },
        'Continue',
        'Cancel'
      );

      highlightDecoration.dispose();

      if (choice !== 'Continue') {
        void vscode.window.showInformationMessage('Operation cancelled.');
        return;
      }
    }

    const transformFunctionText = (fnText: string, paramNames: string[], objectParamName: string, paramTypeText: string, isTypeScript: boolean) => {
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
      const newParams = isTypeScript 
        ? `{ ${paramNames.join(', ')} }: ${paramTypeText}`
        : `{ ${paramNames.join(', ')} }`;
      const newFn = before + newParams + after;
      return newFn;
    };

    // Resolve target symbol
    const typeChecker = project.getTypeChecker();
    const targetSym = targetFunction.getSymbol && targetFunction.getSymbol();
    const resolvedTarget = targetSym && (targetSym.getAliasedSymbol ? (targetSym.getAliasedSymbol() || targetSym) : targetSym);
    if (!resolvedTarget) {
      void vscode.window.showInformationMessage('Cannot resolve symbol for the selected function — aborting.');
      return;
    }

    const confirmed: any[] = [];
    let fuzzy: any[] = [];

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

        if (!fnName) continue;
        const looksLikeCall = (exprText === fnName || exprText.endsWith('.' + fnName) || exprText.endsWith('[' + fnName + ']'));
        if (!looksLikeCall) continue;

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
                if (args.length === 0) {
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
              // Show name collision warning
              const conflictFile = sf.getFilePath();
              log('Name collision detected in', conflictFile);
              
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
                  
                  const choice = await vscode.window.showWarningMessage(
                    `⚠️ Name collision detected\n\nFound a call to "${fnName}" in:\n${conflictFile}\n\nThis call resolves to a different function than the one you're converting. This often happens when:\n• Scanning compiled JavaScript output\n• Multiple functions share the same name\n• Import aliases create ambiguity\n\nThis call will be ignored.`,
                    { modal: true },
                    'Continue Scanning',
                    'Cancel Scanning'
                  );
                  
                  highlightDecoration.dispose();
                  
                  // Restore original editor
                  if (originalEditor) {
                    await vscode.window.showTextDocument(originalEditor.document, { 
                      selection: originalSelection, 
                      preserveFocus: false 
                    });
                  }
                  
                  if (choice === 'Cancel Scanning') {
                    log('User cancelled scanning due to name collision');
                    return;
                  }
                }
              } catch (e) {
                log('Error showing collision warning', e);
              }
              
              // Continue scanning instead of breaking
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

    if (confirmed.length === 0 && fuzzy.length === 0) {
      void vscode.window.showInformationMessage(`No calls to ${fnName} were found in the workspace.`);
      return;
    }

    if (fuzzy.length === 0 && confirmed.length > 0) {
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
      const paramTypeText = `{ ${paramNames.map((n, i) => `${n}: ${paramTypes[i] || 'any'}`).join('; ')} }`;
      const isTypeScript = sourceFile.getFilePath().endsWith('.ts') || sourceFile.getFilePath().endsWith('.tsx');
      try {
        const uri = vscode.Uri.file(sourceFile.getFilePath());
        const doc = await vscode.workspace.openTextDocument(uri);
        const full = doc.getText();
        const newFnText = transformFunctionText(originalFunctionText, paramNames, objectParamName, paramTypeText, isTypeScript);
        const idx = full.indexOf(originalFunctionText);
        const startPosReplace = idx >= 0 ? doc.positionAt(idx) : doc.positionAt(targetStart);
        const endPosReplace = idx >= 0 ? doc.positionAt(idx + originalFunctionText.length) : doc.positionAt(targetEnd);
        const edit2 = new vscode.WorkspaceEdit();
        edit2.replace(uri, new vscode.Range(startPosReplace, endPosReplace), newFnText);
        const ok2 = await vscode.workspace.applyEdit(edit2);
        log('applied function text edit:', ok2);
      } catch (e) {
        log('error applying function text edit', e);
      }
      if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, { selection: originalSelection, preserveFocus: false });
      if (confirmed.length > 0) {
        void vscode.window.showInformationMessage(`Converted ${confirmed.length} call(s) and updated function.`);
      } else {
        void vscode.window.showInformationMessage('Updated function signature (no calls were converted).');
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

    const highlightDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(255,255,0,0.4)' });
    for (const candidate of fuzzy) {
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
          editor2.setDecorations(highlightDecoration, [new vscode.Range(startPos, endPos)]);
        }
      }

      const choice = await vscode.window.showInformationMessage(`Is this call a valid invocation of ${fnName}?`, { modal: true }, 'Valid', 'Invalid');
      if (choice !== 'Valid') {
        const currentEditor = vscode.window.activeTextEditor;
        if (currentEditor) currentEditor.setDecorations(highlightDecoration, []);
        highlightDecoration.dispose();
        void vscode.window.showInformationMessage('Operation cancelled — no changes made.');
        if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, { selection: originalSelection, preserveFocus: false });
        return;
      }

      try {
        if (candidate.argsText && candidate.argsText.length >= paramNames.length) {
          const props = paramNames.map((name, idx) => {
            const aText = candidate.argsText[idx] ? candidate.argsText[idx] : 'undefined';
            if (aText === name) return `${name}`;
            return `${name}:${aText}`;
          }).join(', ');
          const repl = `${candidate.exprText}({ ${props} })`;

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
            await targetEditor.edit(editBuilder => { editBuilder.replace(new vscode.Range(startP, endP), repl); });
            const callRange = new vscode.Range(startP, doc.positionAt(candidate.start + repl.length));
            targetEditor.setDecorations(highlightDecoration, [callRange]);
            await new Promise(r => setTimeout(r, 1000));
            await vscode.commands.executeCommand('undo');
            try { targetEditor.setDecorations(highlightDecoration, []); } catch (e) { }
            try { targetEditor.selections = priorSelections; } catch (e) { }
            try { if (priorVisibleRanges && priorVisibleRanges.length) targetEditor.revealRange(priorVisibleRanges[0], vscode.TextEditorRevealType.Default); } catch (e) { }
          } else {
            const previewText = repl;
            void vscode.window.showInformationMessage(`Preview: ${previewText}`);
          }
        }
      } catch (e) {
        log('preview error', e);
      }
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

    const allCandidates = [...confirmed, ...fuzzy];
    log('allCandidates count:', allCandidates.length, '(confirmed:', confirmed.length, 'fuzzy:', fuzzy.length, ')');
    
    if (allCandidates.length === 0) {
      log('No candidates to convert after fuzzy review');
      void vscode.window.showInformationMessage('No calls were converted.');
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
    const paramTypeText2 = `{ ${paramNames.map((n, i) => `${n}: ${paramTypes2[i] || 'any'}`).join('; ')} }`;
    const isTypeScript2 = sourceFile.getFilePath().endsWith('.ts') || sourceFile.getFilePath().endsWith('.tsx');
    try {
      const uri2 = vscode.Uri.file(sourceFile.getFilePath());
      const doc2 = await vscode.workspace.openTextDocument(uri2);
      const newFnText2 = transformFunctionText(originalFunctionText, paramNames, objectParamName, paramTypeText2, isTypeScript2);
      const full2 = doc2.getText();
      const idx2 = full2.indexOf(originalFunctionText);
      const startReplace2 = idx2 >= 0 ? doc2.positionAt(idx2) : doc2.positionAt(targetStart);
      const endReplace2 = idx2 >= 0 ? doc2.positionAt(idx2 + originalFunctionText.length) : doc2.positionAt(targetEnd);
      const edit3 = new vscode.WorkspaceEdit();
      edit3.replace(uri2, new vscode.Range(startReplace2, endReplace2), newFnText2);
      const ok3 = await vscode.workspace.applyEdit(edit3);
      log('applied function text edit (all):', ok3);
    } catch (e) {
      log('error applying function text edit (all)', e);
    }

    try { highlightDecoration.dispose(); } catch (e) { }
    if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, { selection: originalSelection, preserveFocus: false });
    void vscode.window.showInformationMessage(`Converted ${confirmed.length + fuzzy.length} call(s) and updated function.`);
  } catch (err) {
    console.error(err);
    void vscode.window.showErrorMessage('An error occurred: ' + (err.message || err));
  }
}
