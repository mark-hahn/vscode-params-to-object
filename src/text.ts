import * as vscode from 'vscode';
import * as utils from './utils';

const { log } = utils.getLog('text');

/**
 * Transform function text to use object destructuring parameter
 */
export function transformFunctionText(
  fnText: string,
  params: any[],
  paramNames: string[],
  paramTypeText: string,
  isTypeScript: boolean,
  isRestParameter: boolean
): string {
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
    paramsWithDefaults = params
      .map((p: any) => {
        const name = p.getName();
        const hasDefault = p.hasInitializer && p.hasInitializer();
        if (hasDefault) {
          const initializer = p.getInitializer();
          const defaultValue = initializer ? initializer.getText() : undefined;
          return defaultValue ? `${name} = ${defaultValue}` : name;
        }
        return name;
      })
      .join(', ');
  }

  const newParams = isTypeScript
    ? `{ ${paramsWithDefaults} }: ${paramTypeText}`
    : `{ ${paramsWithDefaults} }`;
  const newFn = before + newParams + after;
  return newFn;
}

/**
 * Build replacement text for a call site
 */
export function buildCallReplacement(
  exprText: string,
  argsTextArr: string[],
  paramNames: string[]
): string {
  const props = paramNames
    .map((name, idx) => {
      const aText =
        argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
      // Use shorthand if argument is exactly the same identifier
      if (aText === name || aText.trim() === name) return `${name}`;
      return `${name}:${aText}`;
    })
    .join(', ');
  return `${exprText}({ ${props} })`;
}

/**
 * Build replacement text for a template call (Vue/Svelte) using string manipulation
 * Returns the replacement text and the range to replace
 */
export function buildTemplateCallReplacement(
  fullText: string,
  rangeStart: number,
  paramNames: string[]
): { replacement: string; start: number; end: number } | null {
  const after = fullText.slice(rangeStart);
  const parenIndex = after.indexOf('(');
  const closeIndex = after.indexOf(')');
  
  if (parenIndex < 0 || closeIndex <= parenIndex) {
    return null;
  }
  
  const argsText = after.slice(parenIndex + 1, closeIndex);
  const argParts = argsText
    .split(',')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length);
  
  if (argParts.length !== paramNames.length) {
    return null;
  }
  
  const props = paramNames
    .map((name, idx) => {
      const arg = argParts[idx];
      // Use shorthand if argument is exactly the same identifier
      if (arg === name || arg.trim() === name) return `${name}`;
      return `${name}:${arg}`;
    })
    .join(', ');
  
  const functionName = fullText.slice(rangeStart, rangeStart + parenIndex);
  const replacement = `${functionName}({ ${props} })`;
  
  return {
    replacement,
    start: rangeStart,
    end: rangeStart + closeIndex + 1
  };
}

/**
 * Apply conversion edits to all confirmed and fuzzy-accepted calls
 */
export async function applyCallEdits(
  allCandidates: any[],
  paramNames: string[],
  buildReplacement: (exprText: string, argsText: string[]) => string
): Promise<Map<string, vscode.TextDocument>> {
  const editAll = new vscode.WorkspaceEdit();
  const docsToSaveAll = new Map<string, vscode.TextDocument>();

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
      const replAll = buildReplacement(c.exprText, c.argsText);
      log('scheduling replace in', c.filePath, 'range', c.start, c.end);
      editAll.replace(uri, new vscode.Range(startP, endP), replAll);
    } else if (c.filePath && typeof c.rangeStart === 'number') {
      // Handle template calls (rangeStart/rangeEnd instead of start/end)
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

  const ok = await vscode.workspace.applyEdit(editAll);
  log('applyEdit result:', ok);
  log(
    'modified',
    docsToSaveAll.size,
    'file(s) - files are marked dirty, user can save manually'
  );

  return docsToSaveAll;
}

/**
 * Apply function signature edit and highlight the changed signature
 */
export async function highlightConvertedFunction(
  filePath: string,
  targetStart: number,
  targetEnd: number,
  newFnText: string,
  originalEditor: vscode.TextEditor | undefined,
  originalSelection: vscode.Selection | undefined,
  highlightDelay: number
): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  
  // Calculate signature end (find the last brace on the first line for function body)
  // The parameter list may contain { } for object destructuring
  let signatureLength = newFnText.length;
  const lines = newFnText.split('\n');
  if (lines.length > 0) {
    const firstLine = lines[0];
    const lastBraceIdx = firstLine.lastIndexOf('{');
    if (lastBraceIdx >= 0) {
      signatureLength = lastBraceIdx;
    }
  }

  const startPos = doc.positionAt(targetStart);
  const endPos = doc.positionAt(targetStart + signatureLength);

  if (highlightDelay > 0) {
    await vscode.window.showTextDocument(doc, { preview: false });
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const flashDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(100,255,100,0.3)',
        border: '1px solid rgba(100,255,100,0.8)',
      });

      editor.setDecorations(flashDecoration, [
        new vscode.Range(startPos, endPos),
      ]);

      await new Promise((resolve) => setTimeout(resolve, highlightDelay));
      flashDecoration.dispose();
    }
  }

  // Restore original editor
  if (originalEditor && originalSelection) {
    await vscode.window.showTextDocument(originalEditor.document, {
      selection: originalSelection,
      preserveFocus: false,
    });
  }
}

export async function applyFunctionEditAndHighlight(
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
  const filePath = sourceFile.getFilePath();
  log('=== CONVERTING FUNCTION SIGNATURE ===');
  log('  file:', filePath);
  log('  offsets:', targetStart, '-', targetEnd);
  log('  ---original---\n  ' + originalFunctionText);
  log('  ---new---\n  ' + newFnText);
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const full = doc.getText();
  const idx = full.indexOf(originalFunctionText);
  const startPosReplace =
    idx >= 0 ? doc.positionAt(idx) : doc.positionAt(targetStart);
  const endPosReplace =
    idx >= 0
      ? doc.positionAt(idx + originalFunctionText.length)
      : doc.positionAt(targetEnd);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(startPosReplace, endPosReplace),
    newFnText
  );
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

  const newSignatureEndPos =
    idx >= 0
      ? doc.positionAt(idx + signatureEnd)
      : doc.positionAt(targetStart + signatureEnd);

  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Selection(startPosReplace, newSignatureEndPos),
  });

  const editor = vscode.window.activeTextEditor;
  if (editor && highlightDelay > 0) {
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(100,255,100,0.3)',
    });
    editor.setDecorations(decoration, [
      new vscode.Range(startPosReplace, newSignatureEndPos),
    ]);

    setTimeout(() => {
      decoration.dispose();
      if (originalEditor && originalSelection) {
        void vscode.window.showTextDocument(originalEditor.document, {
          selection: originalSelection,
          preserveFocus: false,
        });
      }
    }, highlightDelay);
  } else if (originalEditor && originalSelection) {
    setTimeout(() => {
      void vscode.window.showTextDocument(originalEditor.document, {
        selection: originalSelection,
        preserveFocus: false,
      });
    }, 100);
  }
}
