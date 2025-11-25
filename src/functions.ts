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

  // Check regular function declarations
  const functions = sourceFile.getFunctions();
  for (const f of functions) {
    if (f.getStart() <= cursorOffset && cursorOffset <= f.getEnd()) {
      targetFunction = f;
      break;
    }
  }

  // Check variable declarations for arrow or function expressions
  if (!targetFunction) {
    const vars = sourceFile.getVariableDeclarations();
    for (const v of vars) {
      const init = v.getInitializer && v.getInitializer();
      if (!init) continue;
      const kind = init.getKind && init.getKind();
      const isFunction =
        kind === SyntaxKind.ArrowFunction ||
        kind === SyntaxKind.FunctionExpression;
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

  // Check class methods
  if (!targetFunction) {
    const classes = sourceFile.getClasses();
    for (const cls of classes) {
      const methods = cls.getMethods();
      for (const method of methods) {
        if (
          method.getStart() <= cursorOffset &&
          cursorOffset <= method.getEnd()
        ) {
          targetFunction = method;
          break;
        }
      }
      if (targetFunction) break;
    }
  }

  // Check object literal methods (e.g., Vue component methods)
  if (!targetFunction) {
    const allNodes = sourceFile.getDescendantsOfKind(
      SyntaxKind.MethodDeclaration
    );
    for (const method of allNodes) {
      if (
        method.getStart() <= cursorOffset &&
        cursorOffset <= method.getEnd()
      ) {
        targetFunction = method;
        break;
      }
    }
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
