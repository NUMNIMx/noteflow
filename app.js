/* ============================================================
   110811 Room Note — app.js (Full Application Logic)
   ============================================================ */
'use strict';

import { auth, db } from './firebase-config.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

// ====== STATE ======
let currentUser = null;
let cloudSyncTimeout = null;
let isSyncing = false;

let state = {
  notebooks: [],   // { id, name, createdAt }
  notes: [],       // { id, title, body, notebookId, tags:[], color, pinned, locked, pin, createdAt, updatedAt, trashed, history:[] }
  settings: {
    theme: 'dark',
    sort: 'newest',
    activeNoteId: null,
    activeNotebookId: null,
    filterTag: null,
    viewTrash: false,
    gridView: false,
    focusMode: false,
  }
};

let saveDebounce = null;
let savedRange = null;      // for link insert
let isFocusMode = false;    // focus mode state
let pinEntry = '';          // current PIN entry
let pinTarget = null;       // 'unlock' or callback
let linkSuggestActive = false; // [[note link mode
let linkSuggestQuery = '';  // current typed query after [[
let linkSuggestIndex = 0;   // selected item index
let historyAutoSaveTimer = null;

// ====== STORAGE ======
function loadState() {
  try {
    const s = localStorage.getItem('noteflow_state');
    if (s) state = JSON.parse(s);
    // Ensure arrays exist (safety)
    state.notebooks = state.notebooks || [];
    state.notes = state.notes || [];
    state.settings = state.settings || {};
    state.settings.sort = state.settings.sort || 'newest';
  } catch (e) { /* fresh start */ }
}

function saveState(skipCloud = false) {
  try { localStorage.setItem('noteflow_state', JSON.stringify(state)); } catch (e) { }

  // Trigger Firebase Sync with Debounce (only if logged in)
  if (!skipCloud && currentUser) {
    clearTimeout(cloudSyncTimeout);
    const syncEl = document.getElementById('cloudSyncStatus');
    if (syncEl) syncEl.innerHTML = `<i class="fa-solid fa-arrows-rotate fa-spin"></i> กำลังรอซิงค์...`;

    cloudSyncTimeout = setTimeout(async () => {
      if (!currentUser) return; // Double-check in case logged out during debounce
      try {
        isSyncing = true;
        if (syncEl) syncEl.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> กำลังอัปโหลด...`;

        // Timeout protection: abort if Firestore takes > 10s
        const syncPromise = setDoc(doc(db, "users", currentUser.uid), {
          stateStr: JSON.stringify(state),
          updatedAt: Date.now()
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), 10000)
        );
        await Promise.race([syncPromise, timeoutPromise]);

        const now = new Date();
        const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        if (syncEl) syncEl.innerHTML = `<i class="fa-solid fa-cloud" style="color:#20c997"></i> ซิงค์ล่าสุด ${timeStr}`;
      } catch (err) {
        console.error("Cloud Sync Error:", err);
        let errMsg = 'ซิงค์ล้มเหลว';
        if (err.message === 'TIMEOUT') errMsg = 'Firestore ไม่ตอบสนอง — ยังไม่ได้สร้าง Database?';
        else if (err.message && err.message.includes('PERMISSION_DENIED')) errMsg = 'ไม่มีสิทธิ์เขียน Firestore';
        else if (err.message && err.message.includes('NOT_FOUND')) errMsg = 'ยังไม่ได้สร้าง Firestore Database';
        if (syncEl) syncEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#ff6b6b"></i> ${errMsg}`;
      } finally {
        isSyncing = false;
      }
    }, 2000); // 2-second debounce
  }
}

async function syncFromCloud() {
  if (!currentUser) return;
  const syncEl = document.getElementById('cloudSyncStatus');
  try {
    if (syncEl) syncEl.innerHTML = `<i class="fa-solid fa-cloud-arrow-down fa-bounce"></i> โหลดข้อมูลจาก Cloud...`;

    // Timeout protection
    const fetchPromise = getDoc(doc(db, "users", currentUser.uid));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), 10000)
    );
    const docSnap = await Promise.race([fetchPromise, timeoutPromise]);

    if (docSnap.exists()) {
      const cloudData = docSnap.data();
      if (cloudData.stateStr) {
        const cloudState = JSON.parse(cloudData.stateStr);
        state = { ...state, ...cloudState };
        saveState(true); // Save local but don't re-upload
        renderAll();
        toast('ซิงค์ข้อมูลจาก Cloud สำเร็จ', 'success');
      }
    } else {
      // First time cloud user, upload local data
      saveState();
    }
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    if (syncEl) syncEl.innerHTML = `<i class="fa-solid fa-cloud" style="color:#20c997"></i> เชื่อมต่อ Cloud ${timeStr}`;
  } catch (err) {
    console.error("Error fetching from cloud:", err);
    let errMsg = 'ไม่สามารถซิงค์ข้อมูลจาก Cloud ได้';
    if (err.message === 'TIMEOUT') errMsg = 'Firestore ไม่ตอบสนอง — กรุณาสร้าง Firestore Database';
    toast(errMsg, 'error');
    if (syncEl) syncEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#ff6b6b"></i> ${errMsg}`;
  }
}

// ====== ID / DATE UTILS ======
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}
function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'เมื่อกี้';
  if (diff < 3600) return Math.floor(diff / 60) + ' นาทีที่แล้ว';
  if (diff < 86400) return Math.floor(diff / 3600) + ' ชั่วโมงที่แล้ว';
  if (diff < 604800) return Math.floor(diff / 86400) + ' วันที่แล้ว';
  return d.toLocaleDateString('th-TH', { month: 'short', day: 'numeric' });
}

// ====== TOAST ======
function toast(msg, type = 'info', icon = null) {
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info', warning: 'fa-triangle-exclamation' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${icon || icons[type]}"></i><span>${msg}</span>`;
  toastContainer.prepend(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

// ====== WORD COUNT ======
function updateWordCount() {
  const text = noteEditor.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  wordCount.textContent = words + ' คำ';
  charCount.textContent = text.replace(/\n/g, '').length + ' ตัวอักษร';
}

// ====== GET ACTIVE NOTE ======
function getActiveNote() {
  if (!state.settings.activeNoteId) return null;
  return state.notes.find(n => n.id === state.settings.activeNoteId) || null;
}

// ====== RENDER SIDEBAR ======
function renderSidebar() {
  // Notebooks
  notebookList.innerHTML = '';

  // "All" item
  const allItem = document.createElement('li');
  allItem.className = 'notebook-item' + (!state.settings.activeNotebookId && !state.settings.viewTrash ? ' active' : '');
  const allCount = state.notes.filter(n => !n.trashed).length;
  allItem.innerHTML = `<i class="fa-solid fa-inbox"></i><span>ทั้งหมด</span><span class="nb-count">${allCount}</span>`;
  allItem.addEventListener('click', () => {
    state.settings.activeNotebookId = null;
    state.settings.filterTag = null;
    state.settings.viewTrash = false;
    saveState();
    renderAll();
  });
  notebookList.appendChild(allItem);

  state.notebooks.forEach(nb => {
    const count = state.notes.filter(n => n.notebookId === nb.id && !n.trashed).length;
    const li = document.createElement('li');
    li.className = 'notebook-item' + (state.settings.activeNotebookId === nb.id ? ' active' : '');
    li.innerHTML = `
      <i class="fa-solid fa-folder"></i>
      <span>${escHtml(nb.name)}</span>
      <span class="nb-count">${count}</span>
      <button class="notebook-delete-btn" title="ลบสมุดโน้ต"><i class="fa-solid fa-xmark"></i></button>
    `;
    li.querySelector('.notebook-delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      confirmAction('ลบสมุดโน้ต', `ลบ "${nb.name}" หรือไม่? โน้ตในสมุดนี้จะไม่ถูกลบ`, () => {
        state.notes.forEach(n => { if (n.notebookId === nb.id) n.notebookId = null; });
        state.notebooks = state.notebooks.filter(n => n.id !== nb.id);
        if (state.settings.activeNotebookId === nb.id) state.settings.activeNotebookId = null;
        saveState(); renderAll(); toast('ลบสมุดโน้ตแล้ว', 'success');
      });
    });
    li.addEventListener('click', (e) => {
      if (e.target.closest('.notebook-delete-btn')) return;
      state.settings.activeNotebookId = nb.id;
      state.settings.filterTag = null;
      state.settings.viewTrash = false;
      saveState(); renderAll();
    });
    notebookList.appendChild(li);
  });

  // Tag Cloud
  const allTags = [...new Set(state.notes.filter(n => !n.trashed).flatMap(n => n.tags || []))].sort();
  tagCloud.innerHTML = '';
  if (allTags.length === 0) {
    tagCloud.innerHTML = '<span style="font-size:0.75rem;color:var(--text-muted);">ยังไม่มีแท็ก</span>';
  }
  allTags.forEach(tag => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip' + (state.settings.filterTag === tag ? ' active' : '');
    chip.textContent = '#' + tag;
    chip.addEventListener('click', () => {
      if (state.settings.filterTag === tag) {
        state.settings.filterTag = null;
      } else {
        state.settings.filterTag = tag;
        state.settings.activeNotebookId = null;
        state.settings.viewTrash = false;
      }
      saveState(); renderAll();
    });
    tagCloud.appendChild(chip);
  });

  // Trash count
  const trashedCount = state.notes.filter(n => n.trashed).length;
  trashCount.textContent = trashedCount;

  // Stats
  totalNotes.textContent = state.notes.filter(n => !n.trashed).length;
  if (totalNotebooks) totalNotebooks.textContent = state.notebooks.length;
}

// ====== FILTER & SORT NOTES ======
function getFilteredNotes() {
  const q = searchInput.value.trim().toLowerCase();
  let notes = state.notes.filter(n => {
    if (state.settings.viewTrash) return n.trashed;
    if (n.trashed) return false;
    if (state.settings.activeNotebookId && n.notebookId !== state.settings.activeNotebookId) return false;
    if (state.settings.filterTag && !(n.tags || []).includes(state.settings.filterTag)) return false;
    if (q) {
      const title = (n.title || '').toLowerCase();
      const body = (n.body || '').replace(/<[^>]*>/g, '').toLowerCase();
      if (!title.includes(q) && !body.includes(q)) return false;
    }
    return true;
  });

  const sort = state.settings.sort;
  notes.sort((a, b) => {
    if (sort === 'pinned') {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
    }
    if (sort === 'az') return (a.title || '').localeCompare(b.title || '', 'th');
    if (sort === 'oldest') return a.createdAt - b.createdAt;
    return b.updatedAt - a.updatedAt; // newest (default)
  });
  // Always float pinned
  if (sort !== 'pinned') {
    notes.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }
  return notes;
}

// ====== RENDER NOTE LIST ======
function renderNoteList() {
  const notes = getFilteredNotes();
  noteList.innerHTML = '';

  // Panel title
  if (state.settings.viewTrash) {
    panelTitle.textContent = 'ถังขยะ';
  } else if (state.settings.filterTag) {
    panelTitle.textContent = '#' + state.settings.filterTag;
  } else if (state.settings.activeNotebookId) {
    const nb = state.notebooks.find(n => n.id === state.settings.activeNotebookId);
    panelTitle.textContent = nb ? nb.name : 'โน้ตทั้งหมด';
  } else if (searchInput.value.trim()) {
    panelTitle.textContent = 'ผลการค้นหา';
  } else {
    panelTitle.textContent = 'โน้ตทั้งหมด';
  }

  // Active filter bar
  if (state.settings.filterTag) {
    activeFilter.classList.remove('hidden');
    filterLabel.textContent = 'แท็ก: #' + state.settings.filterTag;
  } else if (state.settings.activeNotebookId) {
    const nb = state.notebooks.find(n => n.id === state.settings.activeNotebookId);
    activeFilter.classList.remove('hidden');
    filterLabel.textContent = 'สมุด: ' + (nb ? nb.name : '');
  } else {
    activeFilter.classList.add('hidden');
  }

  // Grid view
  noteList.className = 'note-list' + (state.settings.gridView ? ' grid' : '');

  if (notes.length === 0) {
    noteListEmpty.classList.remove('hidden');
  } else {
    noteListEmpty.classList.add('hidden');
    notes.forEach(note => {
      const card = document.createElement('div');
      card.className = 'note-card';
      card.dataset.id = note.id;
      if (note.color && note.color !== 'default') card.dataset.color = note.color;
      if (state.settings.activeNoteId === note.id) card.classList.add('active');

      const bodyText = (note.body || '').replace(/<[^>]*>/g, '').slice(0, 120);
      const tagsHtml = (note.tags || []).slice(0, 3).map(t => `<span class="note-mini-tag">#${escHtml(t)}</span>`).join('');

      card.innerHTML = `
        <div class="note-card-header">
          <div class="note-card-title">${escHtml(note.title || 'โน้ตไม่มีชื่อ')}</div>
          ${note.pinned ? '<i class="fa-solid fa-thumbtack note-card-pin"></i>' : ''}
        </div>
        <div class="note-card-body">${escHtml(bodyText) || '<em style="color:var(--text-muted)">ไม่มีเนื้อหา</em>'}</div>
        <div class="note-card-footer">
          <span class="note-card-date">${shortDate(note.updatedAt)}</span>
          <div class="note-card-tags">${tagsHtml}</div>
        </div>
      `;
      card.addEventListener('click', () => openNote(note.id));
      noteList.appendChild(card);
    });
  }
}

// ====== RENDER NOTEBOOK SELECT ======
function renderNotebookSelect() {
  notebookSelect.innerHTML = '<option value="">ไม่มีสมุดโน้ต</option>';
  state.notebooks.forEach(nb => {
    const opt = document.createElement('option');
    opt.value = nb.id;
    opt.textContent = nb.name;
    notebookSelect.appendChild(opt);
  });
}

// ====== OPEN NOTE ======
function openNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;

  state.settings.activeNoteId = id;
  saveState();

  // Editor visibility
  editorEmptyState.classList.add('hidden');
  editorToolbar.style.display = 'flex';
  editorContentWrapper.style.display = 'flex';

  // Populate
  noteTitleInput.value = note.title || '';
  noteEditor.innerHTML = note.body || '';
  notebookSelect.value = note.notebookId || '';
  renderTagPills(note.tags || []);
  updatePinBtn(note.pinned);
  updateColorSwatch(note.color);
  updateWordCount();
  updateTimestamps(note);
  setSaveStatus('saved');
  hideLinkSuggest();

  // Feature: Lock
  if (typeof updateLockBtn === 'function') updateLockBtn(!!note.locked);
  if (note.locked) {
    openLockOverlay(note);
  } else {
    lockOverlay?.classList.add('hidden');
    noteEditor.contentEditable = 'true';
  }

  // Feature: Rewire todo checkboxes
  setTimeout(rewireCheckboxes, 100);

  // Highlight in list
  document.querySelectorAll('.note-card').forEach(c => {
    c.classList.toggle('active', c.dataset.id === id);
  });

  noteEditor.focus();
}


function showEmptyEditor() {
  state.settings.activeNoteId = null;
  saveState();
  editorEmptyState.classList.remove('hidden');
  editorToolbar.style.display = 'none';
  editorContentWrapper.style.display = 'none';
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('active'));
}

// ====== CREATE NOTE ======
function createNote() {
  const now = Date.now();
  const note = {
    id: genId(),
    title: '',
    body: '',
    notebookId: state.settings.activeNotebookId || null,
    tags: [],
    color: 'default',
    pinned: false,
    createdAt: now,
    updatedAt: now,
    trashed: false,
  };
  state.notes.unshift(note);
  state.settings.activeNoteId = note.id;
  state.settings.viewTrash = false;
  saveState();
  renderAll();
  openNote(note.id);
  noteTitleInput.focus();
  toast('สร้างโน้ตใหม่แล้ว', 'success');
}

// ====== AUTO SAVE ======
function triggerAutoSave() {
  setSaveStatus('saving');
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => {
    const note = getActiveNote();
    if (!note) return;
    note.title = noteTitleInput.value.trim() || '';
    note.body = noteEditor.innerHTML;
    note.notebookId = notebookSelect.value || null;
    note.updatedAt = Date.now();
    saveState();
    renderNoteList();
    renderSidebar();
    updateTimestamps(note);
    setSaveStatus('saved');
  }, 400);
}

function setSaveStatus(status) {
  saveStatus.className = 'save-status';
  if (status === 'saving') {
    saveStatus.classList.add('saving');
    saveStatus.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังบันทึก...';
  } else {
    saveStatus.classList.add('saved');
    saveStatus.innerHTML = '<i class="fa-solid fa-circle-check"></i> บันทึกแล้ว';
  }
}

function updateTimestamps(note) {
  noteCreatedAt.textContent = 'สร้าง: ' + fmtDate(note.createdAt);
  noteUpdatedAt.textContent = 'แก้ไข: ' + fmtDate(note.updatedAt);
}

// ====== TAGS ======
function renderTagPills(tags) {
  tagsDisplay.innerHTML = '';
  tags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `${escHtml(tag)}<span class="tag-pill-remove" data-tag="${escHtml(tag)}"><i class="fa-solid fa-xmark"></i></span>`;
    pill.querySelector('.tag-pill-remove').addEventListener('click', () => removeTag(tag));
    tagsDisplay.appendChild(pill);
  });
}

function addTag(tag) {
  tag = tag.trim().toLowerCase().replace(/\s+/g, '-');
  if (!tag) return;
  const note = getActiveNote();
  if (!note) return;
  note.tags = note.tags || [];
  if (note.tags.includes(tag)) return;
  note.tags.push(tag);
  note.updatedAt = Date.now();
  saveState();
  renderTagPills(note.tags);
  renderSidebar();
  renderNoteList();
}

function removeTag(tag) {
  const note = getActiveNote();
  if (!note) return;
  note.tags = (note.tags || []).filter(t => t !== tag);
  note.updatedAt = Date.now();
  saveState();
  renderTagPills(note.tags);
  renderSidebar();
  renderNoteList();
}

// ====== PIN ======
function togglePin() {
  const note = getActiveNote();
  if (!note) return;
  note.pinned = !note.pinned;
  note.updatedAt = Date.now();
  saveState();
  updatePinBtn(note.pinned);
  renderNoteList();
  toast(note.pinned ? 'ปักหมุดโน้ตแล้ว' : 'เลิกปักหมุดแล้ว', 'info');
}

function updatePinBtn(pinned) {
  pinBtn.classList.toggle('pinned', !!pinned);
  pinBtn.title = pinned ? 'เลิกปักหมุด' : 'ปักหมุด';
}

// ====== COLOR ======
function setNoteColor(color) {
  const note = getActiveNote();
  if (!note) return;
  note.color = color;
  note.updatedAt = Date.now();
  saveState();
  updateColorSwatch(color);
  renderNoteList();
  colorPicker.classList.add('hidden');
}

function updateColorSwatch(color) {
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === (color || 'default'));
  });
}

// ====== DELETE / TRASH ======
function trashNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  note.trashed = true;
  note.updatedAt = Date.now();
  if (state.settings.activeNoteId === id) {
    state.settings.activeNoteId = null;
    showEmptyEditor();
  }
  saveState(); renderAll();
  toast('ย้ายไปถังขยะแล้ว', 'warning', 'fa-trash');
}

function restoreNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  note.trashed = false;
  note.updatedAt = Date.now();
  saveState(); renderAll(); renderTrashList();
  toast('กู้คืนโน้ตแล้ว', 'success');
}

function permanentlyDeleteNote(id) {
  state.notes = state.notes.filter(n => n.id !== id);
  saveState(); renderAll(); renderTrashList();
  toast('ลบถาวรแล้ว', 'error');
}

function emptyTrash() {
  state.notes = state.notes.filter(n => !n.trashed);
  saveState(); renderAll(); renderTrashList();
  toast('ล้างถังขยะแล้ว', 'success');
}

// ====== TRASH MODAL ======
function renderTrashList() {
  const trashed = state.notes.filter(n => n.trashed);
  trashList.innerHTML = '';
  if (trashed.length === 0) {
    trashList.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">ถังขยะว่างเปล่า</p>';
    return;
  }
  trashed.forEach(note => {
    const item = document.createElement('div');
    item.className = 'trash-item';
    item.innerHTML = `
      <span class="trash-item-title">${escHtml(note.title || 'โน้ตไม่มีชื่อ')}</span>
      <span class="trash-item-date">${shortDate(note.updatedAt)}</span>
      <div class="trash-item-actions">
        <button class="restore-btn" title="กู้คืน"><i class="fa-solid fa-rotate-left"></i> กู้คืน</button>
        <button class="perm-delete-btn" title="ลบถาวร"><i class="fa-solid fa-fire"></i> ลบถาวร</button>
      </div>
    `;
    item.querySelector('.restore-btn').addEventListener('click', () => restoreNote(note.id));
    item.querySelector('.perm-delete-btn').addEventListener('click', () => {
      confirmAction('ลบถาวร', `ลบ "${note.title || 'โน้ตไม่มีชื่อ'}" ถาวรหรือไม่? ไม่สามารถกู้คืนได้`, () => permanentlyDeleteNote(note.id));
    });
    trashList.appendChild(item);
  });
}

// ====== EXPORT ======
function exportNote(fmt) {
  const note = getActiveNote();
  if (!note) return;
  const title = note.title || 'noteflow-export';
  let content = '';
  if (fmt === 'md') {
    const bodyText = (note.body || '').replace(/<br\s*\/?>/gi, '\n')
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
      .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
      .replace(/<u[^>]*>(.*?)<\/u>/gi, '__$1__')
      .replace(/<s[^>]*>(.*?)<\/s>/gi, '~~$1~~')
      .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '> $1\n')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
    const tags = (note.tags || []).map(t => '#' + t).join(' ');
    content = `---\ntitle: ${title}\ndate: ${new Date(note.createdAt).toISOString()}\ntags: ${tags}\n---\n\n# ${title}\n\n${bodyText.trim()}`;
  } else {
    content = `${title}\n${'='.repeat(title.length)}\n\nสร้าง: ${fmtDate(note.createdAt)}\nแก้ไข: ${fmtDate(note.updatedAt)}\nแท็ก: ${(note.tags || []).join(', ')}\n\n` + (note.body || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  }
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${title.replace(/[^a-z0-9\u0E00-\u0E7F]/gi, '_')}.${fmt}`;
  a.click(); URL.revokeObjectURL(url);
  toast(`ส่งออกเป็น .${fmt} แล้ว`, 'success');
  exportMenu.classList.add('hidden');
}

// ====== RICH TEXT (execCommand) ======
function execCmd(cmd, val = null) {
  noteEditor.focus();
  document.execCommand(cmd, false, val);
}

function insertCodeBlock() {
  const sel = window.getSelection();
  const selectedText = sel ? sel.toString() : '';
  const code = document.createElement('pre');
  const c = document.createElement('code');
  c.textContent = selectedText || 'code here';
  code.appendChild(c);
  execCmd('insertHTML', code.outerHTML);
}

function insertLink() {
  // Save selection range
  const sel = window.getSelection();
  if (sel && sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
  linkText.value = sel ? sel.toString() : '';
  linkUrl.value = '';
  linkModal.classList.remove('hidden');
  linkUrl.focus();
}

function confirmInsertLink() {
  const url = linkUrl.value.trim();
  const text = linkText.value.trim() || url;
  if (!url) { toast('กรุณากรอก URL', 'error'); return; }
  // Restore selection
  if (savedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
  execCmd('insertHTML', `<a href="${escAttr(url)}" target="_blank" rel="noopener">${escHtml(text)}</a>`);
  linkModal.classList.add('hidden');
}

// ====== CONFIRM DIALOG ======
function confirmAction(title, message, onConfirm) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmModal.classList.remove('hidden');
  const handler = () => {
    onConfirm();
    confirmModal.classList.add('hidden');
    doConfirm.removeEventListener('click', handler);
  };
  doConfirm.addEventListener('click', handler);
}

// ====== THEME ======
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = themeToggle.querySelector('i');
  icon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme(state.settings.theme);
  saveState();
}

// ====== RENDER ALL ======
function renderAll() {
  renderSidebar();
  renderNoteList();
  renderNotebookSelect();
}

// ====== ESCAPE UTILS ======
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// FEATURE 1: MARKDOWN LIVE SHORTCUTS
// ============================================================
function handleMarkdownShortcuts(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;

  const text = node.textContent.slice(0, range.startOffset);
  const trimmed = text.trim();

  // Only trigger on Enter (except for inline shortcuts on Space)
  if (e.key === 'Enter') {
    const patterns = [
      { re: /^(?:#+\s)?#\s$/, cmd: 'formatBlock', val: 'h1' },
      { re: /^(?:#+\s)?#{2}\s$/, cmd: 'formatBlock', val: 'h2' },
      { re: /^(?:#+\s)?#{3}\s$/, cmd: 'formatBlock', val: 'h3' },
      { re: /^[-*]\s$/, cmd: 'list', val: 'ul' },
      { re: /^\d+\.\s$/, cmd: 'list', val: 'ol' },
      { re: /^>\s$/, cmd: 'formatBlock', val: 'blockquote' },
      { re: /^```$/, cmd: 'code', val: null },
      { re: /^---$/, cmd: 'hr', val: null },
    ];

    for (const p of patterns) {
      if (p.re.test(trimmed) || p.re.test(text)) {
        e.preventDefault();
        // Clear the text prefix
        const delRange = document.createRange();
        delRange.setStart(node, 0);
        delRange.setEnd(node, range.startOffset);
        sel.removeAllRanges();
        sel.addRange(delRange);
        document.execCommand('delete', false);

        if (p.cmd === 'formatBlock') {
          document.execCommand('formatBlock', false, p.val);
        } else if (p.cmd === 'list') {
          if (p.val === 'ul') document.execCommand('insertUnorderedList', false);
          else document.execCommand('insertOrderedList', false);
        } else if (p.cmd === 'code') {
          insertCodeBlock();
        } else if (p.cmd === 'hr') {
          document.execCommand('insertHorizontalRule', false);
        }
        triggerAutoSave();
        return;
      }
    }
  }
}

// ============================================================
// FEATURE 2: CHECKLIST / TO-DO
// ============================================================
function insertTodoItem() {
  const id = genId();
  const html = `<div class="todo-item" contenteditable="false"><input type="checkbox" id="todo-${id}" contenteditable="false"><span class="todo-text" contenteditable="true"> </span></div><p></p>`;
  execCmd('insertHTML', html);
  // Wire up checkbox
  setTimeout(() => {
    document.getElementById(`todo-${id}`)?.addEventListener('change', (e) => {
      triggerAutoSave();
    });
    // focus the text span
    const span = document.querySelector(`#todo-${id}`)?.nextElementSibling;
    if (span) {
      const r = document.createRange();
      r.selectNodeContents(span);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  }, 50);
}

// Re-wire checkboxes after note load
function rewireCheckboxes() {
  noteEditor.querySelectorAll('.todo-item input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => triggerAutoSave());
  });
}

// ============================================================
// FEATURE 3: FOCUS MODE
// ============================================================
function toggleFocusMode() {
  isFocusMode = !isFocusMode;
  document.body.classList.toggle('focus-mode', isFocusMode);
  focusBtn.classList.toggle('active', isFocusMode);
  focusBtn.querySelector('i').className = isFocusMode ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
  focusExitHint.classList.toggle('hidden', !isFocusMode);
  toast(isFocusMode ? 'Focus Mode เปิดแล้ว — hover เพื่อดู toolbar' : 'ออกจาก Focus Mode', 'info');
}

// ============================================================
// FEATURE 4: IMAGE PASTE / DRAG / UPLOAD
// ============================================================
function insertImageDataUrl(dataUrl) {
  execCmd('insertHTML', `<img src="${dataUrl}" alt="image" style="max-width:100%">`);
  triggerAutoSave();
  toast('แทรกรูปภาพสำเร็จ', 'success');
}

function handleImagePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = ev => insertImageDataUrl(ev.target.result);
      reader.readAsDataURL(file);
      break;
    }
  }
}

function handleImageDrop(e) {
  e.preventDefault();
  noteEditor.classList.remove('editor-drag-active');
  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = ev => insertImageDataUrl(ev.target.result);
      reader.readAsDataURL(file);
      break;
    }
  }
}

function handleImageUpload(file) {
  if (!file || !file.type.startsWith('image/')) { toast('กรุณาเลือกไฟล์รูปภาพ', 'error'); return; }
  const reader = new FileReader();
  reader.onload = ev => insertImageDataUrl(ev.target.result);
  reader.readAsDataURL(file);
}

// ============================================================
// FEATURE 5: NOTE LOCKING (PIN)
// ============================================================
function updateLockBtn(locked) {
  lockBtn.classList.toggle('locked', !!locked);
  lockBtn.title = locked ? 'ปลดล็อกโน้ต' : 'ล็อกโน้ต';
  lockBtn.querySelector('i').className = locked ? 'fa-solid fa-lock' : 'fa-solid fa-lock-open';
}

function openLockOverlay(note) {
  lockOverlay.classList.remove('hidden');
  noteEditor.contentEditable = 'false';
  pinEntry = '';
  updatePinDots();
  pinError.classList.add('hidden');
  pinTarget = 'unlock';
  currentUnlockNote = note;
}

function closeLockOverlay() {
  lockOverlay.classList.add('hidden');
  noteEditor.contentEditable = 'true';
  pinEntry = '';
  currentUnlockNote = null;
}

let currentUnlockNote = null;

function handlePinKey(val) {
  if (val === 'clear') {
    pinEntry = pinEntry.slice(0, -1);
    updatePinDots();
    return;
  }
  if (val === 'cancel') {
    closeLockOverlay();
    return;
  }
  if (pinEntry.length >= 4) return;
  pinEntry += val;
  updatePinDots();
  if (pinEntry.length === 4) {
    setTimeout(checkPin, 200);
  }
}

function checkPin() {
  const note = currentUnlockNote;
  if (!note) return;
  if (pinEntry === note.pin) {
    closeLockOverlay();
    pinError.classList.add('hidden');
    toast('ปลดล็อกสำเร็จ', 'success');
  } else {
    pinError.classList.remove('hidden');
    pinEntry = '';
    updatePinDots();
    // shake animation
    pinError.style.animation = 'none';
    setTimeout(() => pinError.style.animation = '', 10);
  }
}

function updatePinDots() {
  document.querySelectorAll('.pin-dots .dot').forEach((dot, i) => {
    dot.classList.toggle('filled', i < pinEntry.length);
  });
}

function toggleNoteLock() {
  const note = getActiveNote();
  if (!note) return;
  if (note.locked) {
    // unlock: ask for PIN
    openLockOverlay(note);
    // override checkPin to unlock
    pinTarget = 'unlock-and-clear';
    currentUnlockNote = note;
  } else {
    // lock: ask for PIN setup
    setPinModal.classList.remove('hidden');
    setPinInput.value = '';
    confirmPinInput.value = '';
    setPinInput.focus();
  }
}

function lockNoteWithPin(pin) {
  const note = getActiveNote();
  if (!note) return;
  note.locked = true;
  note.pin = pin;
  note.updatedAt = Date.now();
  saveState();
  updateLockBtn(true);
  openLockOverlay(note);
  pinTarget = 'unlock';
  toast('ล็อกโน้ตแล้ว', 'warning', 'fa-lock');
}

// ============================================================
// FEATURE 6: VERSION HISTORY
// ============================================================
function saveHistory() {
  const note = getActiveNote();
  if (!note) return;
  note.history = note.history || [];
  // Don't save duplicate consecutive bodies
  const last = note.history[note.history.length - 1];
  if (last && last.body === note.body && last.title === note.title) return;
  note.history.push({ title: note.title, body: note.body, savedAt: Date.now() });
  // Keep only last 20 snapshots
  if (note.history.length > 20) note.history.shift();
}

function showHistoryModal() {
  const note = getActiveNote();
  if (!note) { toast('เลือกโน้ตก่อน', 'error'); return; }
  const history = note.history || [];
  historyList.innerHTML = '';
  if (history.length === 0) {
    historyList.innerHTML = '<div class="history-empty"><i class="fa-solid fa-clock"></i><br>ยังไม่มีประวัติ — บันทึกโน้ตก่อน (Ctrl+S)</div>';
  } else {
    [...history].reverse().forEach((snap, idx) => {
      const realIdx = history.length - 1 - idx;
      const preview = snap.body.replace(/<[^>]*>/g, '').slice(0, 80);
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-item-info">
          <div class="history-item-time">${fmtDate(snap.savedAt)}</div>
          <div class="history-item-preview">${escHtml(snap.title || 'ไม่มีชื่อ')} — ${escHtml(preview)}</div>
        </div>
        <button class="history-restore-btn">กู้คืน</button>
      `;
      item.querySelector('.history-restore-btn').addEventListener('click', () => {
        confirmAction('กู้คืน Snapshot', 'จะแทนที่เนื้อหาปัจจุบันด้วย snapshot นี้?', () => {
          note.title = snap.title || '';
          note.body = snap.body;
          note.updatedAt = Date.now();
          noteTitleInput.value = note.title;
          noteEditor.innerHTML = note.body;
          saveState();
          renderNoteList();
          historyModal.classList.add('hidden');
          toast('กู้คืน Snapshot สำเร็จ', 'success');
        });
      });
      historyList.appendChild(item);
    });
  }
  historyModal.classList.remove('hidden');
}

// ============================================================
// FEATURE 7: QUICK CAPTURE
// ============================================================
function openQuickCapture() {
  quickCapture.classList.remove('hidden');
  qcTitle.value = '';
  qcEditor.innerHTML = '';
  setTimeout(() => qcTitle.focus(), 50);
}

function closeQuickCapture() {
  quickCapture.classList.add('hidden');
}

function saveQuickCapture() {
  const title = qcTitle.value.trim();
  const body = qcEditor.innerHTML.trim();
  if (!title && !body) { closeQuickCapture(); return; }
  const now = Date.now();
  const note = {
    id: genId(), title: title || 'Quick Note',
    body: body || '', notebookId: null,
    tags: ['quick'], color: 'default',
    pinned: false, locked: false, pin: null,
    createdAt: now, updatedAt: now, trashed: false, history: []
  };
  state.notes.unshift(note);
  saveState();
  renderAll();
  closeQuickCapture();
  openNote(note.id);
  toast('บันทึก Quick Note แล้ว', 'success');
}

// ============================================================
// FEATURE 8: NOTE LINKING [[ ]]
// ============================================================
function showLinkSuggest(query) {
  const lc = query.toLowerCase();
  const matches = state.notes
    .filter(n => !n.trashed && n.id !== state.settings.activeNoteId && (n.title || '').toLowerCase().includes(lc))
    .slice(0, 8);
  linkSuggestList.innerHTML = '';
  if (matches.length === 0) {
    linkSuggestList.innerHTML = '<div class="link-suggest-empty">ไม่พบโน้ต</div>';
  } else {
    matches.forEach((n, i) => {
      const item = document.createElement('div');
      item.className = 'link-suggest-item' + (i === linkSuggestIndex ? ' selected' : '');
      item.innerHTML = `<i class="fa-solid fa-file-lines"></i>${escHtml(n.title || 'ไม่มีชื่อ')}`;
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        insertNoteLink(n);
      });
      linkSuggestList.appendChild(item);
    });
  }

  // Position below caret
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const editorRect = noteEditor.getBoundingClientRect();
    linkSuggest.style.left = (rect.left - editorRect.left) + 'px';
    linkSuggest.style.top = (rect.bottom - editorRect.top + 4) + 'px';
  }
  linkSuggest.classList.remove('hidden');
}

function hideLinkSuggest() {
  linkSuggest.classList.add('hidden');
  linkSuggestActive = false;
  linkSuggestQuery = '';
  linkSuggestIndex = 0;
}

function insertNoteLink(note) {
  // Delete [[ + query text
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      const deleteLen = linkSuggestQuery.length + 2; // [[ + query
      const start = Math.max(0, range.startOffset - deleteLen);
      const delRange = document.createRange();
      delRange.setStart(node, start);
      delRange.setEnd(node, range.startOffset);
      sel.removeAllRanges();
      sel.addRange(delRange);
      document.execCommand('delete');
    }
  }
  const linkHtml = `<a class="note-link" data-note-id="${escAttr(note.id)}" href="#" title="${escAttr(note.title || '')}">\u{1f4dd} ${escHtml(note.title || 'ไม่มีชื่อ')}</a>\u00a0`;
  execCmd('insertHTML', linkHtml);
  hideLinkSuggest();
}

function handleLinkSuggestKeys(e) {
  if (!linkSuggestActive) return;
  const items = linkSuggestList.querySelectorAll('.link-suggest-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    linkSuggestIndex = Math.min(linkSuggestIndex + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === linkSuggestIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    linkSuggestIndex = Math.max(linkSuggestIndex - 1, 0);
    items.forEach((el, i) => el.classList.toggle('selected', i === linkSuggestIndex));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    if (items[linkSuggestIndex]) items[linkSuggestIndex].dispatchEvent(new MouseEvent('mousedown'));
  } else if (e.key === 'Escape') {
    hideLinkSuggest();
  }
}

function detectLinkSuggest() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) { hideLinkSuggest(); return; }
  const text = node.textContent.slice(0, range.startOffset);
  const lastDouble = text.lastIndexOf('[[');
  if (lastDouble === -1 || text.indexOf(']]', lastDouble) !== -1) {
    hideLinkSuggest(); return;
  }
  linkSuggestActive = true;
  linkSuggestQuery = text.slice(lastDouble + 2);
  linkSuggestIndex = 0;
  showLinkSuggest(linkSuggestQuery);
}

// ============================================================
// FEATURE 9: STATISTICS DASHBOARD
// ============================================================
function showStatsDashboard() {
  const allNotes = state.notes.filter(n => !n.trashed);
  const totalWords = allNotes.reduce((acc, n) => {
    const txt = (n.body || '').replace(/<[^>]*>/g, '').trim();
    return acc + (txt ? txt.split(/\s+/).length : 0);
  }, 0);

  // Tags
  const tagCount = {};
  allNotes.forEach(n => (n.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxTag = topTags[0]?.[1] || 1;

  // Notebooks
  const nbCount = {};
  allNotes.forEach(n => {
    const nb = state.notebooks.find(b => b.id === n.notebookId);
    const key = nb ? nb.name : 'ไม่มีสมุด';
    nbCount[key] = (nbCount[key] || 0) + 1;
  });
  const topNb = Object.entries(nbCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxNb = topNb[0]?.[1] || 1;

  // Activity last 30 days
  const now = Date.now();
  const dayMs = 86400000;
  const activityMap = {};
  allNotes.forEach(n => {
    const day = new Date(n.updatedAt).toDateString();
    activityMap[day] = (activityMap[day] || 0) + 1;
  });
  const last30 = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now - (29 - i) * dayMs);
    const count = activityMap[d.toDateString()] || 0;
    return { date: d.toLocaleDateString('th-TH', { month: 'short', day: 'numeric' }), count };
  });

  // Streak
  let streak = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date(now - i * dayMs).toDateString();
    if (activityMap[d]) streak++;
    else break;
  }

  // HTML
  statsContent.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-title">📝 โน้ตทั้งหมด</div>
      <div class="stat-card-value">${allNotes.length}</div>
      <div class="stat-card-sub">${state.notes.filter(n => n.trashed).length} ในถังขยะ</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">✍️ คำที่เขียนทั้งหมด</div>
      <div class="stat-card-value">${totalWords.toLocaleString()}</div>
      <div class="stat-card-sub">ประมาณ ${Math.round(totalWords / 200)} หน้า</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">📚 สมุดโน้ต</div>
      <div class="stat-card-value">${state.notebooks.length}</div>
      <div class="stat-card-sub">+ 1 โน้ตทั่วไป</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">🔥 Streak ปัจจุบัน</div>
      <div class="stat-card-value">${streak}</div>
      <div class="stat-card-sub">วันติดต่อกัน</div>
    </div>
    ${topTags.length ? `
    <div class="stat-card">
      <div class="stat-card-title">🏷️ แท็กยอดนิยม</div>
      ${topTags.map(([tag, cnt]) => `
        <div class="stat-bar-row">
          <div class="stat-bar-label">#${escHtml(tag)}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(cnt / maxTag * 100).toFixed(0)}%"></div></div>
          <div class="stat-bar-count">${cnt}</div>
        </div>`).join('')}
    </div>` : ''}
    ${topNb.length ? `
    <div class="stat-card">
      <div class="stat-card-title">📂 โน้ตต่อสมุด</div>
      ${topNb.map(([name, cnt]) => `
        <div class="stat-bar-row">
          <div class="stat-bar-label">${escHtml(name)}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(cnt / maxNb * 100).toFixed(0)}%"></div></div>
          <div class="stat-bar-count">${cnt}</div>
        </div>`).join('')}
    </div>` : ''}
    <div class="stat-card full">
      <div class="stat-card-title">📅 Activity (30 วันล่าสุด)</div>
      <div class="streak-badge"><i class="fa-solid fa-fire"></i> ${streak} วัน streak</div>
      <div class="activity-grid">
        ${last30.map(d => {
    const lvl = d.count === 0 ? '' : d.count <= 1 ? 'level-1' : d.count <= 3 ? 'level-2' : 'level-3';
    return `<div class="activity-cell ${lvl}" title="${d.date}: ${d.count} โน้ต"></div>`;
  }).join('')}
      </div>
    </div>
  `;
  statsModal.classList.remove('hidden');
}

// ============================================================
// PWA REGISTRATION
// ============================================================
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
}



// ====== DOM REFERENCES ======
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const themeToggle = document.getElementById('themeToggle');
const searchInput = document.getElementById('searchInput');
const clearSearch = document.getElementById('clearSearch');
const newNoteBtn = document.getElementById('newNoteBtn');
const newNoteBtnLarge = document.getElementById('newNoteBtnLarge');
const notebookList = document.getElementById('notebookList');
const tagCloud = document.getElementById('tagCloud');
const trashBtn = document.getElementById('trashBtn');
const trashCount = document.getElementById('trashCount');
const totalNotes = document.getElementById('totalNotes');
const totalNotebooks = document.getElementById('totalNotebooks');
const noteList = document.getElementById('noteList');
const noteListEmpty = document.getElementById('noteListEmpty');
const panelTitle = document.getElementById('panelTitle');
const sortBtn = document.getElementById('sortBtn');
const sortMenu = document.getElementById('sortMenu');
const gridToggle = document.getElementById('gridToggle');
const activeFilter = document.getElementById('activeFilter');
const filterLabel = document.getElementById('filterLabel');
const clearFilter = document.getElementById('clearFilter');
const editorToolbar = document.getElementById('editorToolbar');
const editorContentWrapper = document.getElementById('editorContentWrapper');
const editorEmptyState = document.getElementById('editorEmptyState');
const noteTitleInput = document.getElementById('noteTitleInput');
const notebookSelect = document.getElementById('notebookSelect');
const tagsDisplay = document.getElementById('tagsDisplay');
const tagInput = document.getElementById('tagInput');
const noteEditor = document.getElementById('noteEditor');
const wordCount = document.getElementById('wordCount');
const charCount = document.getElementById('charCount');
const saveStatus = document.getElementById('saveStatus');
const noteCreatedAt = document.getElementById('noteCreatedAt');
const noteUpdatedAt = document.getElementById('noteUpdatedAt');
const pinBtn = document.getElementById('pinBtn');
const colorBtn = document.getElementById('colorBtn');
const colorPicker = document.getElementById('colorPicker');
const exportBtn = document.getElementById('exportBtn');
const exportMenu = document.getElementById('exportMenu');
const exportMd = document.getElementById('exportMd');
const exportTxt = document.getElementById('exportTxt');
const deleteNoteBtn = document.getElementById('deleteNoteBtn');
const codeBtn = document.getElementById('codeBtn');
const linkBtn = document.getElementById('linkBtn');
const linkModal = document.getElementById('linkModal');
const linkText = document.getElementById('linkText');
const linkUrl = document.getElementById('linkUrl');
const cancelLink = document.getElementById('cancelLink');
const confirmLink = document.getElementById('confirmLink');
const newNotebookBtn = document.getElementById('newNotebookBtn');
const notebookModal = document.getElementById('notebookModal');
const notebookNameInput = document.getElementById('notebookNameInput');
const cancelNotebook = document.getElementById('cancelNotebook');
const confirmNotebook = document.getElementById('confirmNotebook');
const trashModal = document.getElementById('trashModal');
const trashList = document.getElementById('trashList');
const closeTrash = document.getElementById('closeTrash');
const emptyTrashBtn = document.getElementById('emptyTrashBtn');
const confirmModal = document.getElementById('confirmModal');
const confirmTitle = document.getElementById('confirmTitle');
const confirmMessage = document.getElementById('confirmMessage');
const cancelConfirm = document.getElementById('cancelConfirm');
const doConfirm = document.getElementById('doConfirm');
const toastContainer = document.getElementById('toastContainer');
const bubbleToolbar = document.getElementById('bubbleToolbar');
const bubbleLinkBtn = document.getElementById('bubbleLinkBtn');
const sidebarToggleAlt = document.getElementById('sidebarToggleAlt');
// New feature DOM refs
const focusBtn = document.getElementById('focusBtn');
const focusExitHint = document.getElementById('focusExitHint');
const lockBtn = document.getElementById('lockBtn');
const lockOverlay = document.getElementById('lockOverlay');
const pinError = document.getElementById('pinError');
const historyBtn = document.getElementById('historyBtn');
const historyModal = document.getElementById('historyModal');
const historyList = document.getElementById('historyList');
const closeHistory = document.getElementById('closeHistory');
const statsBtn = document.getElementById('statsBtn');
const statsModal = document.getElementById('statsModal');
const statsContent = document.getElementById('statsContent');
const closeStats = document.getElementById('closeStats');
const todoBtn = document.getElementById('todoBtn');
const imageBtn = document.getElementById('imageBtn');
const imageFileInput = document.getElementById('imageFileInput');
const quickCapture = document.getElementById('quickCapture');
const qcTitle = document.getElementById('qcTitle');
const qcEditor = document.getElementById('qcEditor');
const qcCancel = document.getElementById('qcCancel');
const qcSave = document.getElementById('qcSave');
const setPinModal = document.getElementById('setPinModal');
const setPinInput = document.getElementById('setPinInput');
const confirmPinInput = document.getElementById('confirmPinInput');
const cancelSetPin = document.getElementById('cancelSetPin');
const confirmSetPin = document.getElementById('confirmSetPin');
const linkSuggest = document.getElementById('linkSuggest');
const linkSuggestList = document.getElementById('linkSuggestList');

// ====== EVENT LISTENERS ======
function initEvents() {

  // Theme
  themeToggle.addEventListener('click', toggleTheme);

  // Sidebar toggle
  function toggleSidebar() {
    sidebar.classList.toggle('collapsed');
    const collapsed = sidebar.classList.contains('collapsed');
    // Update icon on both buttons to reflect state
    sidebarToggle.querySelector('i').className = collapsed ? 'fa-solid fa-bars-staggered' : 'fa-solid fa-bars';
    sidebarToggleAlt.querySelector('i').className = collapsed ? 'fa-solid fa-bars-staggered' : 'fa-solid fa-sidebar';
  }
  sidebarToggle.addEventListener('click', toggleSidebar);
  sidebarToggleAlt.addEventListener('click', toggleSidebar);


  // New Note
  newNoteBtn.addEventListener('click', createNote);
  newNoteBtnLarge.addEventListener('click', createNote);

  // Search
  searchInput.addEventListener('input', () => {
    clearSearch.classList.toggle('hidden', !searchInput.value);
    renderNoteList();
  });
  clearSearch.addEventListener('click', () => {
    searchInput.value = '';
    clearSearch.classList.add('hidden');
    renderNoteList();
  });

  // Sort
  sortBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sortMenu.classList.toggle('hidden');
    exportMenu.classList.add('hidden');
    colorPicker.classList.add('hidden');
  });
  sortMenu.querySelectorAll('button[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.sort = btn.dataset.sort;
      saveState(); renderNoteList();
      sortMenu.classList.add('hidden');
      toast('เรียงลำดับ: ' + btn.textContent.trim(), 'info');
    });
  });

  // Grid Toggle
  gridToggle.addEventListener('click', () => {
    state.settings.gridView = !state.settings.gridView;
    saveState(); renderNoteList();
    const icon = gridToggle.querySelector('i');
    icon.className = state.settings.gridView ? 'fa-solid fa-list' : 'fa-solid fa-grip';
  });

  // Clear Filter
  clearFilter.addEventListener('click', () => {
    state.settings.filterTag = null;
    state.settings.activeNotebookId = null;
    saveState(); renderAll();
  });

  // Editor: title, body input
  noteTitleInput.addEventListener('input', triggerAutoSave);
  noteEditor.addEventListener('input', () => { triggerAutoSave(); updateWordCount(); });

  // Notebook select change
  notebookSelect.addEventListener('change', triggerAutoSave);

  // Tag input
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput.value);
      tagInput.value = '';
    }
    if (e.key === 'Backspace' && !tagInput.value) {
      const note = getActiveNote();
      if (note && note.tags && note.tags.length > 0) {
        removeTag(note.tags[note.tags.length - 1]);
      }
    }
  });
  tagInput.addEventListener('blur', () => {
    if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ''; }
  });

  // Toolbar buttons
  document.querySelectorAll('.tool-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val || null;
      execCmd(cmd, val);
    });
  });
  codeBtn.addEventListener('click', insertCodeBlock);
  linkBtn.addEventListener('click', insertLink);

  // ===== FLOATING BUBBLE TOOLBAR =====
  let bubbleHideTimer = null;

  function positionBubble(rect) {
    const tb = bubbleToolbar;
    tb.classList.remove('hidden');
    const tbW = tb.offsetWidth;
    const tbH = tb.offsetHeight;
    let left = rect.left + window.scrollX + (rect.width / 2) - (tbW / 2);
    let top = rect.top + window.scrollY - tbH - 10;
    // clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - tbW - 8));
    if (top < 8) top = rect.bottom + window.scrollY + 10;
    tb.style.left = left + 'px';
    tb.style.top = top + 'px';
  }

  // Show bubble on selection inside editor
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      if (!bubbleToolbar.matches(':hover')) {
        bubbleHideTimer = setTimeout(() => bubbleToolbar.classList.add('hidden'), 120);
      }
      return;
    }
    // Check selection is inside noteEditor
    const node = sel.anchorNode;
    if (!noteEditor.contains(node)) {
      bubbleToolbar.classList.add('hidden');
      return;
    }
    clearTimeout(bubbleHideTimer);
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      positionBubble(rect);
    } catch (e) { }
  });

  bubbleToolbar.addEventListener('mouseenter', () => clearTimeout(bubbleHideTimer));
  bubbleToolbar.addEventListener('mouseleave', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) bubbleToolbar.classList.add('hidden');
  });

  // Bubble toolbar buttons
  bubbleToolbar.querySelectorAll('.bubble-tool-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep selection
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val || null;
      execCmd(cmd, val);
    });
  });
  if (bubbleLinkBtn) {
    bubbleLinkBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      bubbleToolbar.classList.add('hidden');
      insertLink();
    });
  }

  // Hide bubble on editor click (collapsed)
  noteEditor.addEventListener('mousedown', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) bubbleToolbar.classList.add('hidden');
    }, 50);
  });


  // ===== FEATURE 1: MARKDOWN SHORTCUTS =====
  noteEditor.addEventListener('keydown', handleMarkdownShortcuts, true);

  // ===== FEATURE 2: CHECKLIST =====
  todoBtn.addEventListener('click', insertTodoItem);

  // ===== FEATURE 3: FOCUS MODE =====
  focusBtn.addEventListener('click', toggleFocusMode);

  // ===== FEATURE 4: IMAGE PASTE/DRAG/UPLOAD =====
  noteEditor.addEventListener('paste', handleImagePaste);
  noteEditor.addEventListener('dragover', (e) => { e.preventDefault(); noteEditor.classList.add('editor-drag-active'); });
  noteEditor.addEventListener('dragleave', () => noteEditor.classList.remove('editor-drag-active'));
  noteEditor.addEventListener('drop', handleImageDrop);
  imageBtn.addEventListener('click', () => imageFileInput.click());
  imageFileInput.addEventListener('change', (e) => { handleImageUpload(e.target.files[0]); imageFileInput.value = ''; });

  // ===== FEATURE 5: NOTE LOCK =====
  lockBtn.addEventListener('click', toggleNoteLock);
  document.querySelectorAll('.pin-key').forEach(key => {
    key.addEventListener('click', () => {
      const val = key.dataset.val;
      if (pinTarget === 'unlock-and-clear' && pinEntry.length === 4) {
        // handled in checkPin override below
      }
      handlePinKey(val);
      // After 4 digits, if it matches, unlock and clear lock
      if (pinEntry.length === 0 && pinTarget === 'unlock-and-clear' && currentUnlockNote && !lockOverlay.classList.contains('hidden')) {
        const note = currentUnlockNote;
        if (pinEntry === '') {
          // Already cleared by checkPin success
          note.locked = false;
          note.pin = null;
          saveState();
          updateLockBtn(false);
          toast('ปลดล็อกและเลิกล็อกแล้ว', 'success');
        }
      }
    });
  });
  // Override checkPin to also unlock permanently when pinTarget is 'unlock-and-clear'
  const _origCheckPin = checkPin;
  // We redefine it through closure — handled in handlePinKey, checkPin uses currentUnlockNote

  // Close lock overlay on background click
  lockOverlay.addEventListener('click', (e) => { if (e.target === lockOverlay) closeLockOverlay(); });

  // Set PIN Modal
  cancelSetPin.addEventListener('click', () => setPinModal.classList.add('hidden'));
  confirmSetPin.addEventListener('click', () => {
    const p1 = setPinInput.value.trim();
    const p2 = confirmPinInput.value.trim();
    if (!/^\d{4}$/.test(p1)) { toast('PIN ต้องเป็นตัวเลข 4 หลัก', 'error'); return; }
    if (p1 !== p2) { toast('PIN ไม่ตรงกัน', 'error'); return; }
    setPinModal.classList.add('hidden');
    lockNoteWithPin(p1);
  });
  setPinModal.addEventListener('click', e => { if (e.target === setPinModal) setPinModal.classList.add('hidden'); });
  [setPinInput, confirmPinInput].forEach(input => {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') confirmSetPin.click(); if (e.key === 'Escape') setPinModal.classList.add('hidden'); });
  });

  // ===== FEATURE 6: VERSION HISTORY =====
  historyBtn.addEventListener('click', showHistoryModal);
  closeHistory.addEventListener('click', () => historyModal.classList.add('hidden'));
  historyModal.addEventListener('click', e => { if (e.target === historyModal) historyModal.classList.add('hidden'); });

  // ===== FEATURE 7: QUICK CAPTURE =====
  qcCancel.addEventListener('click', closeQuickCapture);
  qcSave.addEventListener('click', saveQuickCapture);
  quickCapture.addEventListener('click', e => { if (e.target === quickCapture) closeQuickCapture(); });
  qcEditor.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveQuickCapture(); } });

  // ===== FEATURE 8: NOTE LINKING [[ =====
  noteEditor.addEventListener('input', detectLinkSuggest);
  noteEditor.addEventListener('keydown', handleLinkSuggestKeys, true);
  // Click note-link to navigate
  noteEditor.addEventListener('click', e => {
    const link = e.target.closest('.note-link');
    if (link) {
      e.preventDefault();
      const id = link.dataset.noteId;
      if (id) openNote(id);
    }
  });

  // ===== FEATURE 9: STATS DASHBOARD =====
  statsBtn.addEventListener('click', showStatsDashboard);
  closeStats.addEventListener('click', () => statsModal.classList.add('hidden'));
  statsModal.addEventListener('click', e => { if (e.target === statsModal) statsModal.classList.add('hidden'); });

  // ===== ABOUT MODAL =====
  const aboutBtn = document.getElementById('aboutBtn');
  const aboutModal = document.getElementById('aboutModal');
  const closeAbout = document.getElementById('closeAbout');
  aboutBtn.addEventListener('click', () => aboutModal.classList.remove('hidden'));
  closeAbout.addEventListener('click', () => aboutModal.classList.add('hidden'));
  aboutModal.addEventListener('click', e => { if (e.target === aboutModal) aboutModal.classList.add('hidden'); });

  // ===== AUTH MODAL (Firebase) =====
  let isLoginMode = true;
  const authBtn = document.getElementById('authBtn');
  const authOverlay = document.getElementById('authOverlay');
  const closeAuthBtn = document.getElementById('closeAuthBtn');
  const authForm = document.getElementById('authForm');
  const authToggleModeBtn = document.getElementById('authToggleModeBtn');
  const authTitle = document.getElementById('authTitle');
  const authSubmitBtn = document.getElementById('authSubmitBtn');
  const authError = document.getElementById('authError');

  authBtn.addEventListener('click', () => {
    if (currentUser) {
      confirmAction('ออกจากระบบ?', `คุณต้องการออกจากระบบ Cloud Sync ใช่หรือไม่?ข้อมูลจะยังอยู่ในเครื่องนี้เหมือนเดิม`, async () => {
        await signOut(auth);
        toast('ออกจากระบบแล้ว', 'success');
      });
    } else {
      authOverlay.classList.remove('hidden');
      authError.style.display = 'none';
      document.getElementById('authUsername').focus();
    }
  });

  closeAuthBtn.addEventListener('click', () => authOverlay.classList.add('hidden'));
  authOverlay.addEventListener('click', e => { if (e.target === authOverlay) authOverlay.classList.add('hidden'); });

  authToggleModeBtn.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    authError.style.display = 'none';
    if (isLoginMode) {
      authTitle.textContent = 'เข้าสู่ระบบ';
      authSubmitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> เข้าสู่ระบบ';
      authToggleModeBtn.innerHTML = 'ยังไม่มีบัญชี? <span>สมัครสมาชิก</span>';
    } else {
      authTitle.textContent = 'สมัครสมาชิก';
      authSubmitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> สมัครสมาชิก';
      authToggleModeBtn.innerHTML = 'มีบัญชีแล้ว? <span>เข้าสู่ระบบ</span>';
    }
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.style.display = 'none';
    const username = document.getElementById('authUsername').value.trim().toLowerCase();
    const password = document.getElementById('authPassword').value;

    // Validate username
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      authError.textContent = 'ชื่อผู้ใช้ต้องมี 3-20 ตัวอักษร (a-z, 0-9, _ เท่านั้น)';
      authError.style.display = 'block';
      return;
    }

    // Convert username to fake email for Firebase Auth
    const fakeEmail = `${username}@roomnote.app`;

    authSubmitBtn.disabled = true;
    authSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังดำเนินการ...';

    try {
      if (isLoginMode) {
        await signInWithEmailAndPassword(auth, fakeEmail, password);
        toast('เข้าสู่ระบบสำเร็จ ☁️', 'success');
      } else {
        await createUserWithEmailAndPassword(auth, fakeEmail, password);
        toast('สมัครสมาชิกและเข้าสู่ระบบสำเร็จ ☁️', 'success');
      }
      authOverlay.classList.add('hidden');
      authForm.reset();
    } catch (err) {
      console.error(err);
      let msg = err.message.replace('Firebase:', '').trim();
      // Translate common errors
      if (msg.includes('email-already-in-use')) msg = 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว';
      else if (msg.includes('invalid-email')) msg = 'ชื่อผู้ใช้ไม่ถูกต้อง';
      else if (msg.includes('weak-password')) msg = 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร';
      else if (msg.includes('user-not-found') || msg.includes('invalid-credential')) msg = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
      else if (msg.includes('wrong-password')) msg = 'รหัสผ่านไม่ถูกต้อง';
      else if (msg.includes('configuration-not-found')) msg = 'ยังไม่ได้เปิดใช้งาน Email/Password ใน Firebase Console → Authentication → Sign-in method';
      else if (msg.includes('too-many-requests')) msg = 'ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
      authError.textContent = msg;
      authError.style.display = 'block';
    } finally {
      authSubmitBtn.disabled = false;
      authSubmitBtn.innerHTML = isLoginMode
        ? '<i class="fa-solid fa-right-to-bracket"></i> เข้าสู่ระบบ'
        : '<i class="fa-solid fa-user-plus"></i> สมัครสมาชิก';
    }
  });


  // Pin
  pinBtn.addEventListener('click', togglePin);



  // Color
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    colorPicker.classList.toggle('hidden');
    exportMenu.classList.add('hidden');
    sortMenu.classList.add('hidden');
  });
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => setNoteColor(swatch.dataset.color));
  });

  // Export
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('hidden');
    colorPicker.classList.add('hidden');
    sortMenu.classList.add('hidden');
  });
  exportMd.addEventListener('click', () => exportNote('md'));
  exportTxt.addEventListener('click', () => exportNote('txt'));

  // Delete
  deleteNoteBtn.addEventListener('click', () => {
    const note = getActiveNote();
    if (!note) return;
    trashNote(note.id);
  });

  // Link Modal
  cancelLink.addEventListener('click', () => linkModal.classList.add('hidden'));
  confirmLink.addEventListener('click', confirmInsertLink);
  linkUrl.addEventListener('keydown', e => { if (e.key === 'Enter') confirmInsertLink(); });
  linkModal.addEventListener('click', e => { if (e.target === linkModal) linkModal.classList.add('hidden'); });

  // Notebook Modal
  newNotebookBtn.addEventListener('click', () => {
    notebookNameInput.value = '';
    notebookModal.classList.remove('hidden');
    notebookNameInput.focus();
  });
  cancelNotebook.addEventListener('click', () => notebookModal.classList.add('hidden'));
  confirmNotebook.addEventListener('click', () => {
    const name = notebookNameInput.value.trim();
    if (!name) { toast('กรุณาใส่ชื่อสมุดโน้ต', 'error'); return; }
    if (state.notebooks.find(n => n.name.toLowerCase() === name.toLowerCase())) {
      toast('ชื่อซ้ำกัน', 'error'); return;
    }
    state.notebooks.push({ id: genId(), name, createdAt: Date.now() });
    saveState(); renderAll();
    notebookModal.classList.add('hidden');
    toast('สร้างสมุดโน้ตแล้ว', 'success');
  });
  notebookNameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmNotebook.click();
    if (e.key === 'Escape') notebookModal.classList.add('hidden');
  });
  notebookModal.addEventListener('click', e => { if (e.target === notebookModal) notebookModal.classList.add('hidden'); });

  // Trash
  trashBtn.addEventListener('click', () => {
    renderTrashList();
    trashModal.classList.remove('hidden');
  });
  closeTrash.addEventListener('click', () => trashModal.classList.add('hidden'));
  trashModal.addEventListener('click', e => { if (e.target === trashModal) trashModal.classList.add('hidden'); });
  emptyTrashBtn.addEventListener('click', () => {
    if (state.notes.filter(n => n.trashed).length === 0) { toast('ถังขยะว่างอยู่แล้ว', 'info'); return; }
    confirmAction('ล้างถังขยะ', 'ลบโน้ตทั้งหมดในถังขยะถาวรหรือไม่?', emptyTrash);
  });

  // Confirm Modal
  cancelConfirm.addEventListener('click', () => confirmModal.classList.add('hidden'));
  confirmModal.addEventListener('click', e => { if (e.target === confirmModal) confirmModal.classList.add('hidden'); });

  // Click outside to close dropdowns
  document.addEventListener('click', () => {
    sortMenu.classList.add('hidden');
    exportMenu.classList.add('hidden');
    colorPicker.classList.add('hidden');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'n') { e.preventDefault(); createNote(); }
    if (ctrl && e.key === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    if (ctrl && e.key === 's') {
      e.preventDefault();
      const note = getActiveNote();
      if (note) {
        clearTimeout(saveDebounce);
        triggerAutoSave();
        saveHistory(); // save snapshot on manual save
        toast('บันทึกแล้ว', 'success');
      }
    }
    if (ctrl && e.key === 'd') { e.preventDefault(); const note = getActiveNote(); if (note) trashNote(note.id); }
    if (ctrl && e.key === 't') { e.preventDefault(); toggleTheme(); }
    if (ctrl && e.key === 'k') { e.preventDefault(); const note = getActiveNote(); if (note) insertLink(); }
    if (ctrl && e.key === ' ') { e.preventDefault(); openQuickCapture(); }
    if (e.key === 'F11') { e.preventDefault(); if (getActiveNote()) toggleFocusMode(); }
    if (e.key === 'Escape') {
      linkModal.classList.add('hidden');
      notebookModal.classList.add('hidden');
      trashModal.classList.add('hidden');
      historyModal.classList.add('hidden');
      statsModal.classList.add('hidden');
      setPinModal.classList.add('hidden');
      quickCapture.classList.add('hidden');
      confirmModal.classList.add('hidden');
      sortMenu.classList.add('hidden');
      exportMenu.classList.add('hidden');
      colorPicker.classList.add('hidden');
      hideLinkSuggest();
      if (isFocusMode) toggleFocusMode();
    }
  });


  // Editor keyboard shortcuts within editor
  noteEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      execCmd('insertHTML', '&nbsp;&nbsp;&nbsp;&nbsp;');
    }
  });
}

// ============================================================
// MOBILE NAVIGATION
// ============================================================
function isMobile() { return window.innerWidth <= 600; }

function showMobileEditor() {
  if (!isMobile()) return;
  document.body.classList.add('mobile-editor-active');
  sidebar.classList.remove('mobile-show');
  updateMobNavActive('editor');
}

function showMobileNoteList() {
  if (!isMobile()) return;
  document.body.classList.remove('mobile-editor-active');
  sidebar.classList.remove('mobile-show');
  updateMobNavActive('notes');
}

function showMobileSidebar() {
  if (!isMobile()) return;
  sidebar.classList.add('mobile-show');
  updateMobNavActive('sidebar');
}

function hideMobileSidebar() {
  sidebar.classList.remove('mobile-show');
  updateMobNavActive('notes');
}

function updateMobNavActive(tab) {
  document.querySelectorAll('.mob-nav-item').forEach(el => el.classList.remove('active'));
  const map = {
    sidebar: 'mobNavSidebar',
    notes: 'mobNavNotes',
    stats: 'mobNavStats',
    about: 'mobNavAbout',
  };
  if (map[tab]) document.getElementById(map[tab])?.classList.add('active');
}

function initMobileNav() {
  const mobNavSidebar = document.getElementById('mobNavSidebar');
  const mobNavNotes = document.getElementById('mobNavNotes');
  const mobNavNew = document.getElementById('mobNavNew');
  const mobNavStats = document.getElementById('mobNavStats');
  const mobNavAbout = document.getElementById('mobNavAbout');
  const mobileBackBtn = document.getElementById('mobileBackBtn');

  mobNavSidebar?.addEventListener('click', () => {
    if (sidebar.classList.contains('mobile-show')) {
      hideMobileSidebar();
    } else {
      showMobileSidebar();
    }
  });

  mobNavNotes?.addEventListener('click', showMobileNoteList);

  mobNavNew?.addEventListener('click', () => {
    createNote();
    if (isMobile()) showMobileEditor();
  });

  mobNavStats?.addEventListener('click', () => showStatsDashboard());
  mobNavAbout?.addEventListener('click', () => document.getElementById('aboutModal')?.classList.remove('hidden'));

  mobileBackBtn?.addEventListener('click', showMobileNoteList);

  // Auto-detect when opening a note on mobile → switch to editor view
  const origOpenNote = openNote;
  window._origOpenNote = origOpenNote;
}

// Patch openNote for mobile
const _baseOpenNote = openNote;
openNote = function (id) {
  _baseOpenNote(id);
  if (isMobile()) showMobileEditor();
};

// Close sidebar when clicking a notebook/tag on mobile
document.addEventListener('click', (e) => {
  if (!isMobile()) return;
  if (e.target.closest('.notebook-item') || e.target.closest('.tag-item')) {
    setTimeout(hideMobileSidebar, 150);
  }
});

// ============================================================
// CUSTOM CONTEXT MENUS
// ============================================================
const ctxNote = document.getElementById('ctxNote');
const ctxEditor = document.getElementById('ctxEditor');
const ctxNotebook = document.getElementById('ctxNotebook');
const ctxNotebookSub = document.getElementById('ctxNotebookSub');
let ctxTargetNoteId = null;
let ctxTargetNotebookId = null;

function hideAllCtx() {
  ctxNote.classList.add('hidden');
  ctxEditor.classList.add('hidden');
  ctxNotebook.classList.add('hidden');
}

function showCtxMenu(menu, x, y) {
  hideAllCtx();
  menu.classList.remove('hidden');
  // Position with viewport clamping
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - w - 8) + 'px';
  menu.style.top = Math.min(y, vh - h - 8) + 'px';
}

// Hide on click anywhere / Escape
document.addEventListener('click', hideAllCtx);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideAllCtx(); });

// ---- NOTE CARD CONTEXT MENU ----
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
document.getElementById('noteList').addEventListener('contextmenu', e => {
  if (isTouchDevice) return; // Let native mobile UI handle it
  const card = e.target.closest('.note-card');
  if (!card) return;
  e.preventDefault();
  ctxTargetNoteId = card.dataset.id;

  // Populate notebook sub-menu
  ctxNotebookSub.innerHTML = '';
  const noneItem = document.createElement('div');
  noneItem.className = 'ctx-nb-item';
  noneItem.innerHTML = '<i class="fa-solid fa-inbox"></i>ไม่มีสมุดโน้ต';
  noneItem.addEventListener('click', () => { moveNoteToNotebook(ctxTargetNoteId, null); hideAllCtx(); });
  ctxNotebookSub.appendChild(noneItem);
  state.notebooks.forEach(nb => {
    const item = document.createElement('div');
    item.className = 'ctx-nb-item';
    item.innerHTML = `<i class="fa-solid fa-folder"></i>${escHtml(nb.name)}`;
    item.addEventListener('click', () => { moveNoteToNotebook(ctxTargetNoteId, nb.id); hideAllCtx(); });
    ctxNotebookSub.appendChild(item);
  });

  showCtxMenu(ctxNote, e.clientX, e.clientY);
});

// Note context menu actions
ctxNote.addEventListener('click', e => {
  const btn = e.target.closest('.ctx-item');
  if (!btn) return;
  const action = btn.dataset.action;
  const note = state.notes.find(n => n.id === ctxTargetNoteId);
  if (!note) { hideAllCtx(); return; }

  switch (action) {
    case 'pin':
      note.pinned = !note.pinned;
      note.updatedAt = Date.now();
      saveState(); renderNoteList();
      if (state.settings.activeNoteId === note.id) updatePinBtn(note.pinned);
      toast(note.pinned ? 'ปักหมุดแล้ว' : 'ถอดหมุดแล้ว', 'success');
      break;
    case 'copy':
      navigator.clipboard.writeText(note.title || 'ไม่มีชื่อ').then(() => toast('คัดลอกชื่อแล้ว', 'success'));
      break;
    case 'lock':
      openNote(note.id);
      setTimeout(toggleNoteLock, 100);
      break;
    case 'export':
      openNote(note.id);
      setTimeout(() => document.getElementById('exportMd')?.click(), 100);
      break;
    case 'delete':
      trashNote(note.id);
      break;
  }
  hideAllCtx();
});

// Color swatches in context menu
ctxNote.querySelectorAll('.ctx-color-swatch').forEach(swatch => {
  swatch.addEventListener('click', (e) => {
    e.stopPropagation();
    const note = state.notes.find(n => n.id === ctxTargetNoteId);
    if (!note) return;
    note.color = swatch.dataset.color;
    note.updatedAt = Date.now();
    saveState(); renderNoteList();
    if (state.settings.activeNoteId === note.id) updateColorSwatch(note.color);
    toast('เปลี่ยนสีแล้ว', 'success');
    hideAllCtx();
  });
});

function moveNoteToNotebook(noteId, notebookId) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return;
  note.notebookId = notebookId;
  note.updatedAt = Date.now();
  saveState(); renderAll();
  if (state.settings.activeNoteId === note.id) notebookSelect.value = notebookId || '';
  const nbName = notebookId ? (state.notebooks.find(b => b.id === notebookId)?.name || '') : 'ทั่วไป';
  toast(`ย้ายไปสมุด "${nbName}" แล้ว`, 'success');
}

// ---- EDITOR CONTEXT MENU ----
noteEditor.addEventListener('contextmenu', e => {
  if (isTouchDevice) return; // Let native mobile UI handle it
  e.preventDefault();
  showCtxMenu(ctxEditor, e.clientX, e.clientY);
});

ctxEditor.addEventListener('click', e => {
  const btn = e.target.closest('.ctx-item');
  if (!btn) return;
  const action = btn.dataset.action;
  hideAllCtx();
  noteEditor.focus();

  switch (action) {
    case 'bold': execCmd('bold'); break;
    case 'italic': execCmd('italic'); break;
    case 'underline': execCmd('underline'); break;
    case 'link': insertLink(); break;
    case 'todo': insertTodoItem(); break;
    case 'image': imageFileInput.click(); break;
    case 'code': insertCodeBlock(); break;
    case 'focus': toggleFocusMode(); break;
  }
});

// ---- NOTEBOOK CONTEXT MENU ----
document.getElementById('notebookList').addEventListener('contextmenu', e => {
  if (isTouchDevice) return; // Let native mobile UI handle it
  const item = e.target.closest('.notebook-item');
  if (!item) return;
  // Skip "All" item (first child)
  const idx = Array.from(item.parentNode.children).indexOf(item);
  if (idx === 0) return; // "ทั้งหมด" item
  e.preventDefault();
  ctxTargetNotebookId = state.notebooks[idx - 1]?.id;
  if (!ctxTargetNotebookId) return;
  showCtxMenu(ctxNotebook, e.clientX, e.clientY);
});

ctxNotebook.addEventListener('click', e => {
  const btn = e.target.closest('.ctx-item');
  if (!btn) return;
  const action = btn.dataset.action;
  const nb = state.notebooks.find(b => b.id === ctxTargetNotebookId);
  if (!nb) { hideAllCtx(); return; }
  hideAllCtx();

  switch (action) {
    case 'rename':
      const newName = prompt('ชื่อใหม่:', nb.name);
      if (newName && newName.trim()) {
        nb.name = newName.trim();
        saveState(); renderAll();
        toast('เปลี่ยนชื่อแล้ว', 'success');
      }
      break;
    case 'deleteNb':
      confirmAction('ลบสมุดโน้ต', `ลบ "${nb.name}" หรือไม่? โน้ตจะไม่ถูกลบ`, () => {
        state.notes.forEach(n => { if (n.notebookId === nb.id) n.notebookId = null; });
        state.notebooks = state.notebooks.filter(b => b.id !== nb.id);
        if (state.settings.activeNotebookId === nb.id) state.settings.activeNotebookId = null;
        saveState(); renderAll();
        toast('ลบสมุดโน้ตแล้ว', 'success');
      });
      break;
  }
});

// ====== INIT ======
function init() {
  loadState();
  applyTheme(state.settings.theme || 'dark');

  // Init toolbar/editor visibility
  editorToolbar.style.display = 'none';
  editorContentWrapper.style.display = 'none';

  // Firebase Auth State Listener
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    const authBtnEl = document.getElementById('authBtn');
    const syncStatus = document.getElementById('cloudSyncStatus');
    if (user) {
      if (authBtnEl) {
        authBtnEl.innerHTML = `<i class="fa-solid fa-cloud" style="color: var(--accent)"></i>`;
        authBtnEl.setAttribute('title', `ออกจากระบบ (${user.email.replace('@roomnote.app', '')})`);
      }
      if (syncStatus) syncStatus.style.display = 'block';
      await syncFromCloud();
    } else {
      if (authBtnEl) {
        authBtnEl.innerHTML = `<i class="fa-solid fa-user-circle"></i>`;
        authBtnEl.setAttribute('title', 'เข้าสู่ระบบ Cloud Sync');
      }
      if (syncStatus) syncStatus.style.display = 'none';
    }
  });

  initEvents();
  initMobileNav();
  renderAll();

  // Re-open last active note
  if (state.settings.activeNoteId) {
    const note = state.notes.find(n => n.id === state.settings.activeNoteId && !n.trashed);
    if (note) openNote(note.id);
    else showEmptyEditor();
  } else {
    showEmptyEditor();
  }

  // Grid toggle icon
  if (state.settings.gridView) {
    gridToggle.querySelector('i').className = 'fa-solid fa-list';
  }
}

document.addEventListener('DOMContentLoaded', init);
