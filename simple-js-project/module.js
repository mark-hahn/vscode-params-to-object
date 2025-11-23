

export function sendToWebview(cmd, val) {
  console.log(cmd, val);
}

// module-level call
sendToWebview('ok', {x: 1});
