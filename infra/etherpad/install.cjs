// Version-pinned integration points. Fail the image build if upstream changes.
const fs = require('node:fs');
const root = '/opt/etherpad-lite/src/';
function patch(file, from, to) {
  const source = fs.readFileSync(root + file, 'utf8');
  if (!source.includes(from)) throw new Error(`Etherpad integration point missing: ${file}`);
  fs.writeFileSync(root + file, source.replace(from, to));
}
fs.copyFileSync('/opt/gdm/policy.cjs', root + 'gdm.cjs');
fs.copyFileSync('/opt/gdm/client.js', root + 'static/js/gdm-client.js');
patch('node/db/Pad.ts', "  async appendRevision(aChangeset:string, authorId = '') {", "  async appendRevision(aChangeset:string, authorId = '') {\n    return require('../../gdm.cjs').trackWrite(this.id, () => this.appendGdmRevision(aChangeset, authorId));\n  }\n  async appendGdmRevision(aChangeset:string, authorId = '') {");
patch('node/db/Pad.ts', '    copyAText(newAText, this.atext);', "    require('../../gdm.cjs').assertWrite(this.id, newAText.text, this.head);\n    copyAText(newAText, this.atext);");
patch('node/handler/PadMessageHandler.ts', '  const auth = thisSession.auth;', "  const grant = require('../../gdm.cjs').authorize(thisSession.padId, socket.handshake?.query?.gdm);\n  if (!grant) { socket.emit('message', {accessStatus: 'deny'}); return; }\n  thisSession.auth.token = grant.authorToken;\n  const auth = thisSession.auth;");
patch('node/handler/PadMessageHandler.ts', "socket.emit('message', {disconnect: 'badChangeset'});", "if (String(err.message).startsWith('GDM:')) socket.emit('gdmRejected', err.message);\n    socket.emit('message', {disconnect: 'badChangeset'});");
patch('node/handler/PadMessageHandler.ts', '  thisSession.auth.token = grant.authorToken;', "  thisSession.auth.token = grant.authorToken;\n  require('../../gdm.cjs').applyIdentity(message, grant);");
patch('static/js/pad.ts', 'query: {padId},', "query: {padId, gdm: new URLSearchParams(location.hash.slice(1)).get('gdm') || ''},");
patch('static/js/pad.ts', "      hooks.aCallAll('postAceInit', {ace: padeditor.ace, clientVars, pad});", "      require('./gdm-client').postAceInit(null, {ace: padeditor.ace, pad});\n      hooks.aCallAll('postAceInit', {ace: padeditor.ace, clientVars, pad});");
patch('static/js/collab_client.ts', '    hasUnacceptedCommit: () => stateMessage != null,', "    flushGdm: () => { if (editor.getInInternationalComposition()) return false; editor.callWithAce(() => {}, 'gdm-flush', true); handleUserChanges(); return channelState === 'CONNECTED' && !isPendingRevision && !committing; },\n    hasUnacceptedCommit: () => stateMessage != null,");
patch('static/js/pad.ts', '      void maybeShowOutdatedNotice();', '      // Study participants do not manage editor updates.');
// Render exact study identity colours, without author highlighting or fading.
patch('static/js/ace2_inner.ts', 'style.backgroundColor = bgcolor;', "style.backgroundColor = 'transparent';");
patch('static/js/ace2_inner.ts', 'style.color = textColor;', "style.color = info.bgcolor || '#000000';");
patch('static/js/ace2_inner.ts', '`.authorColors .${oneClassName}`', '`.${oneClassName}`');
const path = root + 'ep.json';
const ep = JSON.parse(fs.readFileSync(path, 'utf8'));
ep.parts.push({ name: 'gdm-study', hooks: {
  expressPreSession: 'ep_etherpad-lite/gdm.cjs', padLoad: 'ep_etherpad-lite/gdm.cjs',
  handleMessage: 'ep_etherpad-lite/gdm.cjs',
} });
fs.writeFileSync(path, JSON.stringify(ep));
