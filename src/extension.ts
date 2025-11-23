import * as vscode             from 'vscode';
import * as commands           from './commands';
import * as functions          from './functions';
import * as utils  from './utils';
const { log, start, end } = utils.getLog('extn');

export function activate(context: vscode.ExtensionContext) {
  start('activation');

  const convertCommandHandler = vscode.commands.registerCommand(
      'objectifyParams.convert', commands.convertCommandHandler);

  const checkFunctions = vscode.commands.registerCommand(
       'objectifyParams.checkFunctions', functions.checkFunctionsCommandHandler);

  context.subscriptions.push(convertCommandHandler, checkFunctions);

  end('activation');
}

export function deactivate() { log('deactivate'); }