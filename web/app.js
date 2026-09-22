(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = value => JSON.stringify(value, null, 2);
  const labels = { overview: 'Overview', contracts: 'Contracts', changes: 'Patch explorer', impact: 'Impact graph', candidates: 'Mined promises', integrity: 'Receipt integrity' };
  let receipt, filter = 'all', fileIndex = 0, diffMode = 'diff', graphFocus = null, replayTimer, toastTimer, dragDepth = 0;
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
  function navigate(view) {
    if (!labels[view]) view = 'overview';
    document.querySelectorAll('[data-view]').forEach(a => { a.classList.toggle('active', a.dataset.view === view); if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.querySelectorAll('[data-panel]').forEach(s => s.classList.toggle('active', s.dataset.panel === view));
    $('crumb').textContent = labels[view];
  }
  function observation(value) { if (!value) return 'No observation'; return value.kind === 'return' ? json(value.value) : `${value.kind.toUpperCase()}\n${value.message || ''}`; }
  function observations(example) { return `<div class="input-line"><span>Reproducing input</span><code>${esc(JSON.stringify(example.arguments))}</code></div><div class="observation-grid"><div class="observation"><span class="eyebrow">BASE / BEFORE</span><pre>${esc(observation(example.before))}</pre></div><div class="observation after"><span class="eyebrow">HEAD / AFTER</span><pre>${esc(observation(example.after))}</pre></div></div>`; }
  function validate(data) {
    if (!data || data.schemaVersion !== 1 || !data.analysis || !data.execution || !data.summary || !data.integrity || !Array.isArray(data.execution.results) || !Array.isArray(data.analysis.changes) || !Array.isArray(data.analysis.candidates) || !Array.isArray(data.analysis.findings) || !Array.isArray(data.analysis.graph?.nodes) || !Array.isArray(data.analysis.graph?.edges) || !Array.isArray(data.limitations) || !Array.isArray(data.analysis.impactedTests)) throw new Error('This file is not a supported ProofPatch v1 receipt.');
    for (const n of ['contracts', 'passed', 'failed', 'skipped', 'cases']) if (!Number.isFinite(data.summary[n]) || data.summary[n] < 0) throw new Error('Invalid receipt summary.');
    for (const item of data.execution.results) if (!item || typeof item.title !== 'string' || !item.oracle || typeof item.file !== 'string' || !['passed', 'failed', 'error', 'skipped'].includes(item.status)) throw new Error('Invalid contract result.');
    if (data.analysis.graph.nodes.length > 20000 || data.execution.results.length > 1000 || data.analysis.candidates.length > 5000) throw new Error('Receipt exceeds viewer limits.');
    return data;
  }
  function load(data) {
    receipt = validate(data); filter = 'all'; fileIndex = 0; graphFocus = null; diffMode = 'diff';
    $('empty').hidden = true; $('report').hidden = false; $('download').disabled = false;
    $('repo-short').textContent = String(receipt.analysis.repository).split(/[\\/]/).pop() || 'Repository';
    $('repo-name').textContent = receipt.analysis.repository;
    $('base-sha').textContent = String(receipt.analysis.baseSha).slice(0, 8); $('head-sha').textContent = String(receipt.analysis.headSha).slice(0, 8);
    $('receipt-id').textContent = receipt.id; $('nav-contracts').textContent = receipt.summary.contracts; $('nav-changes').textContent = receipt.analysis.changes.length;
    ['contracts', 'passed', 'failed', 'cases'].forEach(key => { $('metric-' + key).textContent = receipt.summary[key].toLocaleString(); });
    $('case-budget').textContent = `${receipt.execution.mode.toUpperCase()} MODE · SEED ${receipt.execution.seed}`;
    const regression = receipt.summary.verdict === 'regression', passed = receipt.summary.verdict === 'passed';
    $('headline').textContent = regression ? 'A visible consequence.' : passed ? 'Evidence to move forward.' : 'Questions worth asking.';
    $('overview-description').textContent = `${receipt.analysis.changes.length} changed files. ${receipt.execution.mode === 'static' ? 'Static observations, ready for review.' : `${receipt.summary.cases} recorded input cases. Follow the behavior behind the diff.`}`;
    $('verdict-banner').className = 'verdict-banner' + (passed ? ' pass' : regression ? '' : ' review');
    $('verdict-symbol').textContent = regression ? '!' : passed ? '✓' : '?';
    $('verdict-title').textContent = regression ? `${receipt.summary.failed} behavioral ${receipt.summary.failed === 1 ? 'contract failed' : 'contracts failed'}.` : passed ? 'The checked contracts passed.' : 'This patch needs a closer look.';
    $('verdict-detail').textContent = regression ? 'A reproducing input changes the story. Inspect it before you merge.' : receipt.execution.mode === 'static' ? 'Static analysis only. No target code or behavioral checks were executed.' : passed ? 'The declared cases passed. Behavior beyond this finite input domain remains unverified.' : `${receipt.summary.skipped} incomplete checks; ${receipt.analysis.findings.filter(f => f.severity !== 'info').length} static warnings. Review the evidence and its limits.`;
    renderSpotlight(); renderTimeline(); renderContracts(); renderFiles(); renderFindings(); renderGraph(); renderCandidates(); renderIntegrity();
    document.querySelectorAll('#contract-filters button').forEach(b => b.classList.toggle('selected', b.dataset.filter === 'all'));
    $('contract-search').value = ''; $('candidate-search').value = '';
    navigate(location.hash.slice(1));
  }
  function renderSpotlight() {
    const failed = receipt.execution.results.find(r => r.counterexample);
    $('spotlight').innerHTML = failed ? `<h3 class="spot-title">${esc(failed.title)}</h3><div class="spot-path">${esc(failed.file)} → ${esc(failed.export)}()</div>${observations(failed.counterexample)}<div class="spot-bottom"><small>${failed.counterexample.minimized ? '↘ Shrunk within the declared domain' : '↳ Reproduced on a declared input'}</small><a class="text-link" href="#contracts">See all evidence ↗</a></div>` : `<div class="no-results">${receipt.execution.mode === 'static' ? 'No executions yet. Review mined promises and add a contract to challenge the patch.' : 'No counterexample was recorded. Inspect passing and incomplete contracts to understand what was checked.'}</div>`;
  }
  function renderTimeline() {
    const a = receipt.analysis, s = receipt.summary;
    const steps = [['Resolve the snapshots', `${String(a.baseSha).slice(0, 7)} → ${String(a.headSha).slice(0, 7)}`], ['Trace the change', `${a.changes.length} files · ${a.graph.edges.length} import relationships`], [receipt.execution.mode === 'static' ? 'Mine candidate promises' : 'Challenge the contracts', receipt.execution.mode === 'static' ? `${a.candidates.length} review suggestions · no execution` : `${s.cases} recorded cases · ${s.failed} failed contracts`], ['Seal the evidence', 'Portable receipt · canonical SHA-256']];
    $('timeline').innerHTML = steps.map((step, i) => `<li><span>${i + 1}</span>${esc(step[0])}<small>${esc(step[1])}</small></li>`).join('');
  }
  function renderContracts() {
    if (!receipt) return;
    const query = $('contract-search').value.toLowerCase();
    const results = receipt.execution.results.filter(r => (filter === 'all' || filter === r.status || filter === 'incomplete' && ['error', 'skipped'].includes(r.status)) && `${r.title} ${r.file} ${r.export}`.toLowerCase().includes(query));
    $('contracts-list').innerHTML = results.length ? results.map(r => `<details class="contract"><summary><span class="result-icon ${esc(r.status)}">${r.status === 'passed' ? '✓' : r.status === 'failed' ? '!' : '?'}</span><div><div class="contract-title">${esc(r.title)}</div><div class="contract-sub mono">${esc(r.file)} · ${esc(r.export)}()</div></div><span class="contract-badge ${esc(r.status)}">${esc(r.status)}</span></summary><div class="contract-body"><p class="contract-description">Oracle <code>${esc(r.oracle.kind)}</code>${'value' in r.oracle ? ` · Expected <code>${esc(JSON.stringify(r.oracle.value))}</code>` : ''}</p>${r.counterexample ? observations(r.counterexample) : `<p class="fineprint">${r.status === 'passed' ? 'All recorded cases satisfied this oracle. No per-case trace was retained for passing cases.' : esc(r.reason || 'No executable observation is available.')}</p>`}${r.reason && r.counterexample ? `<p class="fineprint">${esc(r.reason)}</p>` : ''}<div class="result-footer"><span>${r.cases} cases</span><span>${r.passed} passed / ${r.failed} failed</span><span>${r.durationMs} ms</span>${r.counterexample ? `<span>${r.counterexample.minimized ? 'Shrinking reproduced the failure' : 'Original reproducing input'}</span>` : ''}</div></div></details>`).join('') : '<div class="no-results">No contracts match this view. Static receipts contain no executed contracts.</div>';
  }
  function renderFiles() {
    const changes = receipt.analysis.changes;
    $('file-list').innerHTML = changes.length ? changes.map((f, i) => `<button class="file-button ${fileIndex === i ? 'selected' : ''}" data-file="${i}"><span>${esc(f.status)}</span><span class="path" title="${esc(f.path)}">${esc(f.path)}</span><span class="diff-numbers"><span class="mint">+${f.additions}</span> <span class="coral">−${f.deletions}</span></span></button>`).join('') : '<div class="no-results">No changed files.</div>';
    renderCode();
  }
  function renderCode() {
    const file = receipt.analysis.changes[fileIndex];
    $('selected-file').textContent = file?.path || 'No file selected';
    const code = file ? diffMode === 'diff' ? file.patch : file[diffMode] : '';
    $('code-view').innerHTML = code ? String(code).split('\n').map((line, i) => `<span class="code-line ${diffMode !== 'diff' ? '' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}">${diffMode === 'diff' ? '' : `<span class="line-no">${i + 1}</span>`}${esc(line) || ' '}</span>`).join('') : '<span class="code-line">No text preview available for this snapshot.</span>';
    document.querySelectorAll('#diff-modes button').forEach(b => b.classList.toggle('selected', b.dataset.mode === diffMode));
  }
  function renderFindings() {
    $('findings').innerHTML = receipt.analysis.findings.map(f => `<article class="finding"><span class="eyebrow">${esc(f.severity)} / STATIC SIGNAL</span><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p><span class="spot-path">${esc(f.file)}${f.line ? ':' + f.line : ''}</span></article>`).join('');
  }
  function renderGraph() {
    const all = receipt.analysis.graph.nodes;
    const nodes = [...all.filter(n => n.changed), ...all.filter(n => !n.changed && n.impacted), ...all.filter(n => !n.changed && !n.impacted)].slice(0, 45);
    const groups = [nodes.filter(n => n.changed), nodes.filter(n => !n.changed && n.kind !== 'test'), nodes.filter(n => !n.changed && n.kind === 'test')];
    const height = Math.max(300, Math.max(...groups.map(g => g.length)) * 65 + 100), positions = new Map();
    groups.forEach((group, column) => group.forEach((n, row) => positions.set(n.id, { x: 25 + column * 245, y: 80 + row * 65 })));
    const edges = receipt.analysis.graph.edges.filter(e => positions.has(e.source) && positions.has(e.target));
    const related = new Set([graphFocus]); edges.forEach(e => { if (e.source === graphFocus) related.add(e.target); if (e.target === graphFocus) related.add(e.source); });
    const paths = edges.map(e => { const a = positions.get(e.source), b = positions.get(e.target); const x1 = a.x + 100, y1 = a.y + 21, x2 = b.x + 100, y2 = b.y + 21; const mid = (x1 + x2) / 2; return `<path class="graph-edge ${e.source === graphFocus || e.target === graphFocus ? 'focused' : ''}" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}"/>`; }).join('');
    const blocks = nodes.map((n, i) => { const p = positions.get(n.id); return `<g class="graph-node ${graphFocus === n.id ? 'selected' : ''} ${graphFocus && !related.has(n.id) ? 'dim' : ''}" data-node="${i}" tabindex="0" role="button" aria-label="${esc(n.id)}"><title>${esc(n.id)}</title><rect x="${p.x}" y="${p.y}" width="200" height="42" rx="8"/><circle cx="${p.x + 15}" cy="${p.y + 21}" r="3" fill="${n.changed ? 'var(--coral)' : n.kind === 'test' ? 'var(--blue)' : 'var(--mint)'}"/><text x="${p.x + 28}" y="${p.y + 25}">${esc(n.label.length > 23 ? n.label.slice(0, 21) + '…' : n.label)}</text></g>`; }).join('');
    $('graph').innerHTML = nodes.length ? `<svg viewBox="0 0 740 ${height}" role="group" aria-label="Interactive relative-import impact graph"><text class="graph-column" x="25" y="36">CHANGED MODULES</text><text class="graph-column" x="270" y="36">OTHER MODULES</text><text class="graph-column" x="515" y="36">TEST MODULES</text>${paths}${blocks}</svg>` : '<div class="no-results">No module relationships found.</div>';
    const focusNode = index => { graphFocus = nodes[index].id; renderGraph(); };
    $('graph').querySelectorAll('[data-node]').forEach(node => { node.addEventListener('click', () => focusNode(Number(node.dataset.node))); node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusNode(Number(node.dataset.node)); } }); });
    $('graph-detail').textContent = graphFocus ? `${graphFocus} · ${edges.filter(e => e.source === graphFocus).length} imports · ${edges.filter(e => e.target === graphFocus).length} importing modules${all.length > 45 ? ' · preview limited to 45 nodes' : ''}` : `Select a node to isolate its immediate relationships. ${all.length > 45 ? 'Showing 45 nodes; the full graph is in the JSON receipt.' : `${nodes.length} modules · ${edges.length} relative imports.`}`;
    $('impacted-tests').innerHTML = receipt.analysis.impactedTests.length ? receipt.analysis.impactedTests.map(f => `<span class="test-chip">${esc(f)}</span>`).join('') : '<p class="fineprint">No impacted test modules were resolved.</p>';
  }
  function renderCandidates() {
    if (!receipt) return;
    const query = $('candidate-search').value.toLowerCase();
    const candidates = receipt.analysis.candidates.filter(c => `${c.title} ${c.file} ${c.evidence}`.toLowerCase().includes(query));
    $('candidate-list').innerHTML = candidates.length ? candidates.map(c => `<article class="panel candidate"><span class="eyebrow">◇ ${esc(c.source)} / SUGGESTED</span><h3>${esc(c.title)}</h3><pre>${esc(c.evidence)}</pre><footer>${esc(c.file)}:${c.line}${c.symbol ? ' · ' + esc(c.symbol) : ''}</footer></article>`).join('') : '<div class="no-results">No mined promises match this search.</div>';
  }
  async function renderIntegrity() {
    const current = receipt;
    $('digest').textContent = current.integrity.digest;
    $('integrity-title').textContent = 'Checking receipt fingerprint…';
    $('integrity-description').textContent = 'Recomputing SHA-256 over the canonical payload, excluding the integrity block.';
    $('integrity-pill').textContent = 'Checking integrity'; $('integrity-pill').className = 'quiet-chip';
    $('signature-note').textContent = current.integrity.signature ? 'This receipt includes an Ed25519 signature. Verify it with the CLI and a separately trusted public key to authenticate the signer. The embedded key alone does not establish identity.' : 'This receipt is unsigned. A matching digest detects inconsistency, but anyone can replace the payload and recompute its digest.';
    const metadata = [['Receipt', current.id], ['Tool', `proofpatch ${current.tool?.version || '?'}`], ['Recorded', new Date(current.createdAt).toLocaleString()], ['Execution', current.execution.mode], ['Seed', current.execution.seed], ['Elapsed', `${(current.execution.durationMs / 1000).toFixed(2)} seconds`], ['Base commit', String(current.analysis.baseSha).slice(0, 16)], ['Head commit', String(current.analysis.headSha).slice(0, 16)]];
    $('metadata').innerHTML = metadata.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('limitations').innerHTML = current.limitations.map((limit, i) => `<details><summary>${String(i + 1).padStart(2, '0')} / ${esc(String(limit).split('. ')[0])}</summary><p>${esc(limit)}</p></details>`).join('');
    try {
      if (!crypto?.subtle) throw new Error('Web Crypto unavailable');
      const { integrity, ...payload } = current;
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload)));
      if (current !== receipt) return;
      const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      const valid = integrity.algorithm === 'sha256' && hash === integrity.digest;
      $('integrity-title').textContent = valid ? 'The fingerprint matches.' : 'The receipt fingerprint does not match.';
      $('integrity-description').textContent = valid ? 'This payload matches its recorded SHA-256 digest. This checks internal integrity; it does not prove the observations are true or authenticate an author.' : 'The payload may have changed, or the file may be corrupt. Treat its contents as unverified.';
      $('integrity-pill').textContent = valid ? 'Integrity checked' : 'Integrity mismatch'; $('integrity-pill').className = 'quiet-chip ' + (valid ? 'valid' : 'invalid');
    } catch { if (current !== receipt) return; $('integrity-title').textContent = 'Verify this receipt with the CLI.'; $('integrity-description').textContent = 'Browser hashing is unavailable in this context. Run: node dist/cli.js verify receipt.json'; $('integrity-pill').textContent = 'Integrity not checked'; }
  }
  async function importFile(file) {
    if (!file) return;
    try { if (file.size > 16 * 1024 * 1024) throw new Error('Receipt exceeds the 16 MiB viewer import limit.'); load(JSON.parse(await file.text())); toast('Receipt imported. Nothing was uploaded.'); }
    catch (error) { toast(error.message || 'Could not load receipt.'); }
    $('file-input').value = '';
  }
  $('import').addEventListener('click', () => $('file-input').click()); $('empty-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => importFile(e.target.files[0]));
  $('download').addEventListener('click', () => { if (!receipt) return; const url = URL.createObjectURL(new Blob([json(receipt) + '\n'], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'proofpatch-receipt.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  $('theme').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('proofpatch-theme', theme); } catch {} });
  try { const theme = localStorage.getItem('proofpatch-theme'); if (theme === 'light') document.documentElement.dataset.theme = theme; } catch {}
  $('contract-filters').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button) return; filter = button.dataset.filter; $('contract-filters').querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === button)); renderContracts(); });
  $('contract-search').addEventListener('input', renderContracts); $('candidate-search').addEventListener('input', renderCandidates);
  $('file-list').addEventListener('click', event => { const b = event.target.closest('[data-file]'); if (!b) return; fileIndex = Number(b.dataset.file); renderFiles(); });
  $('diff-modes').addEventListener('click', event => { const b = event.target.closest('[data-mode]'); if (!b) return; diffMode = b.dataset.mode; renderCode(); });
  $('reset-graph').addEventListener('click', () => { graphFocus = null; renderGraph(); });
  $('copy-digest').addEventListener('click', async () => { try { await navigator.clipboard.writeText(receipt.integrity.digest); toast('Fingerprint copied.'); } catch { toast('Copy is unavailable. Select the fingerprint above to copy it.'); } });
  $('replay').addEventListener('click', () => { clearInterval(replayTimer); let index = 0; const steps = [...$('timeline').children]; steps.forEach(s => s.classList.remove('replaying')); $('replay').textContent = 'Replaying recorded evidence…'; const advance = () => { steps.forEach((s, i) => s.classList.toggle('replaying', i === index)); if (index++ >= steps.length) { clearInterval(replayTimer); $('replay').textContent = '▷ Replay recorded evidence'; } }; advance(); replayTimer = setInterval(advance, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 200 : 850); });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  document.addEventListener('keydown', event => { if (event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return; const views = Object.keys(labels); if (/^[1-6]$/.test(event.key)) location.hash = views[Number(event.key) - 1]; if (event.key === '/') { event.preventDefault(); location.hash = 'contracts'; $('contract-search').focus(); } });
  document.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } });
  document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
  document.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; importFile(e.dataTransfer?.files[0]); });
  navigate(location.hash.slice(1));
  if (window.PROOFPATCH_RECEIPT) { try { load(window.PROOFPATCH_RECEIPT); } catch (e) { $('load-error').textContent = e.message; } }
  else fetch('./receipt.json').then(r => { if (!r.ok) throw new Error(''); return r.json(); }).then(load).catch(() => { $('load-error').textContent = 'No receipt found here. Run the demo or import your own JSON.'; });
})();
