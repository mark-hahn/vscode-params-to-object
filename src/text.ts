import * as vscode from 'vscode';
import * as utils from './utils';

const { log } = utils.getLog('text');

export interface TransformFunctionOptions {
  objectVariableName?: string;
  preserveTypes?: boolean;
}

export interface TransformFunctionResult {
  text: string;
  destructuredParams: string;
}

/**
 * Transform function text to use object destructuring parameter
 */
export function transformFunctionText(
  fnText: string,
  params: any[],
  paramNames: string[],
  paramTypeText: string,
  isTypeScript: boolean,
  isRestParameter: boolean,
  options?: TransformFunctionOptions
): TransformFunctionResult {
  const open = fnText.indexOf('(');
  if (open < 0) {
    return {
      text: fnText,
      destructuredParams: '',
    };
  }
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

  const objectVar = options?.objectVariableName?.trim() || '';
  const preserveTypes = options?.preserveTypes !== false;
  const resolvedTypeText = !isTypeScript
    ? ''
    : preserveTypes && paramTypeText && paramTypeText.trim().length > 0
    ? paramTypeText
    : 'any';

  let newParams: string;
  if (objectVar) {
    newParams = isTypeScript ? `${objectVar}: ${resolvedTypeText}` : objectVar;
  } else {
    newParams = isTypeScript
      ? `{ ${paramsWithDefaults} }: ${resolvedTypeText}`
      : `{ ${paramsWithDefaults} }`;
  }

  const newFn = before + newParams + after;
  return {
    text: newFn,
    destructuredParams: paramsWithDefaults,
  };
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function getIndentForNextContent(text: string): string {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = line.match(/^(\s*)/);
    return match ? match[1] : '';
  }
  return '';
}

/**
 * Insert "let { ... } = objectVar" as the first line in the function body
 * when the object variable option is enabled.
 */
export function insertObjectVariableDestructureLine(
  fnText: string,
  destructuredParams: string,
  objectVariableName: string
): string {
  if (!destructuredParams.trim() || !objectVariableName.trim()) {
    return fnText;
  }

  const braceIndex = fnText.indexOf('{');
  if (braceIndex === -1) {
    return fnText;
  }

  const beforeBody = fnText.slice(0, braceIndex + 1);
  const afterBody = fnText.slice(braceIndex + 1);
  const eol = detectEol(fnText);

  const newlineIndex = afterBody.indexOf('\n');
  if (newlineIndex >= 0) {
    const beforeNextLine = afterBody.slice(0, newlineIndex + 1);
    const rest = afterBody.slice(newlineIndex + 1);
    const indent = getIndentForNextContent(rest);
    const destructureLine = `${indent}let { ${destructuredParams} } = ${objectVariableName};${eol}`;
    return `${beforeBody}${beforeNextLine}${destructureLine}${rest}`;
  }

  const indentMatch = afterBody.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const rest = afterBody.slice(indent.length);
  const destructureLine = `${eol}${indent}let { ${destructuredParams} } = ${objectVariableName};${eol}`;
  const rebuilt = `${beforeBody}${destructureLine}${indent}${rest}`;
  return rebuilt;
}

/**
 * Build replacement text for a call site
 */
function isUndefinedLiteral(argText: string | undefined): boolean {
  if (!argText) {
    return false;
  }
  const trimmed = argText.trim();
  return (
    trimmed.length === 0 ||
    trimmed === 'undefined' ||
    trimmed === 'void 0' ||
    trimmed === 'void0' ||
    trimmed === 'void(0)'
  );
}

export function buildCallReplacement(
  exprText: string,
  argsTextArr: string[] | null,
  paramNames: string[],
  optionalParamFlags: boolean[] = []
): string {
  const props: string[] = [];

  for (let i = 0; i < paramNames.length; i++) {
    const name = paramNames[i];
    const argText = argsTextArr && argsTextArr.length > i ? argsTextArr[i] : undefined;
    const argMissing = typeof argText === 'undefined';
    const argIsUndefinedLiteral = !argMissing && isUndefinedLiteral(argText);
    const isOptional = optionalParamFlags[i] === true;

    if (isOptional && (argMissing || argIsUndefinedLiteral)) {
      continue;
    }

    const emittedArg = argMissing ? 'undefined' : argText || 'undefined';
    const trimmedArg = emittedArg.trim();
    if (trimmedArg === name) {
      props.push(name);
    } else {
      props.push(`${name}:${emittedArg}`);
    }
  }

  return `${exprText}({ ${props.join(', ')} })`;
}

/**
 * Build replacement text for a template call (Vue/Svelte) using string manipulation
 * Returns the replacement text and the range to replace
 */
export function buildTemplateCallReplacement(
  fullText: string,
  rangeStart: number,
  paramNames: string[],
  optionalParamFlags: boolean[] = []
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
  
  if (argParts.length > paramNames.length) {
    return null;
  }
  
  const functionName = fullText.slice(rangeStart, rangeStart + parenIndex);
  const replacement = buildCallReplacement(
    functionName,
    argParts,
    paramNames,
    optionalParamFlags
  );
  
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
  buildReplacement: (exprText: string, argsText: string[]) => string,
  optionalParamFlags: boolean[] = []
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
      const templateResult = buildTemplateCallReplacement(
        doc.getText(),
        c.rangeStart,
        paramNames,
        optionalParamFlags
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

  const ok = await vscode.workspace.applyEdit(editAll);
  log('applyEdit result:', ok);
  log(
    'modified',
    docsToSaveAll.size,
    'file(s) - files are marked dirty, user can save manually'
  );

  return docsToSaveAll;
}

function findDestructureLineEnd(newFnText: string, braceIndex: number): number | null {
  const len = newFnText.length;
  let cursor = braceIndex + 1;

  const isWhitespace = (char: string | undefined): boolean => {
    if (!char) {
      return false;
    }
    return /\s/.test(char);
  };

  while (cursor < len && isWhitespace(newFnText[cursor])) {
    cursor++;
  }

  const keywords = ['let', 'const', 'var'];
  let matchedKeyword: string | undefined;
  for (const kw of keywords) {
    const nextChar = newFnText[cursor + kw.length];
    if (
      newFnText.startsWith(kw, cursor) &&
      (!nextChar || !/[A-Za-z0-9_$]/.test(nextChar))
    ) {
      matchedKeyword = kw;
      break;
    }
  }

  if (!matchedKeyword) {
    return null;
  }

  cursor += matchedKeyword.length;
  while (cursor < len && isWhitespace(newFnText[cursor])) {
    cursor++;
  }

  if (cursor >= len || newFnText[cursor] !== '{') {
    return null;
  }

  let bindingDepth = 0;
  while (cursor < len) {
    const char = newFnText[cursor];
    if (char === '{') {
      bindingDepth++;
    } else if (char === '}') {
      bindingDepth--;
      if (bindingDepth === 0) {
        cursor++;
        break;
      }
    }
    cursor++;
  }

  if (bindingDepth !== 0) {
    return null;
  }

  while (cursor < len && isWhitespace(newFnText[cursor])) {
    cursor++;
  }

  if (cursor >= len || newFnText[cursor] !== '=') {
    return null;
  }

  cursor++;
  const semicolonIndex = newFnText.indexOf(';', cursor);
  if (semicolonIndex === -1) {
    return null;
  }

  let endIndex = semicolonIndex + 1;
  while (
    endIndex < len &&
    (newFnText[endIndex] === '\r' || newFnText[endIndex] === '\n')
  ) {
    endIndex++;
  }

  return endIndex;
}

export function computeSignatureHighlightLength(
  newFnText: string,
  includeDestructureLine?: boolean
): number {
  let signatureLength = newFnText.length;
  let parenDepth = 0;
  let foundParamStart = false;
  let braceIndex = -1;

  for (let i = 0; i < newFnText.length; i++) {
    const char = newFnText[i];
    if (char === '(') {
      parenDepth++;
      foundParamStart = true;
    } else if (char === ')') {
      parenDepth--;
    } else if (char === '{' && foundParamStart && parenDepth === 0) {
      braceIndex = i;
      signatureLength = i;
      break;
    }
  }

  if (includeDestructureLine && braceIndex >= 0) {
    const destructureEnd = findDestructureLineEnd(newFnText, braceIndex);
    if (typeof destructureEnd === 'number') {
      signatureLength = Math.max(signatureLength, destructureEnd);
    }
  }

  return signatureLength;
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
  highlightDelay: number,
  highlightStart?: number,
  includeDestructureLine?: boolean
): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  
  // Calculate signature end (optionally include the first destructuring line)
  const signatureLength = computeSignatureHighlightLength(
    newFnText,
    includeDestructureLine
  );

  const highlightRangeStart = Math.min(
    typeof highlightStart === 'number' ? highlightStart : targetStart,
    targetStart
  );
  const startPos = doc.positionAt(highlightRangeStart);
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
  convertedCount: number,
  includeDestructureLine?: boolean
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
  const signatureEnd = computeSignatureHighlightLength(
    newFnText,
    includeDestructureLine
  );

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
