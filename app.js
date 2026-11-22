/**
 * 세종 말뭉치 Word2Vec 2D 정적 웹 시각화 엔진 (서버리스 버전)
 * - 사전 계산된 data.json (40,892 단어, Top 10 유사도 & 2D PCA 좌표) 로드
 * - 브라우저 내 0.001초 실시간 검색 (정규식 지원) 및 2D 캔버스 인터랙션
 */

const state = {
  vocab: [],
  neighbors: [],
  wordToIdx: new Map(),
  baseWordMap: new Map(),
  
  center: null,
  currentNeighbors: [],
  
  scale: 1.0,
  panX: 0,
  panY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  hoveredNode: null,
  highlightedWord: null
};

// DOM 요소
const loadingOverlay = document.getElementById('loading-overlay');
const loadingStatus = document.getElementById('loading-status');
const canvas = document.getElementById('vector-canvas');
const ctx = canvas.getContext('2d');
const canvasWrapper = document.getElementById('canvas-wrapper');
const tooltip = document.getElementById('tooltip');

const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
const searchSubmitBtn = document.getElementById('search-submit-btn');
const autocompleteDropdown = document.getElementById('autocomplete-dropdown');
const quickChips = document.querySelectorAll('.chip');

const neighborsList = document.getElementById('neighbors-list');
const neighborsCount = document.getElementById('neighbors-count');
const statCenterWord = document.getElementById('stat-center-word');
const statVocab = document.getElementById('stat-vocab');

const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnResetView = document.getElementById('btn-reset-view');

// ============================================================================
// 1. 정적 JSON 데이터 로드 및 색인 구축
// ============================================================================
async function initApp() {
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    loadingStatus.textContent = '단어 색인을 구성하고 있습니다...';
    const data = await res.json();
    
    state.vocab = data.vocab;
    state.neighbors = data.neighbors;
    
    // 빠른 조회를 위한 해시맵 구축
    state.vocab.forEach((word, idx) => {
      state.wordToIdx.set(word, idx);
      
      const slashIdx = word.lastIndexOf('/');
      const base = slashIdx > -1 ? word.slice(0, slashIdx) : word;
      const cleanBase = base.split('__')[0];
      
      if (!state.baseWordMap.has(base)) state.baseWordMap.set(base, []);
      state.baseWordMap.get(base).push(idx);
      
      if (cleanBase !== base) {
        if (!state.baseWordMap.has(cleanBase)) state.baseWordMap.set(cleanBase, []);
        state.baseWordMap.get(cleanBase).push(idx);
      }
    });
    
    statVocab.innerHTML = `<i class="fa-solid fa-database"></i> ${state.vocab.length.toLocaleString()} 단어`;
    
    // 로딩 화면 숨김
    loadingOverlay.classList.add('fade-out');
    setTimeout(() => { loadingOverlay.style.display = 'none'; }, 350);
    
    resizeCanvas();
    // 초기 기본 단어 로드
    selectWord('세종/NNP');
    
  } catch (err) {
    loadingStatus.innerHTML = `<span style="color:#f43f5e;">데이터 로드 실패: ${err.message}<br>로컬 테스트 시 웹 서버(예: python -m http.server)를 통해 열어주세요.</span>`;
    console.error(err);
  }
}

// ============================================================================
// 2. 단어 검색 및 매칭 (정규식 지원)
// ============================================================================
function findMatchingIndices(query, limit = 30) {
  if (!query) return [];
  const q = query.trim();
  const matched = [];
  const seen = new Set();
  
  // 1) 완전 일치
  if (state.wordToIdx.has(q)) {
    const idx = state.wordToIdx.get(q);
    matched.push(idx);
    seen.add(idx);
  }
  
  // 2) 품사 태그 없는 기본 형태소 일치
  if (state.baseWordMap.has(q)) {
    for (const idx of state.baseWordMap.get(q)) {
      if (!seen.has(idx)) {
        matched.push(idx);
        seen.add(idx);
      }
    }
  }
  
  // 3) 정규식 검색
  try {
    const regex = new RegExp(q, 'i');
    for (let i = 0; i < state.vocab.length; i++) {
      if (seen.has(i)) continue;
      if (regex.test(state.vocab[i])) {
        matched.push(i);
        seen.add(i);
        if (matched.length >= limit) break;
      }
    }
  } catch (e) {
    // 정규식 문법 미완성 시 일반 부분 문자열 검색
    for (let i = 0; i < state.vocab.length; i++) {
      if (seen.has(i)) continue;
      if (state.vocab[i].includes(q)) {
        matched.push(i);
        seen.add(i);
        if (matched.length >= limit) break;
      }
    }
  }
  
  return matched.slice(0, limit);
}

function selectWord(query) {
  if (!query) return;
  hideTooltip();
  
  const matches = findMatchingIndices(query, 1);
  if (matches.length === 0) {
    alert(`'${query}'와 일치하는 단어를 사전에서 찾을 수 없습니다.`);
    return;
  }
  
  const targetIdx = matches[0];
  const targetWord = state.vocab[targetIdx];
  const rawNeighbors = state.neighbors[targetIdx];
  
  state.center = {
    word: targetWord,
    x: 0,
    y: 0,
    similarity: 1.0,
    is_center: true
  };
  
  state.currentNeighbors = rawNeighbors.map((item, i) => ({
    rank: i + 1,
    word: state.vocab[item[0]],
    similarity: item[1],
    distance: +(1.0 - item[1]).toFixed(4),
    x: item[2],
    y: item[3],
    is_center: false
  }));
  
  // 뷰 리셋
  state.scale = 1.0;
  state.panX = 0;
  state.panY = 0;
  
  statCenterWord.textContent = `중심: ${targetWord}`;
  searchInput.value = targetWord;
  searchClearBtn.classList.remove('hidden');
  
  render();
  renderNeighborsList(state.currentNeighbors);
}

// ============================================================================
// 3. 캔버스 2D 맵 렌더링
// ============================================================================
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvasWrapper.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  render();
}
window.addEventListener('resize', resizeCanvas);

function render() {
  const rect = canvasWrapper.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  
  ctx.clearRect(0, 0, width, height);
  
  const originX = width / 2 + state.panX;
  const originY = height / 2 + state.panY;
  
  drawBackgroundGrid(originX, originY, width, height);
  if (!state.center) return;
  
  // 연결선
  state.currentNeighbors.forEach(n => {
    const nx = originX + n.x * state.scale;
    const ny = originY + n.y * state.scale;
    const isHighlighted = (state.highlightedWord === n.word) || (state.hoveredNode === n);
    
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(nx, ny);
    
    if (isHighlighted) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
      ctx.lineWidth = 2.2;
    } else {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
      ctx.lineWidth = 1.2;
    }
    ctx.stroke();
  });
  
  // 이웃 노드 10개
  state.currentNeighbors.forEach(n => {
    const nx = originX + n.x * state.scale;
    const ny = originY + n.y * state.scale;
    const isHighlighted = (state.highlightedWord === n.word) || (state.hoveredNode === n);
    drawNeighborNode(n, nx, ny, isHighlighted);
  });
  
  // 중심 단어
  drawCenterNode(state.center, originX, originY);
}

function drawBackgroundGrid(ox, oy, w, h) {
  ctx.save();
  ctx.strokeStyle = 'rgba(48, 54, 61, 0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  
  ctx.beginPath();
  ctx.moveTo(ox, 0); ctx.lineTo(ox, h);
  ctx.moveTo(0, oy); ctx.lineTo(w, oy);
  ctx.stroke();
  
  [100, 200, 320].forEach(r => {
    ctx.beginPath();
    ctx.arc(ox, oy, r * state.scale, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();
}

function drawNeighborNode(n, x, y, isHighlighted) {
  ctx.save();
  const radius = isHighlighted ? 12 : 9;
  
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  
  if (isHighlighted) {
    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 16;
  } else if (n.rank <= 3) {
    ctx.fillStyle = '#34d399';
    ctx.shadowColor = '#34d399';
    ctx.shadowBlur = 8;
  } else {
    ctx.fillStyle = '#38bdf8';
  }
  ctx.fill();
  
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  
  const cleanWord = n.word.split('/')[0];
  ctx.font = isHighlighted
    ? "bold 14px 'Pretendard', 'Noto Sans KR', sans-serif"
    : "600 13px 'Pretendard', 'Noto Sans KR', sans-serif";
  
  const tw = ctx.measureText(cleanWord).width;
  const tx = x + radius + 8;
  const ty = y + 4;
  
  ctx.fillStyle = isHighlighted ? 'rgba(37, 99, 235, 0.92)' : 'rgba(22, 27, 34, 0.85)';
  ctx.beginPath();
  roundRect(ctx, tx - 5, ty - 14, tw + 10, 20, 5);
  ctx.fill();
  
  ctx.fillStyle = '#ffffff';
  ctx.fillText(cleanWord, tx, ty);
  ctx.restore();
}

function drawCenterNode(center, x, y) {
  ctx.save();
  const radius = 25;
  
  ctx.beginPath();
  ctx.arc(x, y, radius + 9, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(244, 63, 94, 0.4)';
  ctx.lineWidth = 3;
  ctx.stroke();
  
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  const grad = ctx.createRadialGradient(x, y, 2, x, y, radius);
  grad.addColorStop(0, '#fb7185');
  grad.addColorStop(1, '#f43f5e');
  ctx.fillStyle = grad;
  ctx.shadowColor = '#f43f5e';
  ctx.shadowBlur = 22;
  ctx.fill();
  
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  
  const cleanWord = center.word.split('/')[0];
  ctx.font = "bold 16px 'Pretendard', 'Noto Sans KR', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 4;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(cleanWord, x, y);
  
  ctx.font = "600 11px 'Pretendard', sans-serif";
  const tagText = "중심 단어";
  const tagW = ctx.measureText(tagText).width + 14;
  const tagH = 19;
  ctx.fillStyle = 'rgba(244, 63, 94, 0.92)';
  ctx.beginPath();
  roundRect(ctx, x - tagW / 2, y + radius + 10, tagW, tagH, 9);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(tagText, x, y + radius + 10 + tagH / 2);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

// ============================================================================
// 4. 캔버스 인터랙션 & 우측 목록 렌더링
// ============================================================================
canvasWrapper.addEventListener('mousedown', (e) => {
  state.isDragging = true;
  state.dragStartX = e.clientX - state.panX;
  state.dragStartY = e.clientY - state.panY;
});

window.addEventListener('mousemove', (e) => {
  if (state.isDragging) {
    state.panX = e.clientX - state.dragStartX;
    state.panY = e.clientY - state.dragStartY;
    render();
    return;
  }
  
  const rect = canvasWrapper.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const ox = rect.width / 2 + state.panX;
  const oy = rect.height / 2 + state.panY;
  
  let found = null;
  if (state.center && Math.hypot(mx - ox, my - oy) <= 30) {
    found = state.center;
  }
  if (!found) {
    for (const n of state.currentNeighbors) {
      const nx = ox + n.x * state.scale;
      const ny = oy + n.y * state.scale;
      if (Math.hypot(mx - nx, my - ny) <= 18) {
        found = n;
        break;
      }
    }
  }
  
  if (found !== state.hoveredNode) {
    state.hoveredNode = found;
    render();
    if (found) {
      showTooltip(e.clientX, e.clientY, found);
      canvasWrapper.style.cursor = 'pointer';
    } else {
      hideTooltip();
      canvasWrapper.style.cursor = 'grab';
    }
  } else if (found) {
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  }
});

window.addEventListener('mouseup', () => { state.isDragging = false; });

canvasWrapper.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  const nextScale = state.scale * factor;
  if (nextScale >= 0.35 && nextScale <= 3.5) {
    state.scale = nextScale;
    render();
  }
}, { passive: false });

canvasWrapper.addEventListener('click', () => {
  if (state.hoveredNode && !state.hoveredNode.is_center) {
    selectWord(state.hoveredNode.word);
  }
});

btnZoomIn.addEventListener('click', () => { if (state.scale < 3.0) { state.scale *= 1.2; render(); } });
btnZoomOut.addEventListener('click', () => { if (state.scale > 0.4) { state.scale /= 1.2; render(); } });
btnResetView.addEventListener('click', () => { state.scale = 1.0; state.panX = 0; state.panY = 0; render(); });

function showTooltip(cx, cy, node) {
  const [wordOnly, posTag = '형태소'] = node.word.split('/');
  let html = `<div class="tt-title"><span>${wordOnly}</span><span class="tt-tag">${posTag}</span></div>`;
  if (node.is_center) {
    html += `<div class="tt-row"><span>상태</span><span class="tt-val" style="color:#f43f5e;">중심 기준 단어</span></div>`;
  } else {
    html += `
      <div class="tt-row"><span>순위</span><span class="tt-val">${node.rank}위</span></div>
      <div class="tt-row"><span>코사인 유사도</span><span class="tt-val">${node.similarity.toFixed(4)}</span></div>
      <div class="tt-row"><span>벡터 거리</span><span class="tt-val">${node.distance.toFixed(4)}</span></div>
      <div style="margin-top:6px; font-size:11px; color:#38bdf8; text-align:center;">클릭 시 중심으로 전환</div>
    `;
  }
  tooltip.innerHTML = html;
  tooltip.classList.remove('hidden');
  tooltip.style.left = `${cx + 14}px`;
  tooltip.style.top = `${cy + 14}px`;
}

function hideTooltip() { tooltip.classList.add('hidden'); }

function renderNeighborsList(neighbors) {
  neighborsCount.textContent = `${neighbors.length} / 10`;
  let html = '';
  neighbors.forEach(item => {
    const [wordOnly, posTag = ''] = item.word.split('/');
    const simPercent = Math.max(5, Math.min(100, Math.round(item.similarity * 100)));
    html += `
      <div class="neighbor-item" data-word="${item.word}">
        <div class="item-rank">${item.rank}</div>
        <div class="item-content">
          <span class="item-name" title="${item.word}">${wordOnly}</span>
          ${posTag ? `<span class="item-pos-badge">${posTag}</span>` : ''}
        </div>
        <div class="item-metrics">
          <span class="item-dist" title="코사인 유사도">${item.similarity.toFixed(4)}</span>
          <div class="sim-bar-bg"><div class="sim-bar-fill" style="width:${simPercent}%;"></div></div>
        </div>
      </div>
    `;
  });
  neighborsList.innerHTML = html;
  
  neighborsList.querySelectorAll('.neighbor-item').forEach(el => {
    const word = el.getAttribute('data-word');
    el.addEventListener('mouseenter', () => { state.highlightedWord = word; el.classList.add('highlighted'); render(); });
    el.addEventListener('mouseleave', () => { state.highlightedWord = null; el.classList.remove('highlighted'); render(); });
    el.addEventListener('click', () => { selectWord(word); });
  });
}

// ============================================================================
// 5. 검색창 및 자동완성 이벤트
// ============================================================================
searchInput.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (q.length > 0) {
    searchClearBtn.classList.remove('hidden');
    const matches = findMatchingIndices(q, 20);
    if (matches.length > 0) {
      let html = '';
      matches.forEach(idx => {
        const w = state.vocab[idx];
        const [wordOnly, posTag = ''] = w.split('/');
        html += `<div class="autocomplete-item" data-word="${w}"><span class="item-word">${wordOnly}</span>${posTag ? `<span class="item-tag">${posTag}</span>` : ''}</div>`;
      });
      autocompleteDropdown.innerHTML = html;
      autocompleteDropdown.classList.remove('hidden');
      autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => {
          const sel = item.getAttribute('data-word');
          autocompleteDropdown.classList.add('hidden');
          selectWord(sel);
        });
      });
    } else {
      autocompleteDropdown.classList.add('hidden');
    }
  } else {
    searchClearBtn.classList.add('hidden');
    autocompleteDropdown.classList.add('hidden');
  }
});

document.addEventListener('click', (e) => {
  if (!searchInput.contains(e.target) && !autocompleteDropdown.contains(e.target)) {
    autocompleteDropdown.classList.add('hidden');
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    autocompleteDropdown.classList.add('hidden');
    selectWord(searchInput.value.trim());
  } else if (e.key === 'Escape') {
    autocompleteDropdown.classList.add('hidden');
  }
});

searchSubmitBtn.addEventListener('click', () => {
  autocompleteDropdown.classList.add('hidden');
  selectWord(searchInput.value.trim());
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  autocompleteDropdown.classList.add('hidden');
  searchInput.focus();
});

quickChips.forEach(chip => {
  chip.addEventListener('click', () => {
    selectWord(chip.getAttribute('data-query'));
  });
});

window.addEventListener('DOMContentLoaded', initApp);
