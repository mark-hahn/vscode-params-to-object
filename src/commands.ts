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

function normalizeFsPath(p?: string): string | undefined {
  if (!p) return undefined;
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function splitInternalCalls(
  calls: any[],
  filePath: string,
  targetStart: number,
  targetEnd: number
): { internal: any[]; external: any[] } {
  const targetNormalized = normalizeFsPath(filePath);
  const internal: any[] = [];
  const external: any[] = [];
  for (const call of calls) {
    const callPathNormalized = normalizeFsPath(call.filePath);
    if (
      callPathNormalized &&
      targetNormalized &&
      callPathNormalized === targetNormalized &&
      typeof call.start === 'number' &&
      typeof call.end === 'number' &&
      call.start >= targetStart &&
      call.end <= targetEnd
    ) {
      internal.push(call);
    } else {
      external.push(call);
    }
  }
  return { internal, external };
}

function applyInternalCallReplacements(
  originalFnText: string,
  internalCalls: any[],
  targetStart: number,
  buildReplacement: (exprText: string, argsTextArr: string[] | null) => string
): string {
  if (!internalCalls.length) {
    return originalFnText;
  }
  let updated = originalFnText;
  const sorted = [...internalCalls].sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
  for (const call of sorted) {
    if (typeof call.start !== 'number' || typeof call.end !== 'number') {
      continue;
    }
    const relativeStart = call.start - targetStart;
    const relativeEnd = call.end - targetStart;
    if (
      relativeStart < 0 ||
      relativeEnd > updated.length ||
      relativeStart >= relativeEnd
    ) {
      log(
        'WARNING: Skipping internal call replacement due to invalid range',
        call.filePath,
        'range',
        relativeStart,
        '-',
        relativeEnd
      );
      continue;
    }
    const replacement = buildReplacement(call.exprText, call.argsText || []);
    updated =
      updated.slice(0, relativeStart) +
      replacement +
      updated.slice(relativeEnd);
  }
  return updated;
}

function detectObjectVariableDestructure(targetFunction: any): boolean {
  try {
    const params = targetFunction.getParameters
      ? targetFunction.getParameters()
      : [];
    if (!params || params.length !== 1) {
      return false;
    }
    const paramName = params[0].getName ? params[0].getName() : null;
    if (!paramName) {
      return false;
    }
    const isParamDestructured = (() => {
      try {
        const text = params[0].getText();
        return text.trim().startsWith('{');
      } catch {
        return false;
      }
    })();
    if (isParamDestructured) {
      return false;
    }
    const body = targetFunction.getBody ? targetFunction.getBody() : null;
    if (!body || typeof body.getStatements !== 'function') {
      return false;
    }
    const statements = body.getStatements();
    for (const stmt of statements) {
      if (!stmt || typeof stmt.getKind !== 'function') {
        continue;
      }
      if (stmt.getKind() !== SyntaxKind.VariableStatement) {
        continue;
      }
      const declarationList =
        typeof stmt.getDeclarationList === 'function'
          ? stmt.getDeclarationList()
          : null;
      if (!declarationList || typeof declarationList.getDeclarations !== 'function') {
        continue;
      }
      const declarations = declarationList.getDeclarations();
      if (!declarations || !declarations.length) {
        continue;
      }
      const decl = declarations[0];
      const nameNode = decl.getNameNode ? decl.getNameNode() : null;
      if (!nameNode || typeof nameNode.getKind !== 'function') {
        continue;
      }
      if (nameNode.getKind() !== SyntaxKind.ObjectBindingPattern) {
        continue;
      }
      const initializer = decl.getInitializer ? decl.getInitializer() : null;
      const initializerText = initializer?.getText?.().trim();
      if (!initializerText) {
        continue;
      }
      if (initializerText === paramName) {
        return true;
      }
    }
  } catch (err) {
    log('detectObjectVariableDestructure error', err);
  }
  return false;
}

export async function convertCommandHandler(...args: any[]): Promise<void> {
  const context = utils.getWorkspaceContext();
  if (!context) return;

  const { editor, workspaceRoot, filePath } = context;
  const workspaceRelative = vscode.workspace.asRelativePath(filePath, false);

  const includeInfo = utils.isFileIncludedByConfig(filePath, workspaceRoot);

  const showNotIncludedMessage = (): void => {
    void vscode.window.showInformationMessage(
      `Objectify Params: File "${workspaceRelative}" not included in configured patterns. include=${includeInfo.includeGlobs} exclude=${includeInfo.excludeGlobs}`
    );
  };

  if (!includeInfo.included) {
    showNotIncludedMessage();
    return;
  }

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

    const isTypeScriptFile =
      sourceFile.getFilePath().endsWith('.ts') ||
      sourceFile.getFilePath().endsWith('.tsx');

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

    const cfg = vscode.workspace.getConfiguration('objectifyParams');
    const showPreviews = cfg.get('showPreviews') as boolean;
    const highlightDelay = (cfg.get('highlightDelay') as number) ?? 1000;
    const objectVariableSetting = (cfg.get('objectVariable') as string) || '';
    const objectVariableName = objectVariableSetting.trim();
    const identifierRegex = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    if (objectVariableName && !identifierRegex.test(objectVariableName)) {
      void vscode.window.showErrorMessage(
        `Objectify Params: "${objectVariableName}" is not a valid variable name. Change it in settings.`
      );
      return;
    }
    const preserveTypesSetting = cfg.get('preserveTypes');
    const preserveTypes =
      typeof preserveTypesSetting === 'boolean' ? preserveTypesSetting : true;

    // If file wasn't in the project, warn the user
    if (wasNotInProject) {
      showNotIncludedMessage();
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

    const {
      isRestParameter,
      paramNames,
      restTupleElements,
      optionalParamNames,
    } = paramInfo;

    const targetStart = targetFunction.getStart();
    const targetEnd = targetFunction.getEnd();
    const originalFunctionText = targetFunction.getText();

    let highlightStart = targetStart;
    if (targetVariableDeclaration) {
      try {
        const nameNode =
          typeof targetVariableDeclaration.getNameNode === 'function'
            ? targetVariableDeclaration.getNameNode()
            : undefined;
        if (nameNode && typeof nameNode.getStart === 'function') {
          const nameStart = nameNode.getStart();
          if (typeof nameStart === 'number' && nameStart < targetStart) {
            highlightStart = nameStart;
          }
        }
      } catch (e) {
        // ignore errors; default highlight start is the function start
      }
    }

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

    const hasObjectVariableDestructure = detectObjectVariableDestructure(
      targetFunction
    );

    if (hasObjectDestructuring || hasObjectVariableDestructure) {
      void vscode.window.showInformationMessage(
        'Objectify Params: This function already uses object parameter destructuring.'
      );
      return;
    }

    if (objectVariableName) {
      const bodyNode =
        typeof targetFunction.getBody === 'function'
          ? targetFunction.getBody()
          : null;
      const bodyKind =
        bodyNode && typeof bodyNode.getKind === 'function'
          ? bodyNode.getKind()
          : null;
      if (bodyKind !== SyntaxKind.Block) {
        void vscode.window.showInformationMessage(
          'Objectify Params: Object Variable requires the function to use a block body (wrap arrow functions in braces).'
        );
        return;
      }
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
      filePath,
      targetFunction.getStart(),
      targetVariableDeclaration
        ? targetVariableDeclaration.getStart()
        : undefined
    );

    if (callCollection.shouldAbort) {
      void vscode.window.showInformationMessage(
        'Objectify Params: Operation cancelled — no changes made.'
      );
      return;
    }

    let confirmed = callCollection.confirmed;
    let fuzzy = callCollection.fuzzy;
    const alreadyConvertedCount = callCollection.alreadyConvertedCount || 0;

    const transformOptions = {
      objectVariableName,
      preserveTypes,
    };

    const applyFunctionTransform = (
      sourceFnText: string,
      paramTypeText: string
    ): string => {
      const transformed = text.transformFunctionText(
        sourceFnText,
        params,
        paramNames,
        paramTypeText,
        isTypeScriptFile,
        isRestParameter,
        transformOptions
      );
      if (objectVariableName) {
        return text.insertObjectVariableDestructureLine(
          transformed.text,
          transformed.destructuredParams,
          objectVariableName
        );
      }
      return transformed.text;
    };

    if (confirmed.length === 0 && fuzzy.length === 0) {
      // Check if we found calls but they were all already converted
      if (alreadyConvertedCount > 0) {
        void vscode.window.showInformationMessage(
          `Objectify Params: All ${alreadyConvertedCount} call(s) already use object parameter syntax.`
        );
        return;
      }

      log('No calls found, converting function signature only');

      const paramTypeText = parse.extractParameterTypes(
        params,
        paramNames,
        sourceFile,
        isRestParameter,
        restTupleElements
      );

      const newFnText = applyFunctionTransform(
        originalFunctionText,
        paramTypeText
      );

      let aborted = false;
      if (showPreviews) {
        aborted = await dialogs.showFunctionConversionDialog(
          filePath,
          targetStart,
          targetEnd,
          originalFunctionText,
          newFnText,
          originalEditor,
          originalSelection,
          highlightStart,
          Boolean(objectVariableName)
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
        try {
          await text.highlightConvertedFunction(
            filePath,
            targetStart,
            targetEnd,
            newFnText,
            originalEditor,
            originalSelection,
            highlightDelay,
            highlightStart,
            Boolean(objectVariableName)
          );
        } catch (e) {
          log('error highlighting function', e);
        }

        void vscode.window.showInformationMessage(
          'Objectify Params: Converted function but no calls were found.'
        );
      }
      return;
    }

    if (fuzzy.length === 0 && confirmed.length > 0) {
      const paramTypeText = parse.extractParameterTypes(
        params,
        paramNames,
        sourceFile,
        isRestParameter,
        restTupleElements
      );
      const buildReplacement = (
        exprText: string,
        argsTextArr: string[] | null
      ) =>
        text.buildCallReplacement(
          exprText,
          argsTextArr,
          paramNames,
          optionalParamNames
        );

      const { internal: internalCalls, external: externalCalls } =
        splitInternalCalls(confirmed, filePath, targetStart, targetEnd);
      const functionTextWithInternal = applyInternalCallReplacements(
        originalFunctionText,
        internalCalls,
        targetStart,
        buildReplacement
      );
      const convertedFunctionText = applyFunctionTransform(
        functionTextWithInternal,
        paramTypeText
      );

      let aborted = false;

      if (showPreviews) {
        aborted = await dialogs.showFunctionConversionDialog(
          filePath,
          targetStart,
          targetEnd,
          originalFunctionText,
          convertedFunctionText,
          originalEditor,
          originalSelection,
          highlightStart,
          Boolean(objectVariableName)
        );

        if (aborted) {
          void vscode.window.showInformationMessage(
            'Objectify Params: Operation cancelled — no changes made.'
          );
          return;
        }

        aborted = await dialogs.monitorConfirmedCalls(
          confirmed,
          confirmed.length,
          0,
          paramNames,
          optionalParamNames,
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
      log('=== CONFIRMED-ONLY PATH: About to apply', confirmed.length, 'edits ===');

      const sortedConfirmed = [...externalCalls].sort((a, b) => a.start - b.start);
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

      const funcUri = vscode.Uri.file(filePath);
      const funcDoc = await vscode.workspace.openTextDocument(funcUri);
      const funcStartPos = funcDoc.positionAt(targetStart);
      const funcEndPos = funcDoc.positionAt(targetEnd);
      edit.replace(funcUri, new vscode.Range(funcStartPos, funcEndPos), convertedFunctionText);
      log('Added function signature edit at offsets', targetStart, '-', targetEnd);

      for (const c of externalCalls) {
        const uri = vscode.Uri.file(c.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        docsToSave.set(c.filePath, doc);
        const startPos = doc.positionAt(c.start);
        const endPos = doc.positionAt(c.end);
        const orig = doc.getText().slice(c.start, c.end);
        const repl = buildReplacement(c.exprText, c.argsText);
        log('EDIT #' + (externalCalls.indexOf(c) + 1), ':', c.filePath, 'offsets', c.start, '-', c.end);
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

      let offsetShift = 0;
      const targetFilePath = vscode.Uri.file(filePath).fsPath;

      for (const c of externalCalls) {
        const callFilePath = vscode.Uri.file(c.filePath).fsPath;
        if (callFilePath === targetFilePath && c.end <= targetStart) {
          const orig = c.end - c.start;
          const repl = buildReplacement(c.exprText, c.argsText).length;
          offsetShift += repl - orig;
        }
      }

      try {
        await text.highlightConvertedFunction(
          filePath,
          targetStart + offsetShift,
          targetEnd + offsetShift,
          convertedFunctionText,
          originalEditor,
          originalSelection,
          highlightDelay,
          highlightStart + offsetShift,
          Boolean(objectVariableName)
        );
      } catch (e) {
        log('error highlighting function', e);
      }

      const totalConvertedCalls = externalCalls.length + internalCalls.length;
      if (totalConvertedCalls > 0) {
        void vscode.window.showInformationMessage(
          `Objectify Params: Converted ${totalConvertedCalls} call(s) and updated function.`
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
      const paramTypeText = parse.extractParameterTypes(
        params,
        paramNames,
        sourceFile,
        isRestParameter,
        restTupleElements
      );
      const newFnText = applyFunctionTransform(
        originalFunctionText,
        paramTypeText
      );

      aborted = await dialogs.showFunctionConversionDialog(
        filePath,
        targetStart,
        targetEnd,
        originalFunctionText,
        newFnText,
        originalEditor,
        originalSelection,
        highlightStart,
        Boolean(objectVariableName)
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
        optionalParamNames,
        highlightDelay,
        originalEditor,
        originalSelection
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
        optionalParamNames,
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
    const buildReplacementAll = (
      exprText: string,
      argsTextArr: string[] | null
    ) =>
      text.buildCallReplacement(
        exprText,
        argsTextArr,
        paramNames,
        optionalParamNames
      );

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
      log('No candidates to convert after fuzzy review - converting function signature only');
      
      // Build function signature edit
      const paramTypeText = parse.extractParameterTypes(
        params,
        paramNames,
        sourceFile,
        isRestParameter,
        restTupleElements
      );
      const newFnText = applyFunctionTransform(
        originalFunctionText,
        paramTypeText
      );

      const edit = new vscode.WorkspaceEdit();
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const startPos = doc.positionAt(targetStart);
      const endPos = doc.positionAt(targetEnd);
      edit.replace(uri, new vscode.Range(startPos, endPos), newFnText);

      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        // Highlight the converted function signature
        try {
          await text.highlightConvertedFunction(
            filePath,
            targetStart,
            targetEnd,
            newFnText,
            originalEditor,
            originalSelection,
            highlightDelay,
            highlightStart,
            Boolean(objectVariableName)
          );
        } catch (e) {
          log('error highlighting function', e);
        }

        void vscode.window.showInformationMessage(
          'Objectify Params: No calls were converted.'
        );
      }
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
    const newFnText2 = applyFunctionTransform(
      originalFunctionText,
      paramTypeText2
    );
    
    // Add function signature edit to the WorkspaceEdit
    const funcUri = vscode.Uri.file(filePath);
    const funcDoc = await vscode.workspace.openTextDocument(funcUri);
    const funcStartPos = funcDoc.positionAt(targetStart);
    const funcEndPos = funcDoc.positionAt(targetEnd);
    editAll.replace(funcUri, new vscode.Range(funcStartPos, funcEndPos), newFnText2);
    log('Added function signature edit at offsets', targetStart, '-', targetEnd);

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
        const templateResult = text.buildTemplateCallReplacement(
          doc.getText(),
          c.rangeStart,
          paramNames,
          optionalParamNames
        );
        if (templateResult) {
          const startPos = doc.positionAt(templateResult.start);
          const endPos = doc.positionAt(templateResult.end);
          editAll.replace(
            uri,
            new vscode.Range(startPos, endPos),
            templateResult.replacement
          );
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

    if (ok2) {
      try {
        await text.highlightConvertedFunction(
          filePath,
          targetStart,
          targetEnd,
          newFnText2,
          originalEditor,
          originalSelection,
          highlightDelay,
          highlightStart,
          Boolean(objectVariableName)
        );
      } catch (e) {
        log('error highlighting function after conversions', e);
      }
    }

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
