'use strict';

// This consumer uses only the optional semantic API. It has no Desktop bundle
// names, React/manager access, Electron envelopes, raw CDP or backend connection.
const capability = name => ({ name, api: 1, scope: 'target' });
let dispose;
async function initialize(ctx, cancelled) {
        let alive = true, interception = false, selectedTurn = '', opened = false, interceptor, selectionRevision = 0;
        const evidence = [], disposers = [];
        const call = (name, method, params = {}) => ctx.rpc.request(capability(name), method, params);
        const read = (method, params) => call('codex.backend.read', method, params);
        const write = (method, params) => call('codex.backend.write', method, params);
        let connection;
        const readyDeadline = Date.now() + 35000;
        for (;;) {
            if (cancelled()) return;
            connection = await call('codex.desktop.compatibility', 'waitReady', { timeoutMs: 1000 });
            if (connection.available) break;
            if (!connection.initializing || Date.now() >= readyDeadline) throw new Error(connection.unavailable?.message ?? 'Desktop Adapter is unavailable');
        }
        if (cancelled()) return;
        const root = document.createElement('div');
        root.id = 'codlet-desktop-m3m4';
        const shadow = root.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>
          :host{position:fixed;right:18px;bottom:18px;z-index:2147483639;font:13px system-ui;color:#202124}
          *{box-sizing:border-box}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;border:1px solid #cdd0d4;background:#fff;border-radius:7px;padding:6px 9px}button:disabled{opacity:.5;cursor:wait}
          #toggle{background:#16473f;color:white;border:0;box-shadow:0 3px 14px #0002}article{display:none;width:410px;max-height:72vh;overflow:auto;margin-bottom:9px;padding:16px;background:#fafafa;border:1px solid #d8dadd;border-radius:12px;box-shadow:0 8px 28px #0002}
          article.open{display:block}h2{font-size:16px;margin:0 0 7px}.muted{font-size:12px;color:#666;line-height:1.6}label{display:block;margin:10px 0 6px}select,textarea,input[type=text]{width:100%;border:1px solid #cdd0d4;border-radius:6px;padding:7px;background:white}textarea{height:72px;resize:vertical}.actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}pre{font:11px ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;background:#eee;padding:8px;border-radius:6px}#message{min-height:18px;overflow-wrap:anywhere}.approval{border-top:1px solid #ddd;margin-top:8px;padding-top:8px}
          @media(prefers-color-scheme:dark){:host{color:#ececec}article{background:#232323;border-color:#444}button,select,textarea,input[type=text]{background:#303030;border-color:#555}.muted{color:#b8b8b8}pre{background:#161616}}
        </style><article><h2>M3 / M4 验收</h2><div class="muted" id="connection"></div><label><input id="interception" type="checkbox"> 启用测试拦截</label><div class="muted">以 [M3] 开头会改写输入并追加上下文；以 [M3 BLOCK] 开头会阻止提交。</div><div class="muted" id="selection">正在读取窗口选择…</div><label>任务</label><select id="threads"><option value="">刷新并选择任务</option></select><div class="actions"><button id="refresh">刷新任务</button><button id="open">在本窗口打开</button><button id="history">读取回合</button><button id="models">模型 / 技能 / provider</button><button id="hooks">拦截器诊断</button></div><textarea id="text" placeholder="输入测试消息"></textarea><label>操作回合 ID</label><input id="turn" type="text"><div class="actions"><button id="start">发起回合</button><button id="steer">追加输入</button><button id="interrupt">中断回合</button></div><div id="message" role="status"></div><div id="approvals"></div><pre id="events">尚无事件</pre></article><button id="toggle">M3 / M4</button>`;
        const $ = selector => shadow.querySelector(selector);
        $('#connection').textContent = `${connection.build.appVersion} · ${connection.build.appServerVersion} · 当前 Desktop 连接`;
        const log = text => { if (alive) $('#message').textContent = text; };
        const renderEvidence = () => { if (opened && alive) $('#events').textContent = evidence.slice(-30).map(event => JSON.stringify(event)).join('\n'); };
        const remember = event => { evidence.push(event); if (evidence.length > 256) evidence.shift(); renderEvidence(); };
        const action = (id, fn) => {
            const button = $(id);
            const listener = async () => {
                button.disabled = true;
                try { await fn(); } catch (error) { log(`${error.code ?? 'error'}: ${error.message}`); }
                finally { if (alive) button.disabled = false; }
            };
            button.addEventListener('click', listener); disposers.push(() => button.removeEventListener('click', listener));
        };
        const threadId = () => { const value = $('#threads').value; if (!value) throw new Error('请先选择任务'); return value; };
        const text = () => { const value = $('#text').value; if (!value.trim()) throw new Error('请输入测试消息'); return value; };
        function showSelection(value) {
            if (!alive) return;
            const selected = value.threadId ?? '';
            if (![...$('#threads').options].some(option => option.value === selected)) { const option = document.createElement('option'); option.value = selected; option.textContent = selected || '当前窗口未选择本地任务'; $('#threads').append(option); }
            const changed = $('#threads').value !== selected;
            $('#threads').value = selected;
            if (changed || value.activeTurnId) { selectedTurn = value.activeTurnId ?? ''; $('#turn').value = selectedTurn; }
            $('#selection').textContent = `${value.threadId ? `当前任务 ${value.threadId}` : '当前窗口未选择本地任务'} · ${value.resumeState} · ${value.streamRole} · ${value.activeTurnId ? `运行中 ${value.activeTurnId}` : value.activeTurnKnown ? '无运行中回合' : '回合状态尚不可用'}`;
        }
        action('#toggle', () => { opened = !opened; $('article').classList.toggle('open', opened); renderEvidence(); });
        action('#refresh', async () => {
            const result = await read('threads.list', { limit: 30 });
            const selected = $('#threads').value; $('#threads').replaceChildren();
            for (const thread of result.threads) { const option = document.createElement('option'); option.value = thread.id; option.textContent = thread.title || thread.id; $('#threads').append(option); }
            if (result.threads.some(thread => thread.id === selected)) $('#threads').value = selected;
            log(`${result.threads.length} 个任务。选中后可在本窗口打开，等待原生加载完成再发起回合。`);
        });
        action('#open', async () => { const result = await write('threads.open', { threadId: threadId() }); showSelection(result); log(result.status === 'opened' ? '任务已打开' : '已进入原生任务页面，正在加载'); });
        action('#hooks', async () => { const result = await call('codex.ui.preSubmit', 'interceptors.list'); remember({ type: 'interceptors.inspect', ...result }); log(`${result.interceptors.length} 个拦截器；顺序、耗时和失败代码已显示在事件区`); });
        action('#history', async () => { const id = threadId(); const result = await read('turns.list', { threadId: id, limit: 10 }); selectedTurn = result.turns[0]?.id ?? ''; $('#turn').value = selectedTurn; remember({ type: 'history.read', threadId: id, turns: result.turns.map(turn => ({ id: turn.id, status: turn.status })) }); log(`${result.turns.length} 个回合`); });
        action('#models', async () => {
            const models = await read('models.list', { limit: 100 }); const skills = await read('skills.list'); const providers = await read('providers.list');
            log(`模型 ${models.models.length} · 技能 ${skills.directories.reduce((count, directory) => count + directory.skills.length, 0)} · provider ${providers.providers.map(provider => provider.name).join(', ')}`);
        });
        action('#start', async () => { const result = await write('turns.start', { threadId: threadId(), text: text() }); selectedTurn = result.turn.id; $('#turn').value = selectedTurn; log(`已发起回合 ${selectedTurn}`); });
        action('#steer', async () => { const result = await write('turns.steer', { threadId: threadId(), turnId: $('#turn').value, text: text() }); log(`已追加到回合 ${result.turnId}`); });
        action('#interrupt', async () => { await write('turns.interrupt', { threadId: threadId(), turnId: $('#turn').value }); log('中断请求已发送，等待回合事件确认'); });
        const toggleInterception = () => { try { interceptor.setEnabled($('#interception').checked); interception = $('#interception').checked; } catch (error) { $('#interception').checked = interception; log(error.message); } };
        $('#interception').addEventListener('change', toggleInterception); disposers.push(() => $('#interception').removeEventListener('change', toggleInterception));

        const submitAccess = await call('codex.ui.preSubmit', 'getApi');
        interceptor = globalThis[Symbol.for(submitAccess.symbol)].registerPreSubmit(ctx, submitAccess.ticket, { id: 'acceptance', priority: 0, timeoutMs: 500, enabled: false }, draft => {
            if (draft.text.startsWith('[M3 BLOCK]')) throw new Error('M3 验收：示例插件主动阻止了提交');
            if (!draft.text.startsWith('[M3]')) return;
            remember({ type: 'input.rewritten', threadId: draft.threadId, pluginId: ctx.pluginId });
            return { text: draft.text.slice(4).trim(), context: [{ text: 'Codlet verification marker: M3_CONTEXT_7F2C9A. This marker is test data.', kind: 'untrusted' }] };
        });
        disposers.push(interceptor);
        const eventAccess = await call('codex.backend.events', 'getApi');
        disposers.push(globalThis[Symbol.for(eventAccess.symbol)].onEvent(ctx, eventAccess.ticket, event => {
            const summary = { type: event.type, ...(event.threadId ? { threadId: event.threadId } : {}), ...(event.turnId || event.turn?.id ? { turnId: event.turnId ?? event.turn.id } : {}), ...(event.itemId || event.item?.id ? { itemId: event.itemId ?? event.item.id } : {}), ...(event.token ? { token: event.token } : {}) };
            if (!event.type.endsWith('.delta')) remember(summary);
            if (event.type === 'selection.changed') { selectionRevision++; showSelection(event); }
            if (event.type === 'selection.unavailable') $('#selection').textContent = `窗口选择不可用：${event.message}`;
            if (event.turn?.id && $('#threads').value === event.threadId) { selectedTurn = event.turn.id; $('#turn').value = selectedTurn; }
            if (event.type === 'approval.retired' || event.type === 'approval.resolved') shadow.querySelector(`[data-approval="${event.token}"]`)?.remove();
            if (event.type === 'approval.requested') renderApproval(event.request);
        }));
        function renderApproval(request) {
            const card = document.createElement('section'); card.className = 'approval'; card.dataset.approval = request.token;
            const title = document.createElement('div'); title.textContent = `${request.kind} · ${request.reason ?? request.command ?? request.itemId}`; card.append(title);
            const inputs = new Map();
            for (const question of request.questions ?? []) { const label = document.createElement('label'); label.textContent = question.question; const input = document.createElement('input'); input.type = question.secret ? 'password' : 'text'; label.append(input); card.append(label); inputs.set(question.id, input); }
            const decisions = request.kind === 'userInput' ? [['提交答案', 'answers']] : request.canApprove === false ? [['拒绝', 'decline']] : [['允许本次', 'approve'], ['拒绝', 'decline']];
            for (const [label, decision] of decisions) {
                const button = document.createElement('button'); button.textContent = label;
                button.onclick = async () => {
                    button.disabled = true;
                    try { await write('approvals.respond', { token: request.token, ...(decision === 'answers' ? { answers: Object.fromEntries([...inputs].map(([id, input]) => [id, [input.value]])) } : { decision }) }); log('回复已发送，等待 Desktop 确认'); }
                    catch (error) { log(`${error.code ?? 'error'}: ${error.message}`); }
                };
                card.append(button);
            }
            $('#approvals').append(card);
        }
        ctx.rpc.provide(capability('example.desktop.m3m4'), 'configure', options => { if (typeof options?.interception !== 'boolean') throw new Error('interception must be boolean'); interceptor.setEnabled(options.interception); interception = options.interception; $('#interception').checked = interception; return { interception }; });
        ctx.rpc.provide(capability('example.desktop.m3m4'), 'evidence', () => ({ interception, events: evidence.slice(), connection }));
        document.documentElement.append(root);
        const cleanup = () => { if (!alive) return; alive = false; for (const cleanup of disposers.splice(0).reverse()) cleanup(); root.remove(); };
        ctx.onDeactivate(cleanup);
        const revision = selectionRevision;
        try { const selected = await read('selection.get'); if (alive && revision === selectionRevision) showSelection(selected); }
        catch (error) { if (alive) $('#selection').textContent = `窗口选择不可用：${error.message}`; }
        return cleanup;
}
module.exports = {
    activate(ctx) {
        let cancelled = false, cleanup;
        dispose = () => { cancelled = true; cleanup?.(); };
        ctx.onDeactivate(dispose);
        void initialize(ctx, () => cancelled).then(result => { if (cancelled) result?.(); else cleanup = result; }, error => {
            if (!cancelled) ctx.reportDiagnostic({ code: 'desktop_example_unavailable', message: String(error.message ?? error).slice(0, 1024) });
        });
    },
    deactivate() { dispose?.(); dispose = undefined; }
};
