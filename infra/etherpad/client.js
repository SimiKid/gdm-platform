exports.postAceInit = (_hook, { pad, ace }) => {
  const counter = document.createElement('div');
  counter.style.cssText = 'position:fixed;bottom:0;right:0;z-index:10000;background:white;color:#172b4d;padding:6px 12px;font:14px system-ui';
  document.body.append(counter);
  let lastCount = 0;
  const update = () => {
    ace.callWithAce(editor => {
      const text = editor.ace_exportText();
      lastCount = [...text].length;
      counter.textContent = `${lastCount} / 1000 characters`;
      counter.style.color = lastCount >= 1000 ? '#a32626' : '#172b4d';
    }, 'gdm-counter', true);
  };
  setInterval(update, 300);
  // Acknowledge a manual submit only after the collaboration server accepts
  // outstanding edits. The parent keeps the iframe mounted until this reply.
  window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'gdm-flush') return;
    pad.collabClient.commitDelay = 0;
    // Normalize pending DOM input before testing the collaboration queue. A
    // click immediately after typing can arrive before Etherpad's idle worker.
    pad.collabClient.flushGdm();
    ace.setEditable(false);
    const started = Date.now();
    const wait = setInterval(() => {
      if (pad.collabClient.flushGdm()) {
        clearInterval(wait);
        parent.postMessage({ type: 'gdm-flushed', requestId: event.data.requestId }, location.origin);
      } else if (Date.now() - started > 5000) {
        clearInterval(wait);
        ace.setEditable(true);
        parent.postMessage({ type: 'gdm-flush-failed', requestId: event.data.requestId }, location.origin);
      }
    }, 50);
  });
  pad.socket.on('gdmRejected', reason => {
    sessionStorage.setItem('gdm-limit-message', reason);
    location.reload(); // Resync rejected edits with the last accepted server revision.
  });
  const notice = sessionStorage.getItem('gdm-limit-message');
  if (notice) { sessionStorage.removeItem('gdm-limit-message'); const box = document.createElement('div'); box.textContent = notice; box.setAttribute('role', 'alert'); box.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#fff0cc;color:#5c3700;padding:12px;z-index:10001'; document.body.append(box); setTimeout(() => box.remove(), 8000); }
};
