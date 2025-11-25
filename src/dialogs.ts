import * as vscode from 'vscode';
import * as utils from './utils';

const { log } = utils.getLog('dlgs');

/**
 * Helper to build replacement text for a call
 */
function buildCallReplacement(
  exprText: string,
  argsTextArr: string[],
  paramNames: string[]
): string {
  const props = paramNames
    .map((name, idx) => {
      const aText =
        argsTextArr && argsTextArr[idx] ? argsTextArr[idx] : 'undefined';
      if (aText === name) return `${name}`;
      return `${name}:${aText}`;
    })
    .join(', ');
  return `${exprText}({ ${props} })`;
}

/**
 * Monitor and show confirmed calls with preview
 * Returns true if aborted, false otherwise
 */
export async function monitorConfirmedCalls(
  confirmed: any[],
  totalCalls: number,
  startIdx: number,
  paramNames: string[],
  highlightDelay: number,
  originalEditor: vscode.TextEditor | undefined,
  originalSelection: vscode.Selection | undefined
): Promise<boolean> {
  const greenDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(100,255,100,0.3)',
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
        editor.revealRange(
          new vscode.Range(topPos, topPos),
          vscode.TextEditorRevealType.AtTop
        );

        const repl = buildCallReplacement(c.exprText, c.argsText, paramNames);

        // Apply the edit temporarily to show preview
        const priorSelections = editor.selections.slice();
        const priorVisibleRanges = editor.visibleRanges.slice();

        await editor.edit((editBuilder) => {
          editBuilder.replace(new vscode.Range(startPos, endPos), repl);
        });

        // Show green highlight on the converted code
        const newEndPos = doc.positionAt(c.start + repl.length);
        editor.setDecorations(greenDecoration, [
          new vscode.Range(startPos, newEndPos),
        ]);

        // Show dialog while preview is visible
        const choice = await vscode.window.showInformationMessage(
          `Objectify Params: Processed function call ${callIdx} of ${totalCalls}.`,
          { modal: true },
          'Next'
        );

        // Undo the preview edit
        await vscode.commands.executeCommand('undo');

        // Clear green highlight after undo
        editor.setDecorations(greenDecoration, []);

        // Restore editor state
        try {
          editor.selections = priorSelections;
        } catch (e) {}
        try {
          if (priorVisibleRanges && priorVisibleRanges.length)
            editor.revealRange(
              priorVisibleRanges[0],
              vscode.TextEditorRevealType.Default
            );
        } catch (e) {}

        if (choice === undefined) {
          greenDecoration.dispose();
          void vscode.window.showInformationMessage(
            'Objectify Params: Operation cancelled — no changes made.'
          );
          if (originalEditor && originalSelection) {
            await vscode.window.showTextDocument(originalEditor.document, {
              selection: originalSelection,
              preserveFocus: false,
            });
          }
          return true; // aborted
        }

        // Continue to next call
      }
    } catch (e) {
      log('Error showing monitor preview:', e);
    }
  }

  greenDecoration.dispose();

  return false; // not aborted
}

/**
 * Show name collision error dialog
 * Returns true (indicating abort is needed)
 */
export async function showNameCollisionDialog(
  candidate: any,
  originalEditor: vscode.TextEditor | undefined,
  originalSelection: vscode.Selection | undefined
): Promise<boolean> {
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
      tempEditor.revealRange(
        new vscode.Range(topPos, topPos),
        vscode.TextEditorRevealType.AtTop
      );

      const collisionDecoration =
        vscode.window.createTextEditorDecorationType({
          backgroundColor: 'rgba(255,100,100,0.3)',
          border: '1px solid rgba(255,100,100,0.8)',
        });
      tempEditor.setDecorations(collisionDecoration, [
        new vscode.Range(callStartPos, callEndPos),
      ]);

      await vscode.window.showWarningMessage(
        `Objectify Params: Cannot convert function.\n\nName collision detected. A call to a different function with the same name was found. Operation will be cancelled.`,
        { modal: true },
        'OK'
      );

      collisionDecoration.dispose();

      // Restore original editor
      if (originalEditor && originalSelection) {
        await vscode.window.showTextDocument(originalEditor.document, {
          selection: originalSelection,
          preserveFocus: false,
        });
      }

      log('Aborting conversion due to name collision');
      return true;
    }
  } catch (e) {
    log('Error showing collision warning', e);
  }

  return true;
}

/**
 * Review a fuzzy call and ask user whether to convert it
 * Returns: 'convert', 'skip', or 'abort'
 */
export async function reviewFuzzyCall(
  candidate: any,
  callIdx: number,
  totalCalls: number,
  paramNames: string[],
  highlightDelay: number
): Promise<'convert' | 'skip' | 'abort'> {
  let doc: vscode.TextDocument | undefined;
  let startPos: vscode.Position | undefined;
  let endPos: vscode.Position | undefined;

  const highlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255,255,0,0.4)',
  });
  const greenDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(100,255,100,0.3)',
  });
  const redDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255,100,100,0.3)',
  });

  try {
    if (
      candidate.filePath &&
      typeof candidate.start === 'number' &&
      typeof candidate.end === 'number'
    ) {
      doc = await vscode.workspace.openTextDocument(candidate.filePath);
      startPos = doc.positionAt(candidate.start);
      endPos = doc.positionAt(candidate.end);
      await vscode.window.showTextDocument(doc, { preview: true });
      const editor2 = vscode.window.activeTextEditor;
      if (editor2) {
        const topLine = Math.max(0, startPos.line - 6);
        const topPos = new vscode.Position(topLine, 0);
        editor2.revealRange(
          new vscode.Range(topPos, topPos),
          vscode.TextEditorRevealType.AtTop
        );
        // Show yellow (original) since we don't know user's choice yet
        editor2.setDecorations(highlightDecoration, [
          new vscode.Range(startPos, endPos),
        ]);
      }
    } else if (
      candidate.filePath &&
      typeof candidate.rangeStart === 'number'
    ) {
      doc = await vscode.workspace.openTextDocument(candidate.filePath);
      await vscode.window.showTextDocument(doc, { preview: true });
      const editor2 = vscode.window.activeTextEditor;
      if (editor2) {
        startPos = doc.positionAt(candidate.rangeStart);
        endPos = doc.positionAt(
          candidate.rangeEnd || candidate.rangeStart + 1
        );
        const topLine = Math.max(0, startPos.line - 6);
        const topPos = new vscode.Position(topLine, 0);
        editor2.revealRange(
          new vscode.Range(topPos, topPos),
          vscode.TextEditorRevealType.AtTop
        );
        // Show yellow (original) since we don't know user's choice yet
        editor2.setDecorations(highlightDecoration, [
          new vscode.Range(startPos, endPos),
        ]);
      }
    }

    // Check if converting this call would lose arguments
    const argCount = candidate.argsText ? candidate.argsText.length : 0;
    const willLoseArgs = argCount > paramNames.length;

    // Build message based on reason
    let message = `Objectify Params: Processing function call ${callIdx} of ${totalCalls}.\n\n`;

    if (willLoseArgs || candidate.reason === 'too-many-args') {
      message += `This call has more arguments than the function has parameters and data would be lost. Should it be converted?`;
    } else {
      message += `Is this a call to the correct function? Should it be converted?`;
    }

    const choice = await vscode.window.showInformationMessage(
      message,
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
      return 'abort';
    }

    // Change color based on choice
    const currentEditor = vscode.window.activeTextEditor;
    if (currentEditor && startPos && endPos) {
      // Clear previous decorations
      currentEditor.setDecorations(highlightDecoration, []);
      currentEditor.setDecorations(greenDecoration, []);
      currentEditor.setDecorations(redDecoration, []);

      // Show post-dialog preview if delay > 0
      if (highlightDelay > 0) {
        if (choice === 'Convert') {
          // Green for will convert
          currentEditor.setDecorations(greenDecoration, [
            new vscode.Range(startPos, endPos),
          ]);
        } else {
          // Red for won't convert
          currentEditor.setDecorations(redDecoration, [
            new vscode.Range(startPos, endPos),
          ]);
        }
        await new Promise((r) => setTimeout(r, highlightDelay));
      }
    }

    // Clear decorations
    if (currentEditor) {
      currentEditor.setDecorations(highlightDecoration, []);
      currentEditor.setDecorations(greenDecoration, []);
      currentEditor.setDecorations(redDecoration, []);
    }

    highlightDecoration.dispose();
    greenDecoration.dispose();
    redDecoration.dispose();

    return choice === 'Convert' ? 'convert' : 'skip';
  } finally {
    // Ensure decorations are disposed
    try {
      highlightDecoration.dispose();
      greenDecoration.dispose();
      redDecoration.dispose();
    } catch (e) {}
  }
}

/**
 * Show preview of fuzzy call conversion with undo
 */
export async function showFuzzyConversionPreview(
  candidate: any,
  paramNames: string[],
  highlightDelay: number,
  originalEditor: vscode.TextEditor | undefined
): Promise<void> {
  if (!candidate.argsText || candidate.argsText.length < paramNames.length) {
    return;
  }

  const repl = buildCallReplacement(
    candidate.exprText,
    candidate.argsText,
    paramNames
  );

  // Only show preview if highlightDelay > 0
  if (highlightDelay <= 0) {
    return;
  }

  const greenDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(100,255,100,0.3)',
  });

  try {
    const visibleEditors = vscode.window.visibleTextEditors || [];
    let targetEditor = visibleEditors.find(
      (e) => e.document && e.document.fileName === candidate.filePath
    );
    if (!targetEditor) {
      try {
        const docToOpen = await vscode.workspace.openTextDocument(
          candidate.filePath
        );
        targetEditor = await vscode.window.showTextDocument(docToOpen, {
          preview: true,
        });
      } catch (e) {
        const activeEditor =
          vscode.window.activeTextEditor || originalEditor;
        if (
          activeEditor &&
          activeEditor.document &&
          activeEditor.document.fileName === candidate.filePath
        )
          targetEditor = activeEditor;
      }
    }

    if (targetEditor) {
      const doc = targetEditor.document;
      const startP = doc.positionAt(candidate.start);
      const endP = doc.positionAt(candidate.end);
      const priorSelections = targetEditor.selections.slice();
      const priorVisibleRanges = targetEditor.visibleRanges.slice();

      await targetEditor.edit((editBuilder) => {
        editBuilder.replace(new vscode.Range(startP, endP), repl);
      });

      const callRange = new vscode.Range(
        startP,
        doc.positionAt(candidate.start + repl.length)
      );
      targetEditor.setDecorations(greenDecoration, [callRange]);
      await new Promise((r) => setTimeout(r, highlightDelay));
      await vscode.commands.executeCommand('undo');

      targetEditor.setDecorations(greenDecoration, []);

      try {
        targetEditor.selections = priorSelections;
      } catch (e) {}
      try {
        if (priorVisibleRanges && priorVisibleRanges.length)
          targetEditor.revealRange(
            priorVisibleRanges[0],
            vscode.TextEditorRevealType.Default
          );
      } catch (e) {}
    } else {
      void vscode.window.showInformationMessage(`Preview: ${repl}`);
    }
  } catch (e) {
    log('preview error', e);
  } finally {
    greenDecoration.dispose();
  }
}
