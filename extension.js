const vscode = require('vscode');
const path = require('path');
const {Project, SyntaxKind} = require('ts-morph');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('Params-to-Object activated');

  const disposable = vscode.commands.registerCommand('paramsToObject.convert', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a file and place the cursor inside a function.');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const filePath = editor.document.fileName;
    const originalEditor = vscode.window.activeTextEditor;
    const originalSelection = originalEditor ? originalEditor.selection : undefined;
    const cursorOffset = editor.document.offsetAt(editor.selection.active);

    try {
      const project = new Project({
        tsConfigFilePath: undefined,
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          moduleResolution: 'node'
        }
      });

      // Add project files (JS/TS) from workspace, exclude node_modules — use glob to avoid scanning node_modules
      const glob = require('glob');
      const fs = require('fs');
      // Read include/exclude globs from configuration (space-separated strings)
      const cfg = vscode.workspace.getConfiguration('paramsToObject');
      const includeStr = cfg.get('include') || '**/*.ts **/*.js';
      const excludeStr = cfg.get('exclude') || '**/node_modules/**';
      const includePatterns = includeStr.split(/\s+/).filter(Boolean);
      const excludePatterns = excludeStr.split(/\s+/).filter(Boolean);

      let jsTsFilesRel = [];
      for (const p of includePatterns) {
        try {
          const found = glob.sync(p, {cwd: workspaceRoot, ignore: excludePatterns, nodir: true});
          jsTsFilesRel = jsTsFilesRel.concat(found);
        } catch (e) {
          // ignore pattern errors
        }
      }
      jsTsFilesRel = Array.from(new Set(jsTsFilesRel));
      const jsTsFiles = jsTsFilesRel.map(f => path.join(workspaceRoot, f));
      console.log('[params-to-object] workspaceRoot:', workspaceRoot);
      console.log('[params-to-object] includePatterns:', includePatterns, 'excludePatterns:', excludePatterns, 'found files:', jsTsFiles.length);
      if (jsTsFiles.length > 0) project.addSourceFilesAtPaths(jsTsFiles);

      // Ensure current file is in the project
      let sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = project.createSourceFile(filePath, editor.document.getText(), {overwrite: true});
      }

      // Find function declaration or function expression at cursor
      let targetFunction = null;
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
        vscode.window.showInformationMessage('Not on a function.');
        return;
      }

      const params = targetFunction.getParameters();
      if (!params || params.length === 0) {
        vscode.window.showInformationMessage('Function has zero parameters — nothing to convert.');
        return;
      }

      const objectParamName = '$params$';

      // If function already has been converted to a single object param, abort.
      if (params.length === 1 && params[0].getName && params[0].getName() === objectParamName) {
        vscode.window.showInformationMessage('Function already uses object parameter — nothing to do.');
        return;
      }

      const paramNames = params.map(p => p.getName());
      const fnName = targetFunction.getName ? targetFunction.getName() : null;
      const targetStart = targetFunction.getStart();
      const targetEnd = targetFunction.getEnd();
      const originalFunctionText = targetFunction.getText();

      const transformFunctionText = (fnText, paramNames, objectParamName, paramTypeText) => {
        const open = fnText.indexOf('(');
        if (open < 0) return fnText;
        // find matching closing paren
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
        // Use parameter-list destructuring: `({ a, b }: Type)` instead of body destructure
        const newParams = `{ ${paramNames.join(', ')} }: ${paramTypeText}`;
        const newFn = before + newParams + after;
        return newFn;
      };

      // Resolve target symbol
      const typeChecker = project.getTypeChecker();
      const targetSym = targetFunction.getSymbol && targetFunction.getSymbol();
      const resolvedTarget = targetSym && (targetSym.getAliasedSymbol ? (targetSym.getAliasedSymbol() || targetSym) : targetSym);
      if (!resolvedTarget) {
        vscode.window.showInformationMessage('Cannot resolve symbol for the selected function — aborting.');
        return;
      }

      // Collect candidates across project
      const confirmed = []; // {callNode, sf}
      let fuzzy = []; // {filePath, rangeStart, rangeEnd, text, node?, reason, score}
      let fatalConflict = null;

      const files = project.getSourceFiles();
      console.log('[params-to-object] scanning', files.length, 'source files (node_modules excluded where possible)');
      for (const sf of files) {
        // defensive: skip any files that live under node_modules
        const sfPath = sf.getFilePath && sf.getFilePath();
        if (sfPath && sfPath.indexOf(path.sep + 'node_modules' + path.sep) >= 0) continue;
        const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const call of calls) {
          const expr = call.getExpression();
          if (!expr) continue;
          const exprText = expr.getText();

          // quick textual match: identifier or property access ending with function name
          if (!fnName) continue; // anonymous target - skip
          const looksLikeCall = (exprText === fnName || exprText.endsWith('.' + fnName) || exprText.endsWith('[' + fnName + ']'));
          if (!looksLikeCall) continue;

          const calledSym = expr.getSymbol && expr.getSymbol();
          const resolvedCalled = calledSym && (calledSym.getAliasedSymbol ? (calledSym.getAliasedSymbol() || calledSym) : calledSym);

          if (looksLikeCall) {
            // diagnostic: log call expression and symbol resolution status
            try {
              const dbgArgs = call.getArguments().map(a => a ? a.getText() : 'undefined');
              console.log('[params-to-object] candidate call:', {file: sf.getFilePath(), exprText, args: dbgArgs, resolvedCalled: !!resolvedCalled});
            } catch (e) {
              console.log('[params-to-object] candidate call (could not read args) ', {file: sf.getFilePath(), exprText, resolvedCalled: !!resolvedCalled});
            }
          }

          if (resolvedCalled) {
            try {
              const fnId = resolvedTarget.getFullyQualifiedName ? resolvedTarget.getFullyQualifiedName() : resolvedTarget.getEscapedName && resolvedTarget.getEscapedName();
              const callId = resolvedCalled.getFullyQualifiedName ? resolvedCalled.getFullyQualifiedName() : resolvedCalled.getEscapedName && resolvedCalled.getEscapedName();
              if (fnId === callId) {
                const args = call.getArguments();
                const argsText = args.map(a => a ? a.getText() : 'undefined');
                // if call already passes an object literal as single arg, treat as already-converted and skip
                if (argsText.length === 1 && typeof argsText[0] === 'string' && argsText[0].trim().startsWith('{')) {
                  console.log('[params-to-object] skipping already-object call at', sf.getFilePath(), 'text:', argsText[0]);
                } else {
                  // treat missing or explicit undefined args as fuzzy/unsafe
                  if (args.length === 0) {
                    fuzzy.push({filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'no-args', score: 10});
                  } else {
                    const firstArgText = (argsText[0] || '').trim();
                    if (firstArgText === 'undefined' || firstArgText === 'void 0') {
                      fuzzy.push({filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'undefined-arg', score: 10});
                    } else {
                      confirmed.push({filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText});
                    }
                  }
                }
              } else {
                // resolved to a different symbol -> fatal conflict
                fatalConflict = {file: sf.getFilePath(), callText: call.getText(), resolved: callId, target: fnId};
                break;
              }
            } catch (e) {
              // treat as fuzzy
              const args = call.getArguments();
              const argsText = args.map(a => a ? a.getText() : 'undefined');
              fuzzy.push({filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'symbol-compare-error', score: 5});
            }
          } else {
            // unresolved -> fuzzy candidate
            const args = call.getArguments();
            const argsText = args.map(a => a ? a.getText() : 'undefined');
            fuzzy.push({filePath: sf.getFilePath(), start: call.getStart(), end: call.getEnd(), exprText: expr.getText(), argsText, reason: 'unresolved', score: expr.getKind() === SyntaxKind.PropertyAccessExpression ? 8 : 4});
          }
        }
        if (fatalConflict) break;
      }

      // Also search .vue files in workspace for template calls (simple textual search)
      // Use excludePatterns from config for .vue search as well
      const vuePatterns = ['**/*.vue'];
      let vueFilesRel = [];
      for (const p of vuePatterns) {
        try {vueFilesRel = vueFilesRel.concat(glob.sync(p, {cwd: workspaceRoot, ignore: excludePatterns, nodir: true}));} catch (e) { }
      }
      vueFilesRel = Array.from(new Set(vueFilesRel));
      const vueFiles = vueFilesRel.map(f => path.join(workspaceRoot, f));
      for (const vf of vueFiles) {
        const txt = require('fs').readFileSync(vf, 'utf8');
        const re = new RegExp(fnName + '\\s*\\(', 'g');
        let m;
        while ((m = re.exec(txt)) !== null) {
          const idx = m.index;
          // compute line and column
          const before = txt.slice(0, idx);
          const line = before.split('\n').length;
          fuzzy.push({filePath: vf, rangeStart: idx, rangeEnd: idx + fnName.length, text: txt.substr(idx, 200), reason: 'vue-template', score: 9, argsText: null});
        }
      }

      if (fatalConflict) {
        vscode.window.showInformationMessage(`Cannot process: found call resolved to a different symbol in ${fatalConflict.file}`);
        return;
      }

      const safeSerial = arr => arr.map(c => ({filePath: c.filePath, start: c.start, end: c.end, exprText: c.exprText, argsText: c.argsText, reason: c.reason}));
      console.log('[params-to-object] confirmed call count:', confirmed.length, 'fuzzy count:', fuzzy.length);
      try {
        console.log('[params-to-object] confirmed details:', JSON.stringify(safeSerial(confirmed), null, 2));
        console.log('[params-to-object] fuzzy details:', JSON.stringify(safeSerial(fuzzy), null, 2));
      } catch (e) {
        console.log('[params-to-object] confirmed examples:', confirmed.slice(0, 10));
        console.log('[params-to-object] fuzzy examples:', fuzzy.slice(0, 10));
      }

      // If there are no fuzzy candidates (and we may have confirmed), apply changes silently
      if (fuzzy.length === 0) {
        // apply call-site edits first (use WorkspaceEdit) then modify the function
        const edit = new vscode.WorkspaceEdit();
        const docsToSave = new Map();
        const buildReplacement = (exprText, argsTextArr) => {
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
          console.log('[params-to-object] preparing replace in', c.filePath);
          console.log('---orig---\n' + orig + '\n---repl---\n' + repl);
          edit.replace(uri, new vscode.Range(startPos, endPos), repl);
        }
        const ok = await vscode.workspace.applyEdit(edit);
        console.log('[params-to-object] applyEdit result:', ok);
        for (const [fp, d] of docsToSave) {await d.save(); console.log('[params-to-object] saved', fp);}

        // now update the target function textually (avoid saving ts-morph file which may overwrite workspace edits)
        const paramTypes = params.map(p => {
          const tn = p.getTypeNode && p.getTypeNode();
          if (tn) return tn.getText();
          try {return p.getType().getText();} catch (e) {return 'any';}
        });
        const paramTypeText = `{ ${paramNames.map((n, i) => `${n}: ${paramTypes[i] || 'any'}`).join('; ')} }`;
        try {
          const uri = vscode.Uri.file(sourceFile.getFilePath());
          const doc = await vscode.workspace.openTextDocument(uri);
          const full = doc.getText();
          const newFnText = transformFunctionText(originalFunctionText, paramNames, objectParamName, paramTypeText);
          const idx = full.indexOf(originalFunctionText);
          const startPosReplace = idx >= 0 ? doc.positionAt(idx) : doc.positionAt(targetStart);
          const endPosReplace = idx >= 0 ? doc.positionAt(idx + originalFunctionText.length) : doc.positionAt(targetEnd);
          const edit2 = new vscode.WorkspaceEdit();
          edit2.replace(uri, new vscode.Range(startPosReplace, endPosReplace), newFnText);
          const ok2 = await vscode.workspace.applyEdit(edit2);
          console.log('[params-to-object] applied function text edit:', ok2);
          await doc.save();
          console.log('[params-to-object] saved', uri.fsPath);
        } catch (e) {
          console.log('[params-to-object] error applying function text edit', e);
        }
        // restore editor
        if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, {selection: originalSelection, preserveFocus: false});
        vscode.window.showInformationMessage(`Converted ${confirmed.length} call(s) and updated function.`);
        return;
      }

      // Some fuzzy candidates: filter out any that are identical to confirmed ones, then present them in order
      const confirmedSet = new Set(confirmed.map(c => `${c.filePath}:${c.start}:${c.end}`));
      const initialFuzzyCount = fuzzy.length;
      fuzzy = fuzzy.filter(f => {
        const key = f.start !== undefined && f.end !== undefined ? `${f.filePath}:${f.start}:${f.end}` : null;
        return !key || !confirmedSet.has(key);
      });
      if (fuzzy.length !== initialFuzzyCount) console.log('[params-to-object] removed', initialFuzzyCount - fuzzy.length, 'fuzzy candidates that matched confirmed calls');
      // present them one by one in order of descending score (most suspicious first)
      fuzzy.sort((a, b) => (b.score || 0) - (a.score || 0));

      // create highlight decoration for previewing candidates
      const highlightDecoration = vscode.window.createTextEditorDecorationType({backgroundColor: 'rgba(255,255,0,0.4)'});
      for (const candidate of fuzzy) {
        // open preview of the candidate location using captured positions
        let doc;
        let startPos, endPos;
        if (candidate.filePath && typeof candidate.start === 'number' && typeof candidate.end === 'number') {
          doc = await vscode.workspace.openTextDocument(candidate.filePath);
          startPos = doc.positionAt(candidate.start);
          endPos = doc.positionAt(candidate.end);
          await vscode.window.showTextDocument(doc, {preview: true});
          const editor2 = vscode.window.activeTextEditor;
          if (editor2) {
            const topLine = Math.max(0, startPos.line - 6);
            const topPos = new vscode.Position(topLine, 0);
            editor2.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
            editor2.setDecorations(highlightDecoration, [new vscode.Range(startPos, endPos)]);
          }
        } else if (candidate.filePath && typeof candidate.rangeStart === 'number') {
          doc = await vscode.workspace.openTextDocument(candidate.filePath);
          await vscode.window.showTextDocument(doc, {preview: true});
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

        // Show a simple modal question to avoid showing internal labels like "unresolved"
        const choice = await vscode.window.showInformationMessage(`Is this call a valid invocation of ${fnName}?`, {modal: true}, 'Valid', 'Invalid');
        if (choice !== 'Valid') {
          // clear decorations and dispose
          const currentEditor = vscode.window.activeTextEditor;
          if (currentEditor) currentEditor.setDecorations(highlightDecoration, []);
          highlightDecoration.dispose();
          vscode.window.showInformationMessage('Operation cancelled — no changes made.');
          // restore original editor
          if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, {selection: originalSelection, preserveFocus: false});
          return;
        }

        // Show a 0.5s preview: temporarily replace call text in the CURRENT editor only (no file switching)
        try {
          if (candidate.argsText && candidate.argsText.length >= paramNames.length) {
            const props = paramNames.map((name, idx) => {
              const aText = candidate.argsText[idx] ? candidate.argsText[idx] : 'undefined';
              if (aText === name) return `${name}`;
              return `${name}:${aText}`;
            }).join(', ');
            const repl = `${candidate.exprText}({ ${props} })`;

            // open the candidate file and show it
            const visibleEditors = vscode.window.visibleTextEditors || [];
            let targetEditor = visibleEditors.find(e => e.document && e.document.fileName === candidate.filePath);
            if (!targetEditor) {
              try {
                const docToOpen = await vscode.workspace.openTextDocument(candidate.filePath);
                targetEditor = await vscode.window.showTextDocument(docToOpen, {preview: true});
              } catch (e) {
                // fallback to active editor if opening fails
                const activeEditor = vscode.window.activeTextEditor || originalEditor;
                if (activeEditor && activeEditor.document && activeEditor.document.fileName === candidate.filePath) targetEditor = activeEditor;
              }
            }

            if (targetEditor) {
              const doc = targetEditor.document;
              const startPos = doc.positionAt(candidate.start);
              const endPos = doc.positionAt(candidate.end);

              // preserve selection and visible ranges
              const priorSelections = targetEditor.selections.slice();
              const priorVisibleRanges = targetEditor.visibleRanges.slice();

              // clear pre-modal highlight and apply temporary edit (undoable)
              try {targetEditor.setDecorations(highlightDecoration, []);} catch (e) { }
              await targetEditor.edit(editBuilder => {editBuilder.replace(new vscode.Range(startPos, endPos), repl);});

              // highlight the temporary replacement
              const callRange = new vscode.Range(startPos, doc.positionAt(candidate.start + repl.length));
              targetEditor.setDecorations(highlightDecoration, [callRange]);

              // wait 5s
              await new Promise(r => setTimeout(r, 1000));

              // undo the temporary call edit and restore selections/visible ranges
              await vscode.commands.executeCommand('undo');
              try {targetEditor.setDecorations(highlightDecoration, []);} catch (e) { }
              try {targetEditor.selections = priorSelections;} catch (e) { }
              try {if (priorVisibleRanges && priorVisibleRanges.length) targetEditor.revealRange(priorVisibleRanges[0], vscode.TextEditorRevealType.Default);} catch (e) { }
            } else {
              // If we still don't have an editor (unexpected), show a small non-blocking preview message
              const previewText = repl;
              vscode.window.showInformationMessage(`Preview: ${previewText}`);
            }
          }
        } catch (e) {
          console.log('[params-to-object] preview error', e);
        }
      }

      // All fuzzy candidates approved — apply call-site edits via WorkspaceEdit, then modify the function AST
      const editAll = new vscode.WorkspaceEdit();
      const docsToSaveAll = new Map();
      const buildReplacementAll = (exprText, argsTextArr) => {
        const props = paramNames.map((name, idx) => {
          const aText = argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
          if (aText === name) return `${name}`;
          return `${name}:${aText}`;
        }).join(', ');
        return `${exprText}({ ${props} })`;
      };

      const allCandidates = [...confirmed, ...fuzzy];
      for (const c of allCandidates) {
        if (c.filePath && typeof c.start === 'number' && typeof c.end === 'number') {
          const uri = vscode.Uri.file(c.filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          docsToSaveAll.set(c.filePath, doc);
          const startP = doc.positionAt(c.start);
          const endP = doc.positionAt(c.end);
          editAll.replace(uri, new vscode.Range(startP, endP), buildReplacementAll(c.exprText, c.argsText));
        } else if (c.filePath && typeof c.rangeStart === 'number') {
          // .vue textual candidate
          const uri = vscode.Uri.file(c.filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          docsToSaveAll.set(c.filePath, doc);
          const full = doc.getText();
          const after = full.slice(c.rangeStart);
          const parenIndex = after.indexOf('(');
          const closeIndex = after.indexOf(')');
          if (parenIndex >= 0 && closeIndex > parenIndex) {
            const argsText = after.slice(parenIndex + 1, closeIndex);
            const argParts = argsText.split(',').map(s => s.trim()).filter(s => s.length);
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
      console.log('[params-to-object] applyEdit(all) result:', ok2);
      for (const [fp, d] of docsToSaveAll) {await d.save(); console.log('[params-to-object] saved', fp);}

      // now update the target function textually (after applying call-site edits)
      const paramTypes2 = params.map(p => {
        const tn = p.getTypeNode && p.getTypeNode();
        if (tn) return tn.getText();
        try {return p.getType().getText();} catch (e) {return 'any';}
      });
      const paramTypeText2 = `{ ${paramNames.map((n, i) => `${n}: ${paramTypes2[i] || 'any'}`).join('; ')} }`;
      try {
        const uri2 = vscode.Uri.file(sourceFile.getFilePath());
        const doc2 = await vscode.workspace.openTextDocument(uri2);
        const newFnText2 = transformFunctionText(originalFunctionText, paramNames, objectParamName, paramTypeText2);
        const full2 = doc2.getText();
        const idx2 = full2.indexOf(originalFunctionText);
        const startReplace2 = idx2 >= 0 ? doc2.positionAt(idx2) : doc2.positionAt(targetStart);
        const endReplace2 = idx2 >= 0 ? doc2.positionAt(idx2 + originalFunctionText.length) : doc2.positionAt(targetEnd);
        const edit3 = new vscode.WorkspaceEdit();
        edit3.replace(uri2, new vscode.Range(startReplace2, endReplace2), newFnText2);
        const ok3 = await vscode.workspace.applyEdit(edit3);
        console.log('[params-to-object] applied function text edit (all):', ok3);
        await doc2.save();
        console.log('[params-to-object] saved', uri2.fsPath);
      } catch (e) {
        console.log('[params-to-object] error applying function text edit (all)', e);
      }

      // dispose highlight decoration
      try {highlightDecoration.dispose();} catch (e) { }

      // restore original editor and cursor
      if (originalEditor && originalSelection) await vscode.window.showTextDocument(originalEditor.document, {selection: originalSelection, preserveFocus: false});
      vscode.window.showInformationMessage(`Converted ${confirmed.length + fuzzy.length} call(s) and updated function.`);
    } catch (err) {
      console.error(err);
      vscode.window.showErrorMessage('An error occurred: ' + (err.message || err));
    }
  });

  context.subscriptions.push(disposable);

  const checkDisposable = vscode.commands.registerCommand('paramsToObject.checkFunctions', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a file to check functions.');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const filePath = editor.document.fileName;

    try {
      const project = new Project({
        tsConfigFilePath: undefined,
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          moduleResolution: 'node'
        }
      });
      const glob = require('glob');
      const cfg = vscode.workspace.getConfiguration('paramsToObject');
      const includeStr = cfg.get('include') || '**/*.ts **/*.js';
      const excludeStr = cfg.get('exclude') || '**/node_modules/**';
      const includePatterns = includeStr.split(/\s+/).filter(Boolean);
      const excludePatterns = excludeStr.split(/\s+/).filter(Boolean);
      let jsTsFiles = [];
      for (const p of includePatterns) {
        try {jsTsFiles = jsTsFiles.concat(glob.sync(p, {cwd: workspaceRoot, ignore: excludePatterns, nodir: true}));} catch (e) { }
      }
      jsTsFiles = Array.from(new Set(jsTsFiles)).map(f => path.join(workspaceRoot, f));
      if (jsTsFiles.length > 0) project.addSourceFilesAtPaths(jsTsFiles);

      let sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = project.createSourceFile(filePath, editor.document.getText(), {overwrite: true});
      }

      const results = {works: [], notWorks: []};

      // collect function declarations
      const funcDecls = sourceFile.getFunctions();
      // collect var decls with arrow or function expressions
      const varDecls = sourceFile.getVariableDeclarations().filter(v => {
        const init = v.getInitializer && v.getInitializer();
        if (!init) return false;
        const k = init.getKind && init.getKind();
        return k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression;
      });

      const toCheck = [];
      for (const f of funcDecls) toCheck.push({node: f, name: f.getName ? f.getName() : null});
      for (const v of varDecls) {
        const init = v.getInitializer();
        toCheck.push({node: init, name: v.getName()});
      }

      for (const item of toCheck) {
        const fn = item.node;
        const name = item.name || '<anonymous>';
        const params = fn.getParameters ? fn.getParameters() : [];
        if (!params || params.length === 0) continue; // ignore functions with no params

        const funcSymbol = fn.getSymbol ? fn.getSymbol() : null;
        const resolvedFuncSym = funcSymbol && funcSymbol.getAliasedSymbol ? (funcSymbol.getAliasedSymbol() || funcSymbol) : funcSymbol;

        let ambiguous = false;
        let anyCalls = false;

        const files = project.getSourceFiles();
        for (const sf of files) {
          const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
          for (const call of calls) {
            const expr = call.getExpression();
            if (!expr) continue;
            const exprText = expr.getText();

            // quick textual filter: only consider calls that reference this name (identifier or property access ending with name)
            if (name === '<anonymous>') continue;
            if (!(exprText === name || exprText.endsWith('.' + name) || exprText.endsWith('[' + name + ']'))) continue;

            anyCalls = true;

            const calledSym = expr.getSymbol ? expr.getSymbol() : null;
            const resolvedCalled = calledSym && calledSym.getAliasedSymbol ? (calledSym.getAliasedSymbol() || calledSym) : calledSym;

            if (!resolvedFuncSym) {
              // cannot resolve function symbol in-editor -> ambiguous
              ambiguous = true;
              break;
            }

            if (!resolvedCalled) {
              ambiguous = true;
              break;
            }

            try {
              const fnName = resolvedFuncSym.getFullyQualifiedName ? resolvedFuncSym.getFullyQualifiedName() : resolvedFuncSym.getEscapedName && resolvedFuncSym.getEscapedName();
              const callName = resolvedCalled.getFullyQualifiedName ? resolvedCalled.getFullyQualifiedName() : resolvedCalled.getEscapedName && resolvedCalled.getEscapedName();
              if (fnName !== callName) {
                ambiguous = true;
                break;
              }
            } catch (e) {
              ambiguous = true;
              break;
            }
          }
          if (ambiguous) break;
        }

        if (ambiguous) results.notWorks.push({name, reason: anyCalls ? 'Ambiguous or unresolved calls found' : 'Function symbol unresolved'});
        else results.works.push({name, note: anyCalls ? 'All matching calls resolved' : 'No matching calls found'});
      }

      // Log results to console
      console.log('Params-to-Object check results for', filePath);
      console.log('Works:');
      for (const w of results.works) console.log('  -', w.name, '-', w.note);
      console.log('Not reliable:');
      for (const n of results.notWorks) console.log('  -', n.name, '-', n.reason);

      vscode.window.showInformationMessage('Checked functions — see developer console for details.');
    } catch (err) {
      console.error(err);
      vscode.window.showErrorMessage('An error occurred during check: ' + (err.message || err));
    }
  });

  context.subscriptions.push(checkDisposable);
}

function deactivate() { }

module.exports = {
  activate,
  deactivate
};
