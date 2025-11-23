import * as vscode from 'vscode';
import * as utils  from './utils';
const { log, start, end } = getLog('cmds');

const outputChannel = vscode.window.createOutputChannel('objectifyParams');

export function getLog(module: string) : {
  log:   (...args: any[]) => void;
  start: (name: string,     hide?: boolean, msg?: string)     => void;
  end:   (name: string, onlySlow?: boolean, msg?: string) => void;
} {
  const timers: Record<string, number> = {};

  const start = function (name: string, hide = false, msg = ''): void {
    const startTime = Date.now();
    timers[name] = startTime;
    if (hide) return;
    const line = `[ext:${module}] ${name} started${msg ? ', ' + msg : ''}`;
    outputChannel.appendLine(line);
    log(line);
  };

  const end = function (name: string, onlySlow = false, msg = ''): void {
    if (!timers[name]) {
      const line = `[ext:${module}] ${name} ended${msg ? ', ' + msg : ''}`;
      outputChannel.appendLine(line);
      log(line);
      return;
    }
    const endTime = Date.now();
    const duration = endTime - timers[name];
    if (onlySlow && duration < 100) return;
    const line = `[ext:${module}] ${name} ended, ${duration}ms${msg ? ', ' + msg : ''}`;
    outputChannel.appendLine(line);
    log(line);
  };

  const log = function (...args: any[]): void {
    let errFlag    = false;
    let errMsgFlag = false;
    let infoFlag   = false;
    let nomodFlag  = false;

    if (typeof args[0] === 'string') {
      errFlag = args[0].includes('err');
      infoFlag = args[0].includes('info');
      nomodFlag = args[0].includes('nomod');
      errMsgFlag = args[0].includes('errmsg');
    }

    if (errFlag || infoFlag || nomodFlag || errMsgFlag) args = args.slice(1);

    let errMsg: string | undefined;
    if (errMsgFlag) {
      errMsg  = args[0]?.message + ' -> ';
      args    = args.slice(1);
      errFlag = true;
    }

    const par = args.map((a) => {
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a, null, 2);
        } catch (e: any) {
          return JSON.stringify(Object.keys(a)) + e.message;
        }
      } else return a;
    });

    const line = (nomodFlag ? '' : '[ext:' + module + '] ') +
                 (errFlag ? ' error, ' : '') +
                 (errMsg !== undefined ? errMsg : '') +
                 par.join(' ');

    const infoLine = par.join('Data Scope: ').replace('parse: ','');

    outputChannel.appendLine(line);
    if (errFlag) console.error(line);
    else log(line);
    if (infoFlag) void vscode.window.showInformationMessage(infoLine);
  };

  return { log, start, end };
}
