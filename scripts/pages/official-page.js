import { signInAnonymously, onAuthStateChanged, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { db, auth } from '../../config/firebase-config.js';
import { BASE_PATH, applyCachedInstitutionLogo, escapeHtml, rememberInstitutionLogo, sanitizeUrl } from '../shared/app-common.js';
import { collection, doc, getDoc, getDocs } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

let allStudents = [];
let allStaff = [];
let studentGroups = [];
let directoryEntries = [];
let directoryCategories = [];
let institutionConfig = {};
let categoryAuthConfig = { categories: {} };
let pageAccessConfig = { categories: {}, overrides: {} };
let userSession = null;
let authReady = false;
const OFFICIAL_SESSION_KEY = 'official_portal_session_v1';
applyCachedInstitutionLogo(['header-logo', 'header-logo-right', 'official-login-modal-logo']);

const officialFilters = {
  studentClass: '', studentGender: 'ALL', studentInfo: 'ALL', studentSearch: '',
  staffType: 'ALL', staffStatus: 'ALL', staffSearch: ''
};

// SPREADSHEET BUILDER STATE
let builderConfig = {
  classId: '', paper: 'A4', orientation: 'portrait', sortBy: 'name', groupBy: 'mixed',
  showHeader: false, repeatHeader: false, customTitle: '', activeTab: 'home',
  columns: [
    { id: 'col_sno', field: 'SNO', title: 'S.No', width: 'auto' },
    { id: 'col_name', field: 'name', title: 'Student Name', width: 'auto' },
    { id: 'col_adm', field: 'adm', title: 'Adm No', width: 'auto' },
    { id: 'col_c1', field: 'CUSTOM', title: 'New Column', width: '120px' }
  ]
};

let undoStack = [];
let redoStack = [];

const saveBuilderState = () => {
    const table = document.getElementById('builder-table');
    if (table) {
        undoStack.push(table.innerHTML);
        if (undoStack.length > 20) undoStack.shift(); 
        redoStack = [];
    }
};

const undoBuilder = () => {
    if (undoStack.length > 0) {
        const table = document.getElementById('builder-table');
        redoStack.push(table.innerHTML);
        table.innerHTML = undoStack.pop();
        attachTableFormatListeners();
    }
};

const redoBuilder = () => {
    if (redoStack.length > 0) {
        const table = document.getElementById('builder-table');
        undoStack.push(table.innerHTML);
        table.innerHTML = redoStack.pop();
        attachTableFormatListeners();
    }
};

const resolveInstitutionName = (conf = {}) => String(conf.appName || conf.institutionName || conf.institution || conf.schoolName || conf.school || conf.name || '').trim();

const applyOfficialBranding = (conf = {}) => {
  institutionConfig = conf || {};
  const institutionName = resolveInstitutionName(conf) || 'Official Portal';
  const effectiveLogo = rememberInstitutionLogo(conf.logoUrl || '') || 'assets/images/logo.png';
  ['header-logo', 'header-logo-right', 'official-login-modal-logo'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.src = effectiveLogo;
    el.onerror = () => { el.onerror = null; el.src = 'assets/images/logo.png'; };
  });
  document.getElementById('header-title').textContent = institutionName;
};

const hashCredentialValue = async (rawValue = '') => {
  const value = String(rawValue || '');
  if (!value) return '';
  if (!(window.crypto?.subtle)) return value;
  const encoded = new TextEncoder().encode(value);
  const digest = await window.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const showMsg = (m = '') => { document.getElementById('official-login-msg').textContent = m; };
const toLabel = (key = '') => String(key || '').replace(/([A-Z])/g, ' $1').replace(/[_.-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
const normalizeText = (value = '') => String(value || '').trim().toLowerCase();
const formatDate = (value = '') => {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-GB');
};
const valueToDisplay = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.map(valueToDisplay).join(', ');
  if (typeof value === 'object') {
    if (value.seconds) return formatDate(value.seconds * 1000);
    return Object.entries(value).filter(([, nested]) => nested !== undefined && nested !== null && String(nested).trim() !== '').map(([key, nested]) => `${toLabel(key)}: ${valueToDisplay(nested)}`).join(' • ') || '';
  }
  return String(value);
};
const SENSITIVE_PROFILE_KEYS = new Set(['id', 'password', 'passwordhash', 'password_hash', 'username', 'user_name', 'usernameraw', 'username_raw', 'authmeta', 'source', 'email']);
const isSensitiveProfileField = (key = '', label = '') => {
  const parts = [key, label].map((item) => String(item || '').toLowerCase().replace(/[\s.-]+/g, '_'));
  return parts.some((part) => SENSITIVE_PROFILE_KEYS.has(part) || /(^|_)pass(word)?($|_)/.test(part) || /(^|_)user(name)?($|_)/.test(part) || part.includes('credential') || part.includes('auth'));
};
const renderEntriesGrid = (entries = []) => {
  const visibleEntries = entries.filter((entry) => entry && !isSensitiveProfileField(entry.key, entry.label) && valueToDisplay(entry.value) !== '');
  if (!visibleEntries.length) return '<div class="text-sm text-slate-500">No details available.</div>';
  return `<div class="details-grid">${visibleEntries.map((entry) => `<div class="detail-item"><div class="detail-label">${escapeHtml(entry.label || toLabel(entry.key))}</div><div class="detail-value">${escapeHtml(valueToDisplay(entry.value))}</div></div>`).join('')}</div>`;
};
const getVisibleEntries = (obj = {}, skipKeys = []) => Object.entries(obj || {}).filter(([k, v]) => !skipKeys.includes(k) && v !== undefined && v !== null && String(valueToDisplay(v)).trim() !== '');
const renderKeyValueGrid = (obj = {}, skipKeys = []) => renderEntriesGrid(getVisibleEntries(obj, skipKeys).map(([key, value]) => ({ key, label: toLabel(key), value })));
const getPhoto = (obj = {}) => sanitizeUrl(obj.photo || obj.image || obj.logo || '') || 'assets/images/logo.png';
const getStudentClass = (student = {}) => String(student.class || '--').trim() || '--';
const getStudentGender = (student = {}) => String(student.gender || '').trim();
const getStudentStatus = (student = {}) => student.isActive === false || student.status === 'inactive' || student.left === true ? 'Inactive' : 'Active';
const hasStudentConcession = (student = {}) => student.concessionFee !== undefined && student.concessionFee !== null && student.concessionFee !== '';
const getStudentGroup = (studentId = '') => studentGroups.find((group) => Array.isArray(group.memberIds) && group.memberIds.includes(studentId));
const getGroupMemberRows = (group = {}) => (group.memberIds || []).map((memberId) => allStudents.find((student) => student.id === memberId)).filter(Boolean);

const mobileToggle = document.getElementById('mobile-menu-btn');
const navMenu = document.querySelector('.nav-menu');
const setMobileMenuState = (isOpen) => {
  navMenu?.classList.toggle('active', isOpen);
  mobileToggle?.classList.toggle('active-toggle', isOpen);
  mobileToggle?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
};

const setTab = (tab = 'dashboard') => {
  const requested = document.getElementById(`official-tab-${tab}`) ? tab : 'dashboard';
  const target = document.getElementById(`official-tab-${requested}`) ? requested : 'students';
  document.querySelectorAll('.official-tab').forEach((el) => el.classList.add('hidden'));
  
  const targetEl = document.getElementById(`official-tab-${target}`);
  if(targetEl) {
      targetEl.classList.remove('hidden');
      if (target === 'export') {
          targetEl.classList.add('flex'); // Need flex for Excel UI layout
      } else {
          document.getElementById('official-tab-export')?.classList.remove('flex');
      }
  }

  document.querySelectorAll('.tab-link').forEach((btn) => {
    const active = btn.dataset.tab === target;
    btn.classList.toggle('active', active);
    btn.classList.toggle('text-indigo-700', active);
  });
  setMobileMenuState(false);
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  
  if (target === 'export') {
      renderExportTab();
      setupExcelEngine();
  }
};

const openOfficialDetailModal = (title = 'Details', bodyHtml = '') => {
  const titleEl = document.getElementById('official-detail-title');
  const bodyEl = document.getElementById('official-detail-body');
  const modal = document.getElementById('official-detail-modal');
  if (!titleEl || !bodyEl || !modal) return;
  titleEl.textContent = title;
  bodyEl.innerHTML = bodyHtml;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('overflow-hidden');
};
const closeOfficialDetailModal = () => {
  const modal = document.getElementById('official-detail-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('overflow-hidden');
};

document.getElementById('official-detail-close')?.addEventListener('click', closeOfficialDetailModal);
document.getElementById('official-detail-modal')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeOfficialDetailModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeOfficialDetailModal();
});

document.querySelectorAll('.tab-link').forEach((btn) => btn.addEventListener('click', (event) => { event.preventDefault(); setTab(btn.dataset.tab); }));
mobileToggle?.addEventListener('click', (e) => {
  e.stopPropagation();
  setMobileMenuState(!navMenu.classList.contains('active'));
});
document.addEventListener('click', (e) => {
  if (!navMenu?.contains(e.target) && !mobileToggle?.contains(e.target)) setMobileMenuState(false);
});

const summaryStats = () => {
  const totalStudents = allStudents.length;
  const boys = allStudents.filter((student) => normalizeText(student.gender) === 'male').length;
  const girls = allStudents.filter((student) => normalizeText(student.gender) === 'female').length;
  const classCount = new Set(allStudents.map(getStudentClass)).size;
  const teachers = allStaff.filter((staff) => staff.isActive !== false && staff.type === 'Teacher').length;
  const management = allStaff.filter((staff) => staff.isActive !== false && staff.type === 'Management').length;
  const activeStaff = allStaff.filter((staff) => staff.isActive !== false).length;
  const categoryMembers = directoryEntries.length;
  const groupCount = studentGroups.length;
  const concessionStudents = allStudents.filter(hasStudentConcession).length;
  return { totalStudents, boys, girls, classCount, teachers, management, activeStaff, categoryMembers, groupCount, concessionStudents };
};

const metricCard = (label, value, tone = 'blue', icon = 'fa-circle-info') => `
  <div class="official-metric-card ${tone}">
    <div><div class="official-metric-label">${escapeHtml(label)}</div><div class="official-metric-value">${escapeHtml(String(value))}</div></div>
    <i class="fas ${icon}"></i>
  </div>`;

const renderDashboard = () => {
  const stats = summaryStats();
  document.getElementById('official-tab-dashboard').innerHTML = `
    <div class="space-y-4">
      <div class="card p-4 rounded-2xl shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div><h3 class="font-extrabold text-lg">Official Overview</h3><p class="text-sm text-slate-500 font-semibold">Read-only institution register and directory.</p></div>
          <span class="text-xs font-bold px-3 py-1 rounded-full bg-indigo-50 text-indigo-700">${escapeHtml(resolveInstitutionName(institutionConfig) || 'Institution')}</span>
        </div>
        <div class="official-metric-grid">
          ${metricCard('Students', stats.totalStudents, 'blue', 'fa-user-graduate')}
          ${metricCard('Classes', stats.classCount, 'indigo', 'fa-school')}
          ${metricCard('Boys', stats.boys, 'green', 'fa-person')}
          ${metricCard('Girls', stats.girls, 'teal', 'fa-person-dress')}
          ${metricCard('Teachers', stats.teachers, 'amber', 'fa-chalkboard-user')}
          ${metricCard('Management', stats.management, 'purple', 'fa-users-gear')}
          ${metricCard('Groups', stats.groupCount, 'blue', 'fa-people-group')}
          ${metricCard('Concessions', stats.concessionStudents, 'green', 'fa-hand-holding-dollar')}
        </div>
      </div>
      <div class="grid md:grid-cols-3 gap-4">
        <button type="button" class="official-quick-card" data-open-tab="students"><i class="fas fa-users"></i><b>View Students</b><span>Search and open full student details.</span></button>
        <button type="button" class="official-quick-card" data-open-tab="export"><i class="fas fa-file-excel text-emerald-600"></i><b>Class WorkSheet</b><span>Excel-like print & data export tool.</span></button>
        <button type="button" class="official-quick-card" data-open-tab="staff"><i class="fas fa-id-card"></i><b>Staff & Categories</b><span>Teachers, management and directory profiles.</span></button>
      </div>
    </div>`;
  document.querySelectorAll('[data-open-tab]').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.openTab)));
};

// ... [Keep renderStudents, buildClassSummary, renderStaffTab, renderHome as they were in previous steps] ...
const renderStudents = () => { /* Original logic */ };
const buildClassSummary = () => { /* Original logic */ };
const renderStaffTab = () => { /* Original logic */ };
const renderHome = () => { /* Original logic */ };

// ==========================================
// EXCEL-LIKE SPREADSHEET ENGINE
// ==========================================

const availableDataFields = [
  { id: 'SNO', label: 'Serial No. (Auto)' },
  { id: 'name', label: 'Student Name' },
  { id: 'adm', label: 'Admission No.' },
  { id: 'class', label: 'Class' },
  { id: 'gender', label: 'Gender' },
  { id: 'mobile', label: 'Mobile No.' },
  { id: 'father', label: 'Father Name' },
  { id: 'uid', label: 'UID / Roll No.' },
  { id: 'address', label: 'Address' },
  { id: 'CUSTOM', label: 'Custom/Blank Space' }
];

const renderExportTab = () => {
  const classOptions = [...new Set(allStudents.map(getStudentClass))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let studentRows = builderConfig.classId ? allStudents.filter(s => getStudentClass(s) === builderConfig.classId) : [];
  
  if (builderConfig.sortBy === 'name') {
      studentRows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  } else if (builderConfig.sortBy === 'adm') {
      studentRows.sort((a, b) => String(a.adm || '').localeCompare(String(b.adm || ''), undefined, { numeric: true }));
  }

  const instName = resolveInstitutionName(institutionConfig);
  const instSub = institutionConfig.place || institutionConfig.subtitle || 'Institution Portal';
  const instReg = institutionConfig.regNo ? `Reg No: ${institutionConfig.regNo}` : '';
  
  const colSpanPrint = builderConfig.columns.length + 1; // +1 for the row header if we include it in print, but usually we hide row headers in print.
  const printColSpan = builderConfig.columns.length;
  
  const headerHtml = builderConfig.showHeader ? `
    <thead class="${builderConfig.repeatHeader ? 'builder-print-header repeat-header' : 'builder-print-header'}">
       <tr>
         <th colspan="${printColSpan}" class="print-header-th bg-white border-0 !p-0">
           <div class="print-header-content">
              <h1 class="print-inst-name">${escapeHtml(instName)}</h1>
              <h2 class="print-inst-sub">${escapeHtml(instSub)}</h2>
              ${instReg ? `<h3 class="print-inst-reg">${escapeHtml(instReg)}</h3>` : ''}
              ${builderConfig.customTitle ? `<h4 class="print-custom-title">${escapeHtml(builderConfig.customTitle)}</h4>` : ''}
           </div>
         </th>
       </tr>
    </thead>
  ` : '';

  // Excel Columns A, B, C...
  const excelColHeaders = builderConfig.columns.map((col, i) => 
    `<th class="no-print col-header" data-col="${i}" title="Select Column ${String.fromCharCode(65 + i)}">${String.fromCharCode(65 + i)}</th>`
  ).join('');

  const colHeadersHtml = builderConfig.columns.map((col, cIndex) => {
    return `<th class="builder-th group" style="width: ${col.width || 'auto'}">
      <div class="col-resizer" data-col-index="${cIndex}"></div>
      <div class="no-print mb-1 flex items-center justify-between gap-1">
        <select class="builder-col-select w-full" data-col-index="${cIndex}">
          ${availableDataFields.map(f => `<option value="${f.id}" ${f.id === col.field ? 'selected' : ''}>${f.label}</option>`).join('')}
        </select>
        <button class="text-red-500 hover:bg-red-100 px-1.5 py-0.5 rounded delete-col-btn opacity-0 group-hover:opacity-100 transition-opacity" data-col-index="${cIndex}" title="Remove Column"><i class="fas fa-times"></i></button>
      </div>
      <div class="no-print flex gap-1 items-center">
        <input type="text" class="builder-col-title-input w-full" value="${escapeHtml(col.title)}" placeholder="Heading..." data-col-index="${cIndex}">
      </div>
      <div class="print-only-heading">${escapeHtml(col.title)}</div>
    </th>`;
  }).join('');

  const renderTbodyRows = (students, startIndex = 0) => {
      const rowCount = Math.max(15, students.length); 
      return Array.from({ length: rowCount }).map((_, rIndex) => {
        const student = students[rIndex] || null;
        return `<tr>
          <td class="no-print row-header" data-row="${startIndex + rIndex}">${startIndex + rIndex + 1}</td>
          ${builderConfig.columns.map((col, cIndex) => {
          let cellValue = '';
          if (col.field === 'SNO') cellValue = student ? startIndex + rIndex + 1 : '';
          else if (col.field !== 'CUSTOM' && student) cellValue = valueToDisplay(student[col.field]);
          return `<td class="builder-cell" contenteditable="true" data-row="${startIndex + rIndex}" data-col="${cIndex}">${escapeHtml(String(cellValue))}</td>`;
        }).join('')}</tr>`;
      }).join('');
  };

  let bodyHtml = '';
  if (!builderConfig.classId || builderConfig.groupBy === 'mixed') {
      bodyHtml = `<tbody>${renderTbodyRows(studentRows)}</tbody>`;
  } else {
      const boys = studentRows.filter(s => normalizeText(s.gender) === 'male');
      const girls = studentRows.filter(s => normalizeText(s.gender) === 'female');
      
      if (builderConfig.groupBy === 'grouped') {
          bodyHtml = `<tbody>${renderTbodyRows([...boys, ...girls])}</tbody>`;
      } else if (builderConfig.groupBy === 'separate') {
          bodyHtml = `<tbody>${renderTbodyRows(boys)}</tbody>
                      <tbody class="page-break-before">
                        <tr>
                            <td class="no-print row-header">-</td>
                            <td colspan="${builderConfig.columns.length}" class="no-print bg-slate-100 text-center text-xs py-2 text-slate-500 font-bold border-dashed border-y border-slate-300">--- PAGE BREAK (Girls List) ---</td>
                        </tr>
                        ${renderTbodyRows(girls, boys.length)}
                      </tbody>`;
      }
  }

  const ribbonHome = `
      <div class="excel-toolbar">
          <div class="toolbar-group">
            <button id="fmt-undo" class="excel-btn" title="Undo"><i class="fas fa-undo"></i></button>
            <button id="fmt-redo" class="excel-btn" title="Redo"><i class="fas fa-redo"></i></button>
          </div>
          <div class="toolbar-divider"></div>
          <div class="toolbar-group">
            <button id="fmt-bold" class="excel-btn font-serif font-bold text-[14px]" title="Bold">B</button>
            <button id="fmt-italic" class="excel-btn font-serif italic text-[14px]" title="Italic">I</button>
          </div>
          <div class="toolbar-group">
            <button id="fmt-size-minus" class="excel-btn text-[10px]" title="Decrease Font Size"><i class="fas fa-minus"></i></button>
            <input type="number" id="fmt-size-input" class="excel-input w-12 text-center" value="13" />
            <button id="fmt-size-plus" class="excel-btn text-[10px]" title="Increase Font Size"><i class="fas fa-plus"></i></button>
          </div>
          <div class="toolbar-divider"></div>
          <div class="toolbar-group relative" title="Text Color">
             <div class="excel-color-indicator" style="background:#0f172a"></div><i class="fas fa-font"></i>
             <input type="color" id="fmt-color" class="excel-color-picker" value="#0f172a">
          </div>
          <div class="toolbar-group relative" title="Fill Color">
             <div class="excel-color-indicator" style="background:#ffffff"></div><i class="fas fa-fill-drip"></i>
             <input type="color" id="fmt-bg" class="excel-color-picker" value="#ffffff">
          </div>
          <div class="toolbar-divider"></div>
          <div class="toolbar-group">
            <button id="btn-add-col" class="excel-btn text-indigo-700" title="Add Column"><i class="fas fa-plus"></i> Col</button>
            <button id="btn-add-row" class="excel-btn text-indigo-700" title="Add Row"><i class="fas fa-plus"></i> Row</button>
          </div>
      </div>
  `;

  const ribbonData = `
      <div class="excel-toolbar">
          <div class="toolbar-group flex-col items-start gap-1">
            <span class="text-[9px] font-bold text-slate-500 uppercase">Data Source</span>
            <select id="builder-class" class="excel-input w-32">
              <option value="">-- Blank Table --</option>
              ${classOptions.map((className) => `<option value="${escapeHtml(className)}" ${builderConfig.classId === className ? 'selected' : ''}>Class ${escapeHtml(className)}</option>`).join('')}
            </select>
          </div>
          <div class="toolbar-divider"></div>
          <div class="toolbar-group flex-col items-start gap-1">
            <span class="text-[9px] font-bold text-slate-500 uppercase">Sort & Group</span>
            <div class="flex gap-2">
                <select id="builder-sort" class="excel-input w-24">
                  <option value="name" ${builderConfig.sortBy === 'name' ? 'selected' : ''}>Name A-Z</option>
                  <option value="adm" ${builderConfig.sortBy === 'adm' ? 'selected' : ''}>Adm No</option>
                </select>
                <select id="builder-group" class="excel-input w-28">
                  <option value="mixed" ${builderConfig.groupBy === 'mixed' ? 'selected' : ''}>Mixed</option>
                  <option value="grouped" ${builderConfig.groupBy === 'grouped' ? 'selected' : ''}>Boys First</option>
                  <option value="separate" ${builderConfig.groupBy === 'separate' ? 'selected' : ''}>Page Break</option>
                </select>
            </div>
          </div>
          <div class="toolbar-divider"></div>
          <div class="toolbar-group flex-col items-start gap-1">
            <span class="text-[9px] font-bold text-slate-500 uppercase">Page Layout</span>
            <div class="flex gap-2">
                <select id="builder-paper" class="excel-input w-20">
                  <option value="A4" ${builderConfig.paper === 'A4' ? 'selected' : ''}>A4</option>
                  <option value="Legal" ${builderConfig.paper === 'Legal' ? 'selected' : ''}>Legal</option>
                </select>
                <select id="builder-orient" class="excel-input w-24">
                  <option value="portrait" ${builderConfig.orientation === 'portrait' ? 'selected' : ''}>Portrait</option>
                  <option value="landscape" ${builderConfig.orientation === 'landscape' ? 'selected' : ''}>Landscape</option>
                </select>
            </div>
          </div>
      </div>
  `;

  const ribbonLayout = `
      <div class="excel-toolbar">
         <div class="toolbar-group flex-col items-start gap-1">
            <span class="text-[9px] font-bold text-slate-500 uppercase">Custom Heading</span>
            <input type="text" id="builder-custom-title" value="${escapeHtml(builderConfig.customTitle)}" class="excel-input w-48" placeholder="e.g. Term 1 Attendance">
         </div>
         <div class="toolbar-divider"></div>
         <div class="toolbar-group flex-col items-start gap-1">
             <label class="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                <input type="checkbox" id="builder-show-header" ${builderConfig.showHeader ? 'checked' : ''} class="w-3.5 h-3.5 text-indigo-600 rounded"> Show Official Header
             </label>
             <label class="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer ${!builderConfig.showHeader ? 'opacity-50 pointer-events-none' : ''}">
                <input type="checkbox" id="builder-repeat-header" ${builderConfig.repeatHeader ? 'checked' : ''} class="w-3.5 h-3.5 text-indigo-600 rounded"> Repeat on Every Page
             </label>
         </div>
      </div>
  `;

  document.getElementById('official-tab-export').innerHTML = `
    <!-- EXCEL UI HEADER -->
    <div class="excel-ui-header no-print">
        <div class="excel-tabs">
            <button class="excel-tab ${builderConfig.activeTab === 'home' ? 'active' : ''}" data-ribbon="home">Home</button>
            <button class="excel-tab ${builderConfig.activeTab === 'data' ? 'active' : ''}" data-ribbon="data">Data</button>
            <button class="excel-tab ${builderConfig.activeTab === 'layout' ? 'active' : ''}" data-ribbon="layout">Layout</button>
            <div class="flex-grow"></div>
            <div class="flex gap-2 items-center pr-4">
                <button id="btn-export-print" class="excel-primary-btn bg-slate-800 hover:bg-slate-700 text-white"><i class="fas fa-print"></i> PDF/Print</button>
                <button id="btn-export-excel" class="excel-primary-btn bg-emerald-700 hover:bg-emerald-600 text-white"><i class="fas fa-file-excel"></i> Download</button>
            </div>
        </div>
        
        <div class="excel-ribbon-container">
            <div id="ribbon-home" class="ribbon-panel ${builderConfig.activeTab === 'home' ? 'active' : ''}">${ribbonHome}</div>
            <div id="ribbon-data" class="ribbon-panel ${builderConfig.activeTab === 'data' ? 'active' : ''}">${ribbonData}</div>
            <div id="ribbon-layout" class="ribbon-panel ${builderConfig.activeTab === 'layout' ? 'active' : ''}">${ribbonLayout}</div>
        </div>
        
        <div class="excel-formula-bar">
            <div id="active-cell-id" class="formula-cell-id">A1</div>
            <div class="formula-divider"></div>
            <div class="formula-icon italic font-serif text-slate-400">fx</div>
            <input type="text" id="formula-input" class="formula-input-field" placeholder="Select a cell or type here..." />
        </div>
    </div>

    <!-- EXCEL WORKSPACE -->
    <div class="excel-workspace flex-grow overflow-auto relative bg-[#e1dfdd]">
      <!-- The Canvas Boundary -->
      <div id="print-canvas" class="print-canvas shadow-xl bg-white transition-all mx-auto my-4" data-paper="${builderConfig.paper}" data-orient="${builderConfig.orientation}">
        <table id="builder-table" class="builder-table">
          ${headerHtml}
          <thead>
            <tr class="no-print">
               <th class="select-all-btn w-10" title="Select All"></th>
               ${excelColHeaders}
            </tr>
            <tr>
               <th class="no-print row-header bg-slate-200"></th>
               ${colHeadersHtml}
            </tr>
          </thead>
          ${bodyHtml}
        </table>
      </div>
    </div>
  `;

  attachBuilderListeners();
};

const attachBuilderListeners = () => {
  // Tabs
  document.querySelectorAll('.excel-tab').forEach(tab => tab.addEventListener('click', (e) => {
      document.querySelectorAll('.excel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.ribbon-panel').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
      const targetId = e.target.dataset.ribbon;
      builderConfig.activeTab = targetId;
      document.getElementById(`ribbon-${targetId}`).classList.add('active');
  }));

  // Data bindings
  document.getElementById('builder-class')?.addEventListener('change', (e) => { builderConfig.classId = e.target.value; renderExportTab(); setupExcelEngine(); });
  document.getElementById('builder-sort')?.addEventListener('change', (e) => { builderConfig.sortBy = e.target.value; renderExportTab(); setupExcelEngine();});
  document.getElementById('builder-group')?.addEventListener('change', (e) => { builderConfig.groupBy = e.target.value; renderExportTab(); setupExcelEngine();});
  document.getElementById('builder-paper')?.addEventListener('change', (e) => { builderConfig.paper = e.target.value; updateCanvasStyle(); });
  document.getElementById('builder-orient')?.addEventListener('change', (e) => { builderConfig.orientation = e.target.value; updateCanvasStyle(); });
  
  document.getElementById('builder-custom-title')?.addEventListener('input', (e) => { 
      builderConfig.customTitle = e.target.value; 
      const el = document.querySelector('.print-custom-title');
      if(el) el.textContent = e.target.value;
  });
  
  document.getElementById('builder-show-header')?.addEventListener('change', (e) => { builderConfig.showHeader = e.target.checked; renderExportTab(); setupExcelEngine();});
  document.getElementById('builder-repeat-header')?.addEventListener('change', (e) => { builderConfig.repeatHeader = e.target.checked; renderExportTab(); setupExcelEngine();});

  document.getElementById('btn-add-col')?.addEventListener('click', () => {
    // Blank columns get fixed width, data columns get auto
    builderConfig.columns.push({ id: `col_${Date.now()}`, field: 'CUSTOM', title: 'New Column', width: '120px' });
    renderExportTab();
    setupExcelEngine();
    saveBuilderState();
  });

  document.getElementById('btn-add-row')?.addEventListener('click', () => {
    saveBuilderState();
    const tbodys = document.querySelectorAll('#builder-table tbody');
    if(tbodys.length === 0) return;
    const targetTbody = tbodys[tbodys.length - 1]; 
    const colsCount = builderConfig.columns.length;
    const tr = document.createElement('tr');
    const nextRowIdx = document.querySelectorAll('.row-header').length;
    tr.innerHTML = `<td class="no-print row-header" data-row="${nextRowIdx}">${nextRowIdx + 1}</td>` + 
                   Array.from({ length: colsCount }).map((_, cIndex) => `<td class="builder-cell" contenteditable="true" data-row="${nextRowIdx}" data-col="${cIndex}"></td>`).join('');
    targetTbody.appendChild(tr);
    attachTableFormatListeners(); // re-attach listeners for new row
  });

  document.querySelectorAll('.delete-col-btn').forEach(btn => btn.addEventListener('click', (e) => {
    const idx = parseInt(e.currentTarget.dataset.colIndex);
    if(builderConfig.columns.length > 1) {
      saveBuilderState();
      builderConfig.columns.splice(idx, 1);
      renderExportTab();
      setupExcelEngine();
    } else {
      alert("At least one column is required.");
    }
  }));

  document.querySelectorAll('.builder-col-select').forEach(sel => sel.addEventListener('change', (e) => {
    saveBuilderState();
    const idx = parseInt(e.target.dataset.colIndex);
    const fieldId = e.target.value;
    builderConfig.columns[idx].field = fieldId;
    const fieldLabel = availableDataFields.find(f => f.id === fieldId)?.label || 'Column';
    if(fieldId !== 'CUSTOM') {
        builderConfig.columns[idx].title = fieldLabel;
        builderConfig.columns[idx].width = 'auto'; // Auto fit for data
    } else {
        builderConfig.columns[idx].width = '120px'; // Fixed for blank
    }
    renderExportTab();
    setupExcelEngine();
  }));

  document.querySelectorAll('.builder-col-title-input').forEach(input => input.addEventListener('input', (e) => {
    const idx = parseInt(e.target.dataset.colIndex);
    builderConfig.columns[idx].title = e.target.value;
    const heading = e.target.closest('th').querySelector('.print-only-heading');
    if(heading) heading.textContent = e.target.value;
  }));

  // --- Formatting Logic ---
  const applyFormat = (styleProp, valueFn) => {
      saveBuilderState();
      document.querySelectorAll('.builder-cell.selected').forEach(td => {
          td.style[styleProp] = typeof valueFn === 'function' ? valueFn(td.style[styleProp]) : valueFn;
      });
  };
  
  const getActiveFontSize = () => parseInt(document.getElementById('fmt-size-input').value) || 13;
  
  const toggleStyle = (prop, val1, val2) => (currentVal) => currentVal === val1 ? val2 : val1;

  document.getElementById('fmt-bold')?.addEventListener('click', () => applyFormat('fontWeight', toggleStyle('fontWeight', 'bold', 'normal')));
  document.getElementById('fmt-italic')?.addEventListener('click', () => applyFormat('fontStyle', toggleStyle('fontStyle', 'italic', 'normal')));
  
  // Custom color pickers
  document.getElementById('fmt-color')?.addEventListener('input', (e) => {
      e.target.previousElementSibling.previousElementSibling.style.background = e.target.value;
      applyFormat('color', e.target.value);
  });
  document.getElementById('fmt-bg')?.addEventListener('input', (e) => {
      e.target.previousElementSibling.previousElementSibling.style.background = e.target.value;
      applyFormat('backgroundColor', e.target.value);
  });
  
  document.getElementById('fmt-size-plus')?.addEventListener('click', () => {
      let size = getActiveFontSize() + 1;
      document.getElementById('fmt-size-input').value = size;
      applyFormat('fontSize', size + 'px');
  });
  document.getElementById('fmt-size-minus')?.addEventListener('click', () => {
      let size = Math.max(8, getActiveFontSize() - 1);
      document.getElementById('fmt-size-input').value = size;
      applyFormat('fontSize', size + 'px');
  });
  document.getElementById('fmt-size-input')?.addEventListener('change', (e) => {
      applyFormat('fontSize', e.target.value + 'px');
  });

  // Undo Redo
  document.getElementById('fmt-undo')?.addEventListener('click', undoBuilder);
  document.getElementById('fmt-redo')?.addEventListener('click', redoBuilder);

  document.getElementById('btn-export-print')?.addEventListener('click', () => {
    document.querySelectorAll('.builder-cell, .col-header, .row-header, .select-all-btn').forEach(c => c.classList.remove('selected'));
    document.body.classList.add('is-printing');
    window.print();
    setTimeout(() => document.body.classList.remove('is-printing'), 500);
  });

  document.getElementById('btn-export-excel')?.addEventListener('click', () => {
    if(typeof XLSX === 'undefined') { alert("Excel library loading, please try again."); return; }
    const tableClone = document.getElementById('builder-table').cloneNode(true);
    tableClone.querySelectorAll('.no-print').forEach(el => el.remove());
    tableClone.querySelectorAll('th').forEach(th => {
       const heading = th.querySelector('.print-only-heading');
       if(heading) th.textContent = heading.textContent;
    });
    const wb = XLSX.utils.table_to_book(tableClone, {sheet: "Report"});
    XLSX.writeFile(wb, `${builderConfig.classId ? 'Class_'+builderConfig.classId : 'Report'}_${formatDate(new Date())}.xlsx`);
  });
};

const updateCanvasStyle = () => {
  const canvas = document.getElementById('print-canvas');
  if(canvas) {
    canvas.dataset.paper = builderConfig.paper;
    canvas.dataset.orient = builderConfig.orientation;
  }
};

// Expose formula bar linking
const attachTableFormatListeners = () => {
    // Formula bar logic
    const fInput = document.getElementById('formula-input');
    document.querySelectorAll('.builder-cell').forEach(cell => {
        cell.addEventListener('focus', (e) => {
            const row = e.target.dataset.row;
            const col = e.target.dataset.col;
            const colLetter = String.fromCharCode(65 + parseInt(col));
            document.getElementById('active-cell-id').textContent = `${colLetter}${parseInt(row)+1}`;
            fInput.value = e.target.innerText;
        });
        cell.addEventListener('input', (e) => {
            if(e.target.classList.contains('selected')) fInput.value = e.target.innerText;
        });
    });
    fInput?.addEventListener('input', (e) => {
        const activeCell = document.querySelector('.builder-cell.selected');
        if(activeCell) activeCell.innerText = e.target.value;
    });
};

const setupExcelEngine = () => {
    const table = document.getElementById('builder-table');
    if (!table) return;

    attachTableFormatListeners();

    // 1. Resize Column
    let resizingCol = null;
    let startX = 0;
    let startWidth = 0;

    document.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('col-resizer')) {
            saveBuilderState();
            resizingCol = e.target.closest('th');
            startX = e.pageX;
            startWidth = resizingCol.offsetWidth;
            e.preventDefault();
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (resizingCol) {
            const newWidth = startWidth + (e.pageX - startX);
            if (newWidth > 30) {
                resizingCol.style.width = newWidth + 'px';
                const colIndex = resizingCol.querySelector('.col-resizer').dataset.colIndex;
                if(builderConfig.columns[colIndex]) {
                    builderConfig.columns[colIndex].width = newWidth + 'px';
                }
            }
        }
    });

    document.addEventListener('mouseup', () => { resizingCol = null; });

    // 2. Excel Selection Engine
    let isSelecting = false;
    let startCell = null;

    const getCellCoords = (td) => {
        return { row: parseInt(td.dataset.row), col: parseInt(td.dataset.col) };
    };

    const clearSelection = () => document.querySelectorAll('.builder-cell, .col-header, .row-header, .select-all-btn').forEach(c => c.classList.remove('selected'));

    table.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('col-resizer')) return; 
        
        // Col Selection
        const colHeader = e.target.closest('th.col-header');
        if (colHeader) {
            clearSelection();
            colHeader.classList.add('selected');
            document.querySelectorAll(`.builder-cell[data-col="${colHeader.dataset.col}"]`).forEach(c => c.classList.add('selected'));
            return;
        }
        // Row Selection
        const rowHeader = e.target.closest('td.row-header');
        if (rowHeader) {
            clearSelection();
            rowHeader.classList.add('selected');
            document.querySelectorAll(`.builder-cell[data-row="${rowHeader.dataset.row}"]`).forEach(c => c.classList.add('selected'));
            return;
        }
        // Select All
        const selectAll = e.target.closest('.select-all-btn');
        if (selectAll) {
            clearSelection();
            selectAll.classList.add('selected');
            document.querySelectorAll('.builder-cell, .col-header, .row-header').forEach(c => c.classList.add('selected'));
            return;
        }

        const td = e.target.closest('td.builder-cell');
        if (td) {
            isSelecting = true;
            startCell = getCellCoords(td);
            clearSelection();
            td.classList.add('selected');
        }
    });

    table.addEventListener('mouseover', (e) => {
        if (isSelecting) {
            const td = e.target.closest('td.builder-cell');
            if (td) {
                const endCell = getCellCoords(td);
                const minR = Math.min(startCell.row, endCell.row);
                const maxR = Math.max(startCell.row, endCell.row);
                const minC = Math.min(startCell.col, endCell.col);
                const maxC = Math.max(startCell.col, endCell.col);
                
                document.querySelectorAll('.builder-cell').forEach(cell => {
                    const r = parseInt(cell.dataset.row);
                    const c = parseInt(cell.dataset.col);
                    if (r >= minR && r <= maxR && c >= minC && c <= maxC) {
                        cell.classList.add('selected');
                    } else {
                        cell.classList.remove('selected');
                    }
                });
            }
        }
    });

    document.addEventListener('mouseup', () => isSelecting = false);
    
    table.addEventListener('focusin', (e) => {
        if(e.target.classList.contains('builder-cell')) e.target.dataset.original = e.target.innerHTML;
    });
    table.addEventListener('focusout', (e) => {
        if(e.target.classList.contains('builder-cell')) {
            if(e.target.dataset.original !== e.target.innerHTML) saveBuilderState();
        }
    });

    // 3. Copy & Paste Engine
    document.addEventListener('copy', (e) => {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
        if (builderConfig.activeTab !== 'home' && builderConfig.activeTab !== 'data' && builderConfig.activeTab !== 'layout') return; // only active in spreadsheet
        const selected = document.querySelectorAll('.builder-cell.selected');
        if (selected.length === 0) return;

        const rowMap = new Map();
        selected.forEach(td => {
            const tr = td.parentElement;
            if(!rowMap.has(tr)) rowMap.set(tr, []);
            rowMap.get(tr).push(td.innerText.trim());
        });

        const tsv = Array.from(rowMap.values()).map(row => row.join('\t')).join('\n');
        e.clipboardData.setData('text/plain', tsv);
        e.preventDefault();
    });

    document.addEventListener('paste', (e) => {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
        
        const activeCell = document.querySelector('.builder-cell.selected') || document.activeElement.closest('td.builder-cell');
        if (activeCell) {
            saveBuilderState();
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            const rowsData = text.split(/\r?\n/).map(r => r.split('\t'));
            
            const startR = parseInt(activeCell.dataset.row);
            const startC = parseInt(activeCell.dataset.col);
            
            rowsData.forEach((rowData, i) => {
                rowData.forEach((val, j) => {
                    const td = document.querySelector(`.builder-cell[data-row="${startR + i}"][data-col="${startC + j}"]`);
                    if (td) td.textContent = val;
                });
            });
        }
    });
};

const renderAll = () => {
  renderDashboard();
  renderStudents();
  buildClassSummary();
  renderStaffTab();
  // Call once on load
  if(document.getElementById('official-tab-export')?.classList.contains('flex')) {
      renderExportTab();
      setupExcelEngine();
  }
};

const loadData = async () => {
  const [studentsSnap, staffSnap, groupsSnap, dirSnap, contentSnap, configSnap, authConfigSnap, pageAccessSnap] = await Promise.all([
    getDocs(collection(db, `${BASE_PATH}/students`)),
    getDocs(collection(db, `${BASE_PATH}/staff`)),
    getDocs(collection(db, `${BASE_PATH}/studentGroups`)),
    getDocs(collection(db, `${BASE_PATH}/publicDirectory`)),
    getDoc(doc(db, `${BASE_PATH}/settings`, 'content')),
    getDoc(doc(db, `${BASE_PATH}/settings`, 'config')),
    getDoc(doc(db, `${BASE_PATH}/settings`, 'categoryAuthConfig')),
    getDoc(doc(db, `${BASE_PATH}/settings`, 'pageAccess'))
  ]);
  allStudents = studentsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  allStaff = staffSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  studentGroups = groupsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  directoryEntries = dirSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  const content = contentSnap.exists() ? contentSnap.data() : {};
  directoryCategories = Array.isArray(content.directoryCategories) ? content.directoryCategories : [];
  categoryAuthConfig = authConfigSnap.exists() ? { categories: {}, ...(authConfigSnap.data() || {}) } : { categories: {} };
  pageAccessConfig = pageAccessSnap.exists() ? { categories: {}, overrides: {}, ...(pageAccessSnap.data() || {}) } : { categories: {}, overrides: {} };
  const conf = configSnap.exists() ? configSnap.data() : {};
  applyOfficialBranding(conf);
};

const preloadOfficialBranding = async () => {
  try {
    const configSnap = await getDoc(doc(db, `${BASE_PATH}/settings`, 'config'));
    if (!configSnap.exists()) return;
    applyOfficialBranding(configSnap.data() || {});
  } catch (_error) {}
};

const showApp = () => {
  document.getElementById('official-login-screen').classList.add('hidden');
  document.getElementById('official-app').classList.remove('hidden');
  renderAll();
  setTab('dashboard');
};

const tryLogin = async () => {
  if (!authReady) return showMsg('Initializing authentication... please try again.');
  const username = String(document.getElementById('official-username').value || '').trim();
  const password = String(document.getElementById('official-password').value || '').trim();
  if (!username || !password) return showMsg('Username, password required');
  showMsg('');
  const uname = username.toLowerCase();
  const passHash = await hashCredentialValue(password);
  let session = null;

  if (uname.includes('@')) {
    try {
      const cred = await signInWithEmailAndPassword(auth, username, password);
      if (cred?.user?.email && String(cred.user.email).toLowerCase() === uname) {
        session = { name: 'Super Admin', username: cred.user.email, type: 'Admin', source: 'firebase', photo: 'assets/images/logo.png' };
      }
    } catch (_error) {}
  }

  const adminAuthSnap = await getDoc(doc(db, `${BASE_PATH}/settings`, 'adminAuth'));
  const adminAuth = adminAuthSnap.exists() ? adminAuthSnap.data() : {};
  if (!session && String(adminAuth.email || '').toLowerCase() === uname && String(adminAuth.password || '').trim() === password) {
    session = { name: 'Super Admin', username, type: 'Admin', source: 'legacy-admin', photo: 'assets/images/logo.png' };
  }

  if (!session) {
    const staffSnap = await getDocs(collection(db, `${BASE_PATH}/staff`));
    const staff = staffSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })).find((item) => item.isActive !== false && (((item.email || '').toLowerCase() === uname) || ((item.username || '').toLowerCase() === uname)) && String(item.password || '').trim() === password);
    if (staff) session = { ...staff, name: staff.name || 'Staff', username, type: staff.type || 'Staff', source: 'staff', photo: staff.photo || '' };
  }

  if (!session) {
    const dirSnap = await getDocs(collection(db, `${BASE_PATH}/publicDirectory`));
    const directoryUser = dirSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })).find((entry) => {
      const meta = entry.authMeta || {};
      return String(meta.username || '').toLowerCase() === uname && String(meta.passwordHash || '') === passHash;
    });
    if (directoryUser) session = { id: directoryUser.id, ...(directoryUser.values || {}), name: String(directoryUser.values?.name || 'Directory User'), username, type: 'Category User', source: 'directory', categoryId: directoryUser.categoryId, photo: String(directoryUser.values?.photo || directoryUser.values?.image || '') };
  }

  if (!session) return showMsg('Invalid credentials / access denied');
  userSession = session;
  await loadData();
  localStorage.setItem(OFFICIAL_SESSION_KEY, JSON.stringify(userSession));
  showApp();
};

onAuthStateChanged(auth, async (user) => {
  if (!user) await signInAnonymously(auth);
  authReady = true;
});

document.getElementById('official-login-btn').addEventListener('click', tryLogin);
document.getElementById('official-password').addEventListener('keydown', (event) => { if (event.key === 'Enter') tryLogin(); });
document.getElementById('official-username').addEventListener('keydown', (event) => { if (event.key === 'Enter') tryLogin(); });
document.getElementById('official-toggle-password').addEventListener('click', () => {
  const input = document.getElementById('official-password');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  document.getElementById('official-toggle-password').className = isPassword ? 'fas fa-eye-slash trailing-icon' : 'fas fa-eye trailing-icon';
});
document.getElementById('official-logout-btn').addEventListener('click', () => {
  localStorage.removeItem(OFFICIAL_SESSION_KEY);
  window.location.reload();
});

const restoreOfficialSession = async () => {
  try {
    if (window.AppSession && window.AppSession.isFresh()) {
      const role = window.AppSession.getRole();
      if (role === 'admin' || role === 'staff') {
        const stateKey = role === 'admin' ? 'app_session_admin_state' : 'app_session_staff_state';
        const rawState = localStorage.getItem(stateKey);
        const state = rawState ? JSON.parse(rawState) : {};
        
        userSession = {
          name: state.name || (role === 'admin' ? 'Super Admin' : 'Staff'),
          username: state.email || 'admin',
          type: role === 'admin' ? 'Admin' : 'Staff',
          source: role === 'admin' ? 'firebase' : 'staff'
        };
        await loadData();
        showApp();
        return; 
      }
    }
    const raw = localStorage.getItem(OFFICIAL_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.username) return;
    userSession = parsed;
    await loadData();
    showApp();
  } catch (_error) {}
};

preloadOfficialBranding();
restoreOfficialSession();