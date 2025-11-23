import * as vscode from 'vscode';
import * as path from 'path';
import { Project, SyntaxKind } from 'ts-morph';
import glob from 'glob';
import * as fs from 'fs';
import { convertCommandHandler } from './commands';

export function activate(context: vscode.ExtensionContext) {
  console.log('Params-to-Object activated');

  const disposable = vscode.commands.registerCommand('paramsToObject.convert', convertCommandHandler);
  context.subscriptions.push(disposable);

  const checkDisposable = vscode.commands.registerCommand('paramsToObject.checkFunctions', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage('Open a file to check functions.');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const filePath = editor.document.fileName;
    const containingFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const workspaceRoot = containingFolder ? containingFolder.uri.fsPath : workspaceFolders[0].uri.fsPath;
    console.log('[params-to-object] activeFile:', filePath);
    console.log('[params-to-object] chosen workspaceRoot:', workspaceRoot);

    try {
      const project = new Project({ tsConfigFilePath: undefined, compilerOptions: { allowJs: true, checkJs: false } });
      const cfg = vscode.workspace.getConfiguration('paramsToObject');
      const includeStr = (cfg.get('include') as string) || '**/*.ts **/*.js';
      const excludeStr = (cfg.get('exclude') as string) || '**/node_modules/**';
      const includePatterns = includeStr.split(/\s+/).filter(Boolean);
      const excludePatterns = excludeStr.split(/\s+/).filter(Boolean);
      let jsTsFiles: string[] = [];
      for (const p of includePatterns) {
        try { jsTsFiles = jsTsFiles.concat(glob.sync(p, { cwd: workspaceRoot, ignore: excludePatterns, nodir: true })); } catch (e) { }
      }
      jsTsFiles = Array.from(new Set(jsTsFiles)).map(f => path.join(workspaceRoot, f));
      if (jsTsFiles.length > 0) project.addSourceFilesAtPaths(jsTsFiles);

      let sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = project.createSourceFile(filePath, editor.document.getText(), { overwrite: true });
      }

      const results: any = { works: [], notWorks: [] };

      const funcDecls = sourceFile.getFunctions();
      const varDecls = sourceFile.getVariableDeclarations().filter((v: any) => {
        const init = v.getInitializer && v.getInitializer();
        if (!init) return false;
        const k = init.getKind && init.getKind();
        return k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression;
      });

      const toCheck: any[] = [];
      for (const f of funcDecls) toCheck.push({ node: f, name: f.getName ? f.getName() : null });
      for (const v of varDecls) { const init = v.getInitializer(); toCheck.push({ node: init, name: v.getName() }); }

      for (const item of toCheck) {
        const fn = item.node;
        const name = item.name || '<anonymous>';
        const params = fn.getParameters ? fn.getParameters() : [];
        if (!params || params.length === 0) continue;

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
            if (name === '<anonymous>') continue;
            if (!(exprText === name || exprText.endsWith('.' + name) || exprText.endsWith('[' + name + ']'))) continue;
            anyCalls = true;
            const calledSym = expr.getSymbol ? expr.getSymbol() : null;
            const resolvedCalled = calledSym && calledSym.getAliasedSymbol ? (calledSym.getAliasedSymbol() || calledSym) : calledSym;
            if (!resolvedFuncSym) { ambiguous = true; break; }
            if (!resolvedCalled) { ambiguous = true; break; }
            try {
              const fnName = resolvedFuncSym.getFullyQualifiedName ? resolvedFuncSym.getFullyQualifiedName() : resolvedFuncSym.getEscapedName && resolvedFuncSym.getEscapedName();
              const callName = resolvedCalled.getFullyQualifiedName ? resolvedCalled.getFullyQualifiedName() : resolvedCalled.getEscapedName && resolvedCalled.getEscapedName();
              if (fnName !== callName) { ambiguous = true; break; }
            } catch (e) { ambiguous = true; break; }
          }
          if (ambiguous) break;
        }

        if (ambiguous) results.notWorks.push({ name, reason: anyCalls ? 'Ambiguous or unresolved calls found' : 'Function symbol unresolved' });
        else results.works.push({ name, note: anyCalls ? 'All matching calls resolved' : 'No matching calls found' });
      }

      console.log('Params-to-Object check results for', filePath);
      console.log('Works:');
      for (const w of results.works) console.log('  -', w.name, '-', w.note);
      console.log('Not reliable:');
      for (const n of results.notWorks) console.log('  -', n.name, '-', n.reason);

      void vscode.window.showInformationMessage('Checked functions — see developer console for details.');
    } catch (err) {
      console.error(err);
      void vscode.window.showErrorMessage('An error occurred during check: ' + (err.message || err));
    }
  });

  context.subscriptions.push(checkDisposable);
}

export function deactivate() { }

