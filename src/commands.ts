import * as vscode from 'vscode';
import * as path from 'path';
import { SyntaxKind } from 'ts-morph';
import glob from 'glob';
import * as fs from 'fs';
import * as utils from './utils';
import * as parse from './parse';
import * as functions from './functions';
import * as text from './text';
import * as dialogs from './dialogs';

const { log } = utils.getLog('cmds');

export async function convertCommandHandler(...args: any[]): Promise<void> {
  const context = utils.getWorkspaceContext();
  if (!context) return;

  const { editor, workspaceRoot, filePath } = context;

  const originalEditor = vscode.window.activeTextEditor;
  const originalSelection = originalEditor
    ? originalEditor.selection
    : undefined;
  const cursorOffset = editor.document.offsetAt(editor.selection.active);

  try {
    const project = await parse.createProjectFromConfig(workspaceRoot);

    // Ensure current file is in the project
    let sourceFile = project.getSourceFile(filePath);
    const wasNotInProject = !sourceFile;
    
    if (!sourceFile) {
      sourceFile = project.createSourceFile(
        filePath,
        editor.document.getText(),
        { overwrite: true }
      );
    }

    // Find function declaration or function expression at cursor
    const functionResult = functions.findTargetFunction(
      sourceFile,
      cursorOffset
    );
    if (!functionResult) {
      return;
    }

    const { targetFunction, targetVariableDeclaration, params, fnName } =
      functionResult;

    // If file wasn't in the project, warn the user
    if (wasNotInProject) {
      void vscode.window.showInformationMessage(
        `Objectify Params: File "${path.basename(filePath)}" not included in configured patterns. Current patterns: ${vscode.workspace.getConfiguration('objectifyParams').get('include') || '**/*.ts **/*.js'}`
      );
      return;
    }

    // Validate function can be converted
    const isValid = await functions.validateFunction(targetFunction, params);
    if (!isValid) {
      return;
    }

    // Extract parameter names (handling rest parameters)
    const paramInfo = await functions.extractParameterNames(params);
    if (!paramInfo) {
      return;
    }

    const { isRestParameter, paramNames, restTupleElements } = paramInfo;

    const targetStart = targetFunction.getStart();
    const targetEnd = targetFunction.getEnd();
    const originalFunctionText = targetFunction.getText();

    // Check if function already uses object destructuring pattern
    const hasObjectDestructuring =
      params.length === 1 &&
      params[0].getStructure &&
      (() => {
        try {
          const paramText = params[0].getText();
          return paramText.trim().startsWith('{');
        } catch {
          return false;
        }
      })();

    if (hasObjectDestructuring) {
      void vscode.window.showInformationMessage(
        'Objectify Params: This function already uses object destructuring parameters.'
      );
      return;
    }

    // Resolve target symbol
    const { resolvedTarget, canProceedWithoutSymbol } = parse.resolveSymbol(
      project,
      targetFunction,
      targetVariableDeclaration,
      fnName
    );

    if (!resolvedTarget && !canProceedWithoutSymbol) {
      void vscode.window.showInformationMessage(
        'Objectify Params: This function cannot be converted — cannot resolve symbol for the selected function.'
      );
      return;
    }

    // Collect all calls to the target function
    const callCollection = await parse.collectCalls(
      project,
      workspaceRoot,
      fnName,
      resolvedTarget,
      paramNames,
      originalEditor,
      originalSelection,
      filePath
    );

    if (callCollection.shouldAbort) {
      void vscode.window.showInformationMessage(
        'Objectify Params: Operation cancelled — no changes made.'
      );
      return;
    }

    const confirmed = callCollection.confirmed;
    let fuzzy = callCollection.fuzzy;
    const alreadyConvertedCount = callCollection.alreadyConvertedCount || 0;

    // Get show previews setting early as it's used in multiple places
    const cfg = vscode.workspace.getConfiguration('objectifyParams');
    const showPreviews = cfg.get('showPreviews') as boolean;
    const highlightDelay = (cfg.get('highlightDelay') as number) ?? 1000;

    if (confirmed.length === 0 && fuzzy.length === 0) {
      // Check if we found calls but they were all already converted
      if (alreadyConvertedCount > 0) {
        void vscode.window.showInformationMessage(
          `Objectify Params: All ${alreadyConvertedCount} call(s) already use object parameter syntax.`
        );
        return;
      }

      log('No calls found, converting function signature only');

      // Get types and build the converted signature
      const isTypeScript =
        sourceFile.getFilePath().endsWith('.ts') ||
        sourceFile.getFilePath().endsWith('.tsx');
      const paramTypeText = parse.extractParameterTypes(
        params,
        paramNames,
        sourceFile,
        isRestParameter,
        restTupleElements
      );

      const newFnText = text.transformFunctionText(
        originalFunctionText,
        params,
        paramNames,
        paramTypeText,
        isTypeScript,
        isRestParameter
      );

      // Show preview dialog if enabled
      let aborted = false;
      if (showPreviews) {
        aborted = await dialogs.showFunctionConversionDialog(
          filePath,
          targetStart,
          targetEnd,
          originalFunctionText,
          newFnText,
          originalEditor,
          originalSelection
        );
      }

      if (aborted) {
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const startPos = doc.positionAt(targetStart);
      const endPos = doc.positionAt(targetEnd);
      edit.replace(uri, new vscode.Range(startPos, endPos), newFnText);

      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        if (!showPreviews) {
          // Highlight the converted function signature
          try {
            await text.highlightConvertedFunction(
              filePath,
              targetStart,
              targetEnd,
              newFnText,
              originalEditor,
              originalSelection,
              highlightDelay
            );
          } catch (e) {
            log('error highlighting function', e);
          }
        }

        void vscode.window.showInformationMessage(
          `Objectify Params: Converted function but no calls were found.`
        );
      }
      return;
    }

    if (fuzzy.length === 0 && confirmed.length > 0) {
      let aborted = false;

      // Show function conversion dialog if previews are enabled
      if (showPreviews) {
        // Build the converted function text for preview
        const isTypeScript =
          sourceFile.getFilePath().endsWith('.ts') ||
          sourceFile.getFilePath().endsWith('.tsx');
        const paramTypeText = parse.extractParameterTypes(
          params,
          paramNames,
          sourceFile,
          isRestParameter,
          restTupleElements
        );
        const newFnText = text.transformFunctionText(
          originalFunctionText,
          params,
          paramNames,
          paramTypeText,
          isTypeScript,
          isRestParameter
        );

        aborted = await dialogs.showFunctionConversionDialog(
          filePath,
          targetStart,
          targetEnd,
          originalFunctionText,
          newFnText,
          originalEditor,
          originalSelection
        );

        if (aborted) {
          void vscode.window.showInformationMessage(
            'Objectify Params: Operation cancelled — no changes made.'
          );
          return;
        }

        // Now show confirmed call monitoring
        aborted = await dialogs.monitorConfirmedCalls(
          confirmed,
          confirmed.length,
          0,
          paramNames,
          highlightDelay,
          originalEditor,
          originalSelection
        );

        if (aborted) {
          void vscode.window.showInformationMessage(
            'Objectify Params: Operation cancelled — no changes made.'
          );
          return;
        }
      }

      const edit = new vscode.WorkspaceEdit();
      const docsToSave = new Map<string, vscode.TextDocument>();
      const replByFile = new Map<string, string>();
      const buildReplacement = (exprText: string, argsTextArr: string[]) => {
        const props = paramNames
          .map((name, idx) => {
            const aText =
              argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
            if (aText === name) return `${name}`;
            return `${name}:${aText}`;
          })
          .join(', ');
        return `${exprText}({ ${props} })`;
      };
      log('=== CONFIRMED-ONLY PATH: About to apply', confirmed.length, 'edits ===');
      
      // Sort edits by start position to check for overlaps
      const sortedConfirmed = [...confirmed].sort((a, b) => a.start - b.start);
      for (let i = 0; i < sortedConfirmed.length - 1; i++) {
        const curr = sortedConfirmed[i];
        const next = sortedConfirmed[i + 1];
        if (curr.end > next.start) {
          log('WARNING: OVERLAPPING EDITS DETECTED!');
          log('  Edit', i, ':', curr.filePath, 'offsets', curr.start, '-', curr.end);
          log('  Edit', i + 1, ':', next.filePath, 'offsets', next.start, '-', next.end);
          log('  Overlap:', curr.end - next.start, 'characters');
        }
      }
      
      // Build the function signature edit first (before document is modified)
      const paramTypeText = parse.extractParameterTypes(
        params,
        paramNames,
        sourceFile,
        isRestParameter,
        restTupleElements
      );
      const isTypeScript =
        sourceFile.getFilePath().endsWith('.ts') ||
        sourceFile.getFilePath().endsWith('.tsx');
      const newFnText = text.transformFunctionText(
        originalFunctionText,
        params,
        paramNames,
        paramTypeText,
        isTypeScript,
        isRestParameter
      );
      
      // Add function signature edit to the same WorkspaceEdit
      const funcUri = vscode.Uri.file(filePath);
      const funcDoc = await vscode.workspace.openTextDocument(funcUri);
      const funcStartPos = funcDoc.positionAt(targetStart);
      const funcEndPos = funcDoc.positionAt(targetEnd);
      edit.replace(funcUri, new vscode.Range(funcStartPos, funcEndPos), newFnText);
      log('Added function signature edit at offsets', targetStart, '-', targetEnd);
      
      // Add all call edits
      for (const c of confirmed) {
        const uri = vscode.Uri.file(c.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        docsToSave.set(c.filePath, doc);
        const startPos = doc.positionAt(c.start);
        const endPos = doc.positionAt(c.end);
        const orig = doc.getText().slice(c.start, c.end);
        const repl = buildReplacement(c.exprText, c.argsText);
        log('EDIT #' + (confirmed.indexOf(c) + 1), ':', c.filePath, 'offsets', c.start, '-', c.end);
        log('  exprText:', c.exprText);
        log('  argsText:', JSON.stringify(c.argsText));
        log('  ---orig---\n  ' + orig);
        log('  ---repl---\n  ' + repl);
        edit.replace(uri, new vscode.Range(startPos, endPos), repl);
      }
      const ok = await vscode.workspace.applyEdit(edit);
      log('applyEdit result:', ok);
      log(
        'modified',
        docsToSave.size,
        'file(s) - files are marked dirty, user can save manually'
      );

      // Calculate offset shift from edits in same file that came before the function
      let offsetShift = 0;
      
      // Use URI fsPath for consistent path comparison
      const targetFilePath = vscode.Uri.file(filePath).fsPath;
      
      for (const c of confirmed) {
        const callFilePath = vscode.Uri.file(c.filePath).fsPath;
        if (callFilePath === targetFilePath && c.end <= targetStart) {
          const orig = c.end - c.start;
          const repl = buildReplacement(c.exprText, c.argsText).length;
          offsetShift += repl - orig;
        }
      }

      // Highlight the converted function signature
      try {
        await text.highlightConvertedFunction(
          filePath,
          targetStart + offsetShift,
          targetEnd + offsetShift,
          newFnText,
          originalEditor,
          originalSelection,
          highlightDelay
        );
      } catch (e) {
        log('error highlighting function', e);
      }
      
      if (confirmed.length > 0) {
        void vscode.window.showInformationMessage(
          `Objectify Params: Converted ${confirmed.length} call(s) and updated function.`
        );
      } else {
        void vscode.window.showInformationMessage(
          'Objectify Params: Updated function signature (no calls were converted).'
        );
      }
      return;
    }

    const confirmedSet = new Set(
      confirmed.map((c) => `${c.filePath}:${c.start}:${c.end}`)
    );
    const initialFuzzyCount = fuzzy.length;
    fuzzy = fuzzy.filter((f) => {
      const key =
        f.start !== undefined && f.end !== undefined
          ? `${f.filePath}:${f.start}:${f.end}`
          : null;
      return !key || !confirmedSet.has(key);
    });
    if (fuzzy.length !== initialFuzzyCount)
      log(
        'removed',
        initialFuzzyCount - fuzzy.length,
        'fuzzy candidates that matched confirmed calls'
      );
    fuzzy.sort((a, b) => (b.score || 0) - (a.score || 0));

    let aborted = false;

    log(
      'showPreviews:',
      showPreviews,
      'confirmed.length:',
      confirmed.length
    );

    // Show function conversion dialog if previews are enabled
    if (showPreviews && (confirmed.length > 0 || fuzzy.length > 0)) {
      // Build the converted function text for preview
      const isTypeScript =
        sourceFile.getFilePath().endsWith('.ts') ||
        sourceFile.getFilePath().endsWith('.tsx');
      const paramTypeText = parse.extractParameterTypes(
        params,
        paramNames,
        sourceFile,
        isRestParameter,
        restTupleElements
      );
      const newFnText = text.transformFunctionText(
        originalFunctionText,
        params,
        paramNames,
        paramTypeText,
        isTypeScript,
        isRestParameter
      );

      aborted = await dialogs.showFunctionConversionDialog(
        filePath,
        targetStart,
        targetEnd,
        originalFunctionText,
        newFnText,
        originalEditor,
        originalSelection
      );

      if (aborted) {
        void vscode.window.showInformationMessage(
          'Objectify Params: Operation cancelled — no changes made.'
        );
        return;
      }
    }

    // Process fuzzy calls first, then confirmed calls (when monitoring is enabled)

    const totalCalls = confirmed.length + fuzzy.length;
    const totalFuzzy = fuzzy.length;
    let callIdx = 0; // Start fuzzy calls at index 1
    const acceptedFuzzy: typeof fuzzy = []; // Track which fuzzy calls were accepted
    for (const candidate of fuzzy) {
      callIdx++;

      // Review the fuzzy call with user
      const reviewResult = await dialogs.reviewFuzzyCall(
        candidate,
        callIdx,
        totalCalls,
        paramNames,
        highlightDelay
      );

      if (reviewResult === 'abort') {
        void vscode.window.showInformationMessage(
          'Objectify Params: Operation cancelled — no changes made.'
        );
        if (originalEditor && originalSelection) {
          await vscode.window.showTextDocument(originalEditor.document, {
            selection: originalSelection,
            preserveFocus: false,
          });
        }
        return;
      }

      if (reviewResult === 'skip') {
        continue;
      }

      // User chose to convert this fuzzy call
      acceptedFuzzy.push(candidate);

      // Show preview of the conversion
      await dialogs.showFuzzyConversionPreview(
        candidate,
        paramNames,
        highlightDelay,
        originalEditor
      );
    }

    // If previews enabled, show preview for confirmed calls AFTER fuzzy calls
    if (showPreviews && confirmed.length > 0 && !aborted) {
      log('Entering confirmed preview block');
      aborted = await dialogs.monitorConfirmedCalls(
        confirmed,
        totalCalls,
        fuzzy.length,
        paramNames,
        highlightDelay,
        originalEditor,
        originalSelection
      );

      if (aborted) {
        void vscode.window.showInformationMessage(
          'Objectify Params: Operation cancelled — no changes made.'
        );
        return;
      }
    }

    if (aborted) {
      log('Aborted after confirmed monitoring');
      void vscode.window.showInformationMessage(
        'Objectify Params: Operation cancelled — no changes made.'
      );
      if (originalEditor && originalSelection) {
        await vscode.window.showTextDocument(originalEditor.document, {
          selection: originalSelection,
          preserveFocus: false,
        });
      }
      return;
    }

    const editAll = new vscode.WorkspaceEdit();
    const docsToSaveAll = new Map<string, vscode.TextDocument>();
    const buildReplacementAll = (exprText: string, argsTextArr: string[]) => {
      const props = paramNames
        .map((name, idx) => {
          const aText =
            argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
          if (aText === name) return `${name}`;
          return `${name}:${aText}`;
        })
        .join(', ');
      return `${exprText}({ ${props} })`;
    };

    const allCandidates = [...confirmed, ...acceptedFuzzy];
    log(
      'allCandidates count:',
      allCandidates.length,
      '(confirmed:',
      confirmed.length,
      'acceptedFuzzy:',
      acceptedFuzzy.length,
      ')'
    );

    if (allCandidates.length === 0) {
      log('No candidates to convert after fuzzy review');
      void vscode.window.showInformationMessage(
        'Objectify Params: No calls were converted.'
      );
      if (originalEditor && originalSelection)
        await vscode.window.showTextDocument(originalEditor.document, {
          selection: originalSelection,
          preserveFocus: false,
        });
      return;
    }

    // Build function signature edit first (before applying any edits)
    const paramTypeText2 = parse.extractParameterTypes(
      params,
      paramNames,
      sourceFile,
      isRestParameter,
      restTupleElements
    );
    const isTypeScript2 =
      sourceFile.getFilePath().endsWith('.ts') ||
      sourceFile.getFilePath().endsWith('.tsx');
    const newFnText2 = text.transformFunctionText(
      originalFunctionText,
      params,
      paramNames,
      paramTypeText2,
      isTypeScript2,
      isRestParameter
    );
    
    // Add function signature edit to the WorkspaceEdit
    const funcUri = vscode.Uri.file(filePath);
    const funcDoc = await vscode.workspace.openTextDocument(funcUri);
    const funcStartPos = funcDoc.positionAt(targetStart);
    const funcEndPos = funcDoc.positionAt(targetEnd);
    editAll.replace(funcUri, new vscode.Range(funcStartPos, funcEndPos), newFnText2);
    log('Added function signature edit at offsets', targetStart, '-', targetEnd);

    const replAllMap = new Map<string, string>();
    log('=== MIXED PATH: About to apply', allCandidates.length, 'call edits ===');
    for (const c of allCandidates) {
      if (
        c.filePath &&
        typeof c.start === 'number' &&
        typeof c.end === 'number'
      ) {
        const uri = vscode.Uri.file(c.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        docsToSaveAll.set(c.filePath, doc);
        const startP = doc.positionAt(c.start);
        const endP = doc.positionAt(c.end);
        const orig = doc.getText().slice(c.start, c.end);
        const replAll = buildReplacementAll(c.exprText, c.argsText);
        log('EDIT #' + (allCandidates.indexOf(c) + 1), ':', c.filePath, 'offsets', c.start, '-', c.end);
        log('  exprText:', c.exprText);
        log('  argsText:', JSON.stringify(c.argsText));
        log('  ---orig---\n  ' + orig);
        log('  ---repl---\n  ' + replAll);
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
          const argParts = argsText
            .split(',')
            .map((s: string) => s.trim())
            .filter((s: string) => s.length);
          if (argParts.length === paramNames.length) {
            const props = paramNames
              .map((name, idx) => `${name}:${argParts[idx]}`)
              .join(', ');
            const replaced =
              after.slice(0, parenIndex + 1) +
              `{ ${props} }` +
              after.slice(closeIndex);
            const newFull = full.slice(0, c.rangeStart) + replaced;
            editAll.replace(
              uri,
              new vscode.Range(doc.positionAt(0), doc.positionAt(full.length)),
              newFull
            );
          }
        }
      }
    }

    const ok2 = await vscode.workspace.applyEdit(editAll);
    log('applyEdit(all) result:', ok2);
    log(
      'modified',
      docsToSaveAll.size,
      'file(s) - files are marked dirty, user can save manually'
    );

    void vscode.window.showInformationMessage(
      `Objectify Params: Converted ${
        confirmed.length + acceptedFuzzy.length
      } call(s) and updated function.`
    );
  } catch (err) {
    console.error(err);
    void vscode.window.showErrorMessage(
      'An error occurred: ' + (err.message || err)
    );
  }
}
