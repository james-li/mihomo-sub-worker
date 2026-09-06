export const ADMIN_APP_JS = String.raw`
const state = { config: null };
const list = document.querySelector('#sources');
const message = document.querySelector('#message');
const previewOutput = document.querySelector('#preview-output');
const basePath = location.pathname.replace(/\/?$/, '/');

function field(label, control) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const title = document.createElement('span');
  title.textContent = label;
  wrapper.append(title, control);
  return wrapper;
}

function input(value, placeholder) {
  const control = document.createElement('input');
  control.value = value || '';
  control.placeholder = placeholder || '';
  return control;
}

function formatSelect(value) {
  const control = document.createElement('select');
  [['auto','自动识别'],['clash-yaml','Clash YAML'],['uri-list','URI 列表'],['base64-uri-list','Base64 URI 列表']]
    .forEach(function(item) {
      const option = document.createElement('option'); option.value = item[0]; option.textContent = item[1];
      control.append(option);
    });
  control.value = value || 'auto';
  return control;
}

function createRow(source) {
  source = source || { id: '', type: 'url', enabled: true, tags: [], format: 'auto' };
  const row = document.createElement('article');
  row.className = 'source';
  row.dataset.id = source.id || '';

  const heading = document.createElement('div'); heading.className = 'source-heading';
  const enabled = input(); enabled.type = 'checkbox'; enabled.checked = source.enabled !== false; enabled.dataset.role = 'enabled';
  const type = document.createElement('select'); type.dataset.role = 'type';
  [['url','远程 URL'],['file','本地文件'],['protocol_url','协议链接']].forEach(function(item) {
    const option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; type.append(option);
  });
  type.value = source.type || 'url';
  const name = input(source.name, '来源名称（可选）'); name.dataset.role = 'name';
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除'; remove.className = 'danger';
  remove.addEventListener('click', function() { row.remove(); });
  heading.append(enabled, type, name, remove);

  const body = document.createElement('div'); body.className = 'source-body';
  const tags = input((source.tags || []).join(' '), 'PRIVATE HK WORK'); tags.dataset.role = 'tags';

  function renderBody() {
    const selected = type.value;
    body.replaceChildren();
    if (selected === 'url') {
      const url = input(source.type === 'url' || !source.type ? source.url : '', 'https://example.com/sub');
      url.type = 'url'; url.dataset.role = 'value';
      body.append(field('HTTPS 订阅地址', url), field('内容格式', formatSelect(source.format)));
    } else if (selected === 'protocol_url') {
      const uri = document.createElement('textarea'); uri.rows = 4; uri.dataset.role = 'value';
      uri.value = source.type === 'protocol_url' ? (source.protocolUrl || '') : '';
      uri.placeholder = 'vless://... / trojan://... / vmess://...';
      body.append(field('完整协议链接', uri));
    } else {
      const fileName = input(source.type === 'file' ? source.fileName : '', 'subscription.txt'); fileName.dataset.role = 'filename';
      const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.yaml,.yml,.txt,.conf,text/plain,text/yaml';
      const content = document.createElement('textarea'); content.rows = 10; content.dataset.role = 'value';
      content.value = source.type === 'file' ? (source.content || '') : '';
      content.placeholder = '选择文件后会在此显示完整正文，也可直接编辑';
      picker.addEventListener('change', async function() {
        const file = picker.files && picker.files[0]; if (!file) return;
        if (file.size > 2 * 1024 * 1024) { message.textContent = '文件超过 2 MiB'; picker.value = ''; return; }
        fileName.value = file.name; content.value = await file.text();
      });
      body.append(field('文件名', fileName), field('选择本地文件（最大 2 MiB）', picker), field('文件正文', content), field('内容格式', formatSelect(source.format)));
    }
    body.append(field('标签（空格、逗号或下划线分隔）', tags));
  }
  type.addEventListener('change', function() { source = { type: type.value, tags: [] }; renderBody(); });
  renderBody();
  row.append(heading, body);
  return row;
}

function add(type) { list.append(createRow({ type: type, enabled: true, tags: [], format: 'auto' })); }

async function load() {
  const response = await fetch(basePath + 'api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('配置加载失败');
  state.config = await response.json();
  list.replaceChildren(...state.config.sources.map(createRow));
  message.textContent = '配置版本 ' + state.config.version;
}

function readRow(row) {
  const type = row.querySelector('[data-role=type]').value;
  const value = row.querySelector('[data-role=value]').value;
  const result = {
    id: row.dataset.id || undefined,
    type: type,
    enabled: row.querySelector('[data-role=enabled]').checked,
    name: row.querySelector('[data-role=name]').value,
    tags: row.querySelector('[data-role=tags]').value.split(/[\s,_]+/).filter(Boolean)
  };
  if (type === 'url') { result.url = value; result.format = row.querySelector('.source-body select').value; }
  if (type === 'protocol_url') result.protocolUrl = value;
  if (type === 'file') {
    result.fileName = row.querySelector('[data-role=filename]').value;
    result.content = value;
    result.format = row.querySelector('.source-body select').value;
  }
  return result;
}

document.querySelector('#add-url').addEventListener('click', function() { add('url'); });
document.querySelector('#add-file').addEventListener('click', function() { add('file'); });
document.querySelector('#add-protocol').addEventListener('click', function() { add('protocol_url'); });
document.querySelector('#copy').addEventListener('click', async function() {
  const target = new URL(location.href); target.searchParams.set('format', 'clash');
  await navigator.clipboard.writeText(target.toString()); message.textContent = '管理员订阅地址已复制';
});
const qrDialog = document.querySelector('#qr-dialog');
const qrImage = document.querySelector('#qr-image');
document.querySelector('#show-qr').addEventListener('click', function() {
  qrImage.src = basePath + 'api/subscription-qr.svg';
  qrDialog.showModal();
});
document.querySelector('#close-qr').addEventListener('click', function() { qrDialog.close(); });
qrDialog.addEventListener('click', function(event) { if (event.target === qrDialog) qrDialog.close(); });
document.querySelector('#preview').addEventListener('click', async function() {
  message.textContent = '正在生成预览…';
  const response = await fetch(basePath + 'api/preview', { method: 'POST' });
  const result = await response.json();
  previewOutput.textContent = response.ok ? JSON.stringify(result.sites || [], null, 2) : '';
  message.textContent = response.ok ? ('有效节点 ' + result.nodes + '，警告 ' + result.warnings + '，失败来源 ' + result.failedSources) : ('预览失败：' + result.error);
});
document.querySelector('#save').addEventListener('click', async function() {
  const button = document.querySelector('#save'); button.disabled = true; message.textContent = '保存中…';
  try {
    const sources = [...list.querySelectorAll('.source')].map(readRow);
    const response = await fetch(basePath + 'api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: state.config.version, sources: sources })
    });
    const result = await response.json();
    if (!response.ok) { message.textContent = '保存失败：' + result.error; return; }
    state.config = result; list.replaceChildren(...state.config.sources.map(createRow));
    message.textContent = '已保存，配置版本 ' + state.config.version;
  } finally { button.disabled = false; }
});
load().catch(function(error) { message.textContent = error.message; });
`;

export function adminHtml(scriptPath: string): string {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fgfwsub</title><style>
:root{font-family:system-ui,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}header,main{max-width:1040px;margin:auto;padding:20px}header{display:flex;align-items:center;justify-content:space-between}h1{font-size:22px;margin:0 0 4px}.panel{background:#fff;border:1px solid #dce2eb;border-radius:14px;padding:18px}.toolbar,.actions,.footer,.source-heading{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar{margin-bottom:14px}.source{border:1px solid #e1e6ee;border-radius:12px;padding:14px;margin:12px 0;background:#fbfcfe}.source-heading{display:grid;grid-template-columns:24px 140px minmax(180px,1fr) auto}.source-body{display:grid;grid-template-columns:1fr 220px;gap:10px;margin-top:12px}.field{display:flex;flex-direction:column;gap:5px;font-size:13px;color:#596579}.field:has(textarea){grid-column:1/-1}.field:last-child{grid-column:1/-1}.field span{font-weight:600}input,select,textarea,button{font:inherit}input:not([type=checkbox]):not([type=file]),select,textarea{width:100%;padding:9px;border:1px solid #c8d1dd;border-radius:8px;background:#fff}textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}button{padding:9px 13px;border:1px solid #c8d1dd;border-radius:8px;background:#fff;cursor:pointer}button:disabled{opacity:.55}.primary{color:#fff;background:#3867e8;border-color:#3867e8}.danger{color:#b42318}.footer{justify-content:space-between;margin-top:16px;color:#637083}.note{color:#637083;font-size:13px}.spacer{flex:1}#preview-output{max-height:360px;overflow:auto;white-space:pre-wrap;background:#111827;color:#d1e7ff;border-radius:10px;padding:12px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}#preview-output:empty{display:none}dialog{border:0;border-radius:16px;padding:20px;box-shadow:0 24px 80px #17203355;text-align:center;color:inherit}dialog::backdrop{background:#17203388}dialog h2{font-size:18px;margin:0 0 4px}dialog img{display:block;width:min(76vw,340px);height:auto;margin:16px auto;background:#fff}.dialog-actions{display:flex;justify-content:center}@media(max-width:650px){header,.footer{align-items:flex-start;flex-direction:column}.source-heading{grid-template-columns:24px 1fr}.source-heading [data-role=name]{grid-column:2}.source-heading .danger{grid-column:2}.source-body{grid-template-columns:1fr}.source-body .field{grid-column:1}}
</style></head><body><header><div><h1>fgfwsub</h1><div>Clash 多协议订阅聚合</div></div><div class="actions"><button id="show-qr">用户订阅二维码</button><button id="copy">复制管理员订阅地址</button></div></header><main><section class="panel"><div class="toolbar"><strong>订阅编辑器</strong><span class="spacer"></span><button id="add-url">+ 远程 URL</button><button id="add-file">+ 本地文件</button><button id="add-protocol">+ 协议链接</button></div><p class="note">ADMIN_KEY 拥有完整管理权限。文件正文和协议链接将完整保存到 KV 并在此页面显示。</p><div id="sources"></div><div class="footer"><span id="message">加载中…</span><div class="actions"><button id="preview">生成预览</button><button id="save" class="primary">保存配置</button></div></div><pre id="preview-output"></pre></section></main><dialog id="qr-dialog"><h2>用户订阅二维码</h2><p class="note">使用 Clash 客户端扫描，二维码内容为当前域名的用户订阅地址。</p><img id="qr-image" alt="用户订阅地址二维码"><div class="dialog-actions"><button id="close-qr" type="button">关闭</button></div></dialog><script src="${scriptPath}" defer></script></body></html>`;
}
