import * as vscode from 'vscode';
import { SyntaxKind, SourceFile } from 'ts-morph';
import * as utils from './utils';

const { log } = utils.getLog('func');

export interface FunctionDetectionResult {
  targetFunction: any;
  targetVariableDeclaration: any | null;
  params: any[];
  fnName: string | null;
}

/**
 * Find the function/method at the cursor position
 * Searches for:
 * - Regular function declarations
 * - Variable declarations with arrow/function expressions
 * - Class methods
 * - Object literal methods (e.g., Vue component methods)
 */
export function findTargetFunction(
  sourceFile: SourceFile,
  cursorOffset: number
): FunctionDetectionResult | null {
  let targetFunction: any = null;
  let targetVariableDeclaration: any = null;

  // Strategy: Find the INNERMOST function containing the cursor
  // We'll check all function types and keep the one with the smallest range
  let smallestRange = Infinity;

  // Helper to update target if this function is innermost
  const considerFunction = (func: any, varDecl: any = null) => {
    const start = func.getStart();
    const end = func.getEnd();
    if (start <= cursorOffset && cursorOffset <= end) {
      const range = end - start;
      if (range < smallestRange) {
        smallestRange = range;
        targetFunction = func;
        targetVariableDeclaration = varDecl;
      }
    }
  };

  // Check ALL descendants, not just top-level
  // This will find functions nested inside methods, arrow functions in variable declarations, etc.
  
  // First check VariableDeclarations that have arrow/function initializers
  const allVarDecls = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const varDecl of allVarDecls) {
    const init = varDecl.getInitializer && varDecl.getInitializer();
    if (!init) continue;
    const kind = init.getKind && init.getKind();
    const isFunction =
      kind === SyntaxKind.ArrowFunction ||
      kind === SyntaxKind.FunctionExpression;
    if (!isFunction) continue;
    
    const varStart = varDecl.getStart();
    const varEnd = varDecl.getEnd();
    
    // If cursor is anywhere in the variable declaration (including the name),
    // consider the initializer function but use the variable declaration's range
    if (varStart <= cursorOffset && cursorOffset <= varEnd) {
      const range = varEnd - varStart;
      if (range < smallestRange) {
        smallestRange = range;
        targetFunction = init;
        targetVariableDeclaration = varDecl;
      }
    }
  }
  
  // Check all ArrowFunctions
  const arrowFunctions = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
  for (const arrow of arrowFunctions) {
    // Find the variable declaration that contains this arrow function
    let varDecl = null;
    const parent = arrow.getParent();
    if (parent && parent.getKind && parent.getKind() === SyntaxKind.VariableDeclaration) {
      varDecl = parent;
    }
    considerFunction(arrow, varDecl);
  }
  
  // Check all FunctionExpressions
  const functionExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression);
  for (const funcExpr of functionExpressions) {
    let varDecl = null;
    const parent = funcExpr.getParent();
    if (parent && parent.getKind && parent.getKind() === SyntaxKind.VariableDeclaration) {
      varDecl = parent;
    }
    considerFunction(funcExpr, varDecl);
  }

  // Check all FunctionDeclarations
  const functionDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
  for (const funcDecl of functionDeclarations) {
    considerFunction(funcDecl);
  }

  // Check all MethodDeclarations
  const methodDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration);
  for (const method of methodDeclarations) {
    considerFunction(method);
  }

  if (!targetFunction) {
    void vscode.window.showInformationMessage(
      'Objectify Params: Not on a function.'
    );
    return null;
  }

  const params = targetFunction.getParameters();
  if (!params || params.length === 0) {
    void vscode.window.showInformationMessage(
      'Objectify Params: Function has zero parameters — nothing to convert.'
    );
    return null;
  }

  // Get function name
  let fnName = targetFunction.getName ? targetFunction.getName() : null;

  // If arrow function or function expression assigned to variable, get name from variable
  if (!fnName && targetVariableDeclaration) {
    fnName = targetVariableDeclaration.getName();
  }

  return {
    targetFunction,
    targetVariableDeclaration,
    params,
    fnName,
  };
}

/**
 * Validate that the function can be converted
 * Checks for:
 * - Parameter properties (TypeScript constructor params)
 * - Function overloads
 * Returns true if valid, false if cannot convert
 */
export async function validateFunction(
  targetFunction: any,
  params: any[]
): Promise<boolean> {
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
    return false;
  }

  // Check for TypeScript function overloads
  const hasOverloads =
    targetFunction.getOverloads && targetFunction.getOverloads().length > 0;
  if (hasOverloads) {
    await vscode.window.showWarningMessage(
      `Objectify Params\n\n⚠️ This function cannot be converted\n\n` +
        `This function uses TypeScript overload signatures.\n\n` +
        `Converting the implementation signature would break the overload signatures, ` +
        `which would need to be manually updated to match the new object parameter pattern.\n\n` +
        `All overload signatures must be updated before converting the implementation.`,
      { modal: true }
    );
    return false;
  }

  return true;
}

export interface RestParameterInfo {
  isRestParameter: boolean;
  paramNames: string[];
  restTupleElements: string[];
}

/**
 * Extract parameter names, handling rest parameters with tuple elements
 */
export async function extractParameterNames(
  params: any[]
): Promise<RestParameterInfo | null> {
  let paramNames: string[] = [];
  let isRestParameter = false;
  let restTupleElements: string[] = [];

  if (
    params.length === 1 &&
    params[0].isRestParameter &&
    params[0].isRestParameter()
  ) {
    isRestParameter = true;
    const restParam = params[0];
    const restParamName = restParam.getName();
    const typeNode = restParam.getTypeNode();

    // Try to extract tuple element names from type like: [cmd: string, val: any]
    if (typeNode) {
      const typeText = typeNode.getText();
      const tupleMatch = typeText.match(/\[([^\]]+)\]/);
      if (tupleMatch) {
        const elements = tupleMatch[1].split(',').map((e) => e.trim());
        restTupleElements = elements
          .map((e) => {
            const colonIndex = e.indexOf(':');
            return colonIndex > 0 ? e.substring(0, colonIndex).trim() : e;
          })
          .filter(Boolean);
      }
    }

    // Show appropriate dialog based on whether we have named tuple elements
    if (restTupleElements.length > 0) {
      paramNames = restTupleElements;

      const choice = await vscode.window.showWarningMessage(
        `Objectify Params\n\n⚠️ Rest parameter conversion\n\n` +
          `The rest parameter "...${restParamName}: [${restTupleElements.join(
            ', '
          )}]" will be converted to destructured parameters { ${paramNames.join(
            ', '
          )} }.\n\n` +
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
        void vscode.window.showInformationMessage(
          'Objectify Params: Operation cancelled — no changes made.'
        );
        return null;
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
      return null;
    }
  } else {
    paramNames = params.map((p: any) => p.getName());
  }

  return {
    isRestParameter,
    paramNames,
    restTupleElements,
  };
}
