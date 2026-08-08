// ─────────────────────────────────────────
// PAPER HTML SERVICE
// ─────────────────────────────────────────
// This is the single source of truth for what a generated paper looks like.
// It is a direct port of the HTML/CSS generator used on the frontend for
// PDF export (papers/page.tsx & builder/page.tsx — those two are kept in
// sync with each other). generateDocx() converts this same HTML straight
// to a .docx via html-to-docx, so PDF and DOCX can no longer drift apart —
// there is only one place that defines what a paper looks like.
//
// If you change how a paper is laid out, change it here. Do not hand-edit
// docxService.ts's output directly — it just converts whatever this
// function returns.

import type { PaperData, Section, Question, McqOption } from '../types';

// ── MCQ option normalization (ported from the frontend builder/papers page) ──

type CleanOption = { label: string; text: string };

function splitOptions(text: string): { questionText: string; options: CleanOption[] } {
  const options: CleanOption[] = [];
  if (!text?.trim()) return { questionText: '', options: [] };
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const p1 = /\(([abcdABCD])\)\s*(.*?)(?=\s*\([abcdABCD]\)\s*|\s*$)/gi;
  const p2 = /\b([abcdABCD])\)\s*(.*?)(?=\s+[abcdABCD]\)\s*|\s*$)/g;
  const p3 = /\b([ABCD])\.\s*(.*?)(?=\s+[ABCD]\.\s*|\s*$)/g;
  let matches: RegExpMatchArray[] = [];
  let usedPattern = 0;
  matches = [...normalizedText.matchAll(p1)];
  if (matches.length >= 2) usedPattern = 1;
  if (matches.length < 2) {
    matches = [...normalizedText.matchAll(p2)];
    if (matches.length >= 2) usedPattern = 2;
  }
  if (matches.length < 2) {
    matches = [...normalizedText.matchAll(p3)];
    if (matches.length >= 2) usedPattern = 3;
  }
  if (matches.length < 2) return { questionText: text.trim(), options: [] };
  for (const m of matches) {
    const label = m[1].toLowerCase();
    const optText = m[2]
      .trim()
      .replace(/\s*\([abcdABCD]\)\s*$/, '')
      .replace(/\s+[abcdABCD]\)\s*$/, '')
      .replace(/\s+[ABCD]\.\s*$/, '')
      .trim();
    if (!options.find(o => o.label === label) && optText) {
      options.push({ label, text: optText });
    }
  }
  let questionText = normalizedText;
  if (usedPattern === 1) {
    const idx = normalizedText.search(/\s*\([abcdABCD]\)/i);
    if (idx > 0) questionText = normalizedText.substring(0, idx).trim();
  } else if (usedPattern === 2) {
    const idx = normalizedText.search(/\s+[abcdABCD]\)/);
    if (idx > 0) questionText = normalizedText.substring(0, idx).trim();
  } else if (usedPattern === 3) {
    const idx = normalizedText.search(/\s+[ABCD]\./);
    if (idx > 0) questionText = normalizedText.substring(0, idx).trim();
  }
  questionText = questionText.replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '').trim();
  return { questionText, options };
}

function normalizeOptions(
  rawOptions: McqOption[] | undefined,
  questionText: string
): { cleanedQuestionText: string; fixedOptions: CleanOption[] } {
  let fixedOptions: CleanOption[] = rawOptions
    ? rawOptions.map(o => ({ label: (o.label || '').toLowerCase(), text: o.text || '' }))
    : [];
  let cleanedQuestionText = questionText || '';

  if (fixedOptions.length === 1 && fixedOptions[0].text.trim().length > 20) {
    const s = splitOptions(fixedOptions[0].text);
    if (s.options.length >= 2) fixedOptions = s.options;
  }
  if (fixedOptions.length === 2) {
    const combined = fixedOptions.map(o => `(${o.label}) ${o.text}`).join(' ');
    const s = splitOptions(combined);
    if (s.options.length >= 3) fixedOptions = s.options;
  }
  if (fixedOptions.length === 0 && cleanedQuestionText) {
    const s = splitOptions(cleanedQuestionText);
    if (s.options.length >= 2) {
      cleanedQuestionText = s.questionText;
      fixedOptions = s.options;
    }
  }
  if (fixedOptions.length >= 2 && cleanedQuestionText) {
    const hasInline = /\([abcd]\)|\b[A-D]\./i.test(cleanedQuestionText);
    if (hasInline) {
      const s = splitOptions(cleanedQuestionText);
      if (s.options.length >= 2) {
        cleanedQuestionText = s.questionText;
        s.options.forEach(opt => {
          if (!fixedOptions.find(o => o.label === opt.label)) fixedOptions.push(opt);
        });
      }
    }
  }
  fixedOptions = fixedOptions
    .map(opt => ({
      label: opt.label.toLowerCase(),
      text: opt.text
        .replace(/\s*\([abcdABCD]\)\s*.*$/i, '')
        .replace(/\s+[abcdABCD]\)\s*.*$/i, '')
        .replace(/\s+[ABCD]\.\s*.*$/i, '')
        .replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '')
        .trim(),
    }))
    .filter(opt => opt.text.length > 0);

  const seen = new Set<string>();
  fixedOptions = fixedOptions.filter(opt => {
    if (!opt.label || seen.has(opt.label)) return false;
    seen.add(opt.label);
    return true;
  });

  fixedOptions.sort((a, b) => a.label.localeCompare(b.label));
  return { cleanedQuestionText, fixedOptions };
}

// ── CSS per template — kept byte-identical to the frontend's PDF CSS ──

const defaultCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Times New Roman',serif;font-size:13px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:18mm;width:210mm;margin:0 auto;min-height:297mm;position:relative}.header{text-align:center;margin-bottom:8px}.inst-name{font-size:22px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#1a2e5a}.inst-addr{font-size:12px;color:#555;margin-top:2px}.thick-div{border-top:2px solid #1a2e5a;margin:7px 0}.thin-div{border-top:1px solid #1a2e5a;margin:5px 0}.meta-table{width:100%;border-collapse:collapse;font-size:14.5px;margin:4px 0}.meta-table td{padding:2px 0}.paper-title{text-align:center;font-size:15px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:#1a2e5a;margin:5px 0;text-decoration:underline}.instructions{font-size:14px;margin-bottom:6px}.inst-title{font-weight:bold;text-decoration:underline;margin-bottom:3px}.instructions ol{padding-left:18px;line-height:1.4}.section{margin-bottom:10px}.section-header{text-align:center;border:1px solid #1a2e5a;padding:4px 8px;font-weight:bold;font-size:15px;text-transform:uppercase;color:#1a2e5a;background:#f0f4ff;margin:10px 0 8px}.section-marks{font-size:13px;font-weight:normal}.question{margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:22px;padding-top:1px}.q-text{display:block;margin-left:28px;line-height:1.4;font-size:13px}.q-marks{font-weight:bold;font-size:13px;color:#1a2e5a;min-width:28px;text-align:right;flex-shrink:0;padding-top:1px}.mcq-options{margin-top:5px;margin-left:28px}.mcq-option{display:inline-block;width:47%;vertical-align:top;font-size:13px;margin-bottom:4px}.opt-label{font-weight:bold;display:inline-block;min-width:20px}.tf-options{margin-top:5px;margin-left:28px}.tf-options span{display:inline-block;margin-right:24px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:60%;margin-left:28px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:16px;margin:4px 0 4px 28px}`;

const classicCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Times New Roman',serif;font-size:13px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:18mm;width:210mm;margin:0 auto;min-height:297mm}.inst-name{text-align:center;font-size:22px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:4px}.classic-meta-row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:13px;padding-bottom:6px;border-bottom:1px solid #888;margin-bottom:6px}.thin-div{border-top:1px solid #555;margin:5px 0}.paper-title{text-align:center;font-size:15px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:#111;margin:5px 0}.instructions{font-size:14px;margin-bottom:6px}.inst-title{font-weight:bold;text-decoration:underline;margin-bottom:3px}.instructions ol{padding-left:18px;line-height:1.4}.section{margin-bottom:10px}.section-header{text-align:center;border:1px solid #333;padding:4px 8px;font-weight:bold;font-size:15px;text-transform:uppercase;color:#111;background:#f5f5f5;margin:10px 0 8px}.section-marks{font-size:13px;font-weight:normal}.question{margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:22px;padding-top:1px}.q-text{display:block;margin-left:28px;line-height:1.4;font-size:13px}.mcq-options-inline{margin-top:5px;margin-left:28px;font-size:13px}.mcq-opt-inline{display:inline-block;width:24%;vertical-align:top;white-space:nowrap}.opt-label{font-weight:bold;margin-right:4px}.tf-options{margin-top:5px;margin-left:28px}.tf-options span{display:inline-block;margin-right:24px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:60%;margin-left:28px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:16px;margin:4px 0 4px 28px}`;

const worksheetCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Calibri',sans-serif;font-size:12px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:14mm;width:210mm;margin:0 auto;min-height:297mm}.ws-title{text-align:center;font-size:16px;font-weight:bold;text-transform:uppercase;color:#1F2937;margin-bottom:6px;letter-spacing:1px}.ws-name-row{display:flex;justify-content:space-between;font-size:10px;padding:4px 0;border-top:1px solid #1F2937;border-bottom:1px solid #1F2937;margin-bottom:8px}.section{margin-bottom:4px}.section-header{text-align:center;border:1px solid #1F2937;padding:2px 6px;font-weight:bold;font-size:10px;text-transform:uppercase;color:#1F2937;background:#F3F4F6;margin:4px 0}.section-marks{font-size:9px;font-weight:normal}.question{margin-bottom:4px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:18px}.q-text{display:block;margin-left:22px;line-height:1.4;font-size:13px}.mcq-options-inline{margin-top:4px;margin-left:22px;font-size:13px}.mcq-opt-inline{display:inline-block;width:24%;vertical-align:top;white-space:nowrap}.opt-label{font-weight:bold;margin-right:4px}.tf-options{margin-top:5px;margin-left:22px}.tf-options span{display:inline-block;margin-right:16px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:55%;margin-left:22px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:14px;margin:2px 0 2px 22px}.ws-footer{text-align:right;font-size:9px;color:#666;border-top:1px solid #ddd;margin-top:8px;padding-top:4px}`;

const professionalCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Arial',sans-serif;font-size:13px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:18mm;width:210mm;margin:0 auto;min-height:297mm}.pro-header{display:flex;align-items:stretch;gap:14px;margin-bottom:10px}.pro-logo{width:80px;height:80px;border-radius:50%;border:2px solid #1F2937;display:flex;align-items:center;justify-content:center;flex-shrink:0}.pro-logo-inner{font-size:10px;color:#aaa;text-align:center;line-height:1.3}.pro-info{flex:1;border:2px solid #1F2937;border-radius:4px;overflow:hidden}.pro-info-name{font-weight:bold;font-size:16px;color:#fff;text-transform:uppercase;letter-spacing:0.5px;background:#1F2937;padding:7px 12px}.pro-info-divider{height:1px;background:#e5e7eb}.pro-info-line{font-size:10.5px;color:#333;padding:3px 12px;line-height:1.6}.pro-meta-row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;font-size:11px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:6px 10px;margin-bottom:8px}.thin-div{border-top:1px solid #1F2937;margin:6px 0}.paper-title{text-align:center;font-size:15px;font-weight:bold;text-transform:uppercase;color:#1F2937;margin:8px 0 6px;text-decoration:underline;letter-spacing:2px}.section{margin-bottom:10px}.section-header{text-align:center;border:1px solid #1F2937;padding:4px 8px;font-weight:bold;font-size:12px;text-transform:uppercase;color:#1F2937;background:#f0f4ff;margin:10px 0 8px}.section-marks{font-size:10px;font-weight:normal}.question{margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:22px}.q-text{display:block;margin-left:28px;line-height:1.4;font-size:13px}.mcq-options{margin-top:5px;margin-left:28px}.mcq-option{display:inline-block;width:47%;vertical-align:top;font-size:13px;margin-bottom:4px}.mcq-opt-inline{display:inline-block;width:24%;vertical-align:top;white-space:nowrap}.opt-label{font-weight:bold;margin-right:4px}.tf-options{margin-top:5px;margin-left:28px}.tf-options span{display:inline-block;margin-right:24px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:60%;margin-left:28px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:16px;margin:4px 0 4px 28px}.sig-block{margin-top:30px;display:flex;justify-content:space-between}.sig-line{text-align:center;width:30%}.sig-line div{border-top:1px solid #999;padding-top:5px;font-size:10px;color:#555}`;

/**
 * Builds the exact same HTML a paper's PDF export uses, from server-side
 * paper data. Kept in lockstep with papers/page.tsx & builder/page.tsx —
 * if those change, port the change here too.
 */
export function generatePaperHtml(paper: PaperData, templateKey: string): string {
  const ed = paper.examDetails;
  const sections = paper.sections || [];
  const totalMarks = paper.totalMarks;
  const paperTitle = paper.title || 'Question Paper';
  const tmplId = templateKey || 'tpl_classic';
  const isClassic = tmplId === 'tpl_classic';
  const isWorksheet = tmplId === 'tpl_worksheet';
  const isProfessional = tmplId === 'tpl_professional';
  const dateStr = ed.date
    ? new Date(ed.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : '—';

  const renderOptions = (opts: McqOption[] | undefined, qt: string) => {
    const { fixedOptions } = normalizeOptions(opts, qt);
    const o =
      fixedOptions.length > 0
        ? fixedOptions
        : [
            { label: 'a', text: '___' },
            { label: 'b', text: '___' },
            { label: 'c', text: '___' },
            { label: 'd', text: '___' },
          ];
    if (isClassic || isWorksheet) {
      return `<div class="mcq-options-inline">${o
        .map(x => `<span class="mcq-opt-inline"><span class="opt-label">(${x.label})</span> ${x.text}</span>`)
        .join('')}</div>`;
    }
    return `<div class="mcq-options">${o
      .map(x => `<div class="mcq-option"><span class="opt-label">(${x.label})</span> ${x.text}</div>`)
      .join('')}</div>`;
  };

  const lines = (n: number) =>
    Array.from({ length: n }).map(() => '<div class="answer-line"></div>').join('');

  const sectionsHTML = sections
    .map((section: Section) => {
      const marksInfo = section.marksPerQuestion
        ? `(${section.marksPerQuestion} Mark${section.marksPerQuestion > 1 ? 's' : ''} Each)`
        : section.totalMarks
        ? `[Total: ${section.totalMarks} Marks]`
        : '';
      const questionsHTML = section.questions
        .map((q: Question) => {
          const { cleanedQuestionText } = normalizeOptions(q.options, q.text);
          let a = '';
          if (q.type === 'MCQ') a = renderOptions(q.options, q.text);
          else if (q.type === 'TRUE_FALSE')
            a = '<div class="tf-options"><span><strong>(a)</strong> True</span><span><strong>(b)</strong> False</span></div>';
          else if (q.type === 'FILL_IN_BLANK') a = '<div class="fill-line"></div>';
          else if (q.type === 'SHORT_ANSWER') a = '';
          else if (q.type === 'LONG_ANSWER') a = '';
          else if (q.type === 'DIAGRAM') a = lines(8);
          else a = lines(2);
          return `<div class="question"><div class="q-row"><span class="q-num">${q.number}.</span><span class="q-text">${cleanedQuestionText || q.text}</span></div>${a}</div>`;
        })
        .join('');
      return `<div class="section"><div class="section-header">${section.title}${
        marksInfo ? ` <span class="section-marks">${marksInfo}</span>` : ''
      }</div>${section.description ? `<div class="section-desc">${section.description}</div>` : ''}${questionsHTML}</div>`;
    })
    .join('');

  const instructionsHTML =
    ed.instructions && ed.instructions.length > 0
      ? `<div class="instructions"><div class="inst-title">General Instructions:</div><ol>${ed.instructions
          .map(i => `<li>${i}</li>`)
          .join('')}</ol></div><div class="thin-div"></div>`
      : '';

  const css = isClassic ? classicCss : isWorksheet ? worksheetCss : isProfessional ? professionalCss : defaultCss;

  let bodyHTML = '';
  if (isClassic) {
    bodyHTML = `<div class="paper-wrap"><div class="inst-name">${ed.institutionName || 'Institution Name'}</div><div class="thin-div"></div><div class="classic-meta-row"><span><strong>Name:</strong> ___________________</span><span><strong>Class:</strong> ${ed.class || '—'}</span><span><strong>Date:</strong> ${dateStr}</span><span><strong>Max. Marks:</strong> ${totalMarks || ed.totalMarks || '—'}</span></div><div class="paper-title">${ed.examType || 'Question Paper'}</div><div class="thin-div"></div>${instructionsHTML}${sectionsHTML}</div>`;
  } else if (isWorksheet) {
    bodyHTML = `<div class="paper-wrap"><div class="ws-title">${paperTitle || ed.examType || 'Worksheet'}</div><div class="ws-name-row"><span><strong>Name:</strong> _____________________________</span><span><strong>Date:</strong> ${dateStr}</span></div>${sectionsHTML}<div class="ws-footer">${ed.institutionName || ''}</div></div>`;
  } else if (isProfessional) {
    const infoLines = [
      ed.institutionAddress ? `<div class="pro-info-line">📍 ${ed.institutionAddress}</div>` : '',
      ed.department ? `<div class="pro-info-line">🏫 Dept. of ${ed.department}</div>` : '',
      ed.facultyName ? `<div class="pro-info-line">👤 Faculty: ${ed.facultyName}</div>` : '',
    ]
      .filter(Boolean)
      .join('');
    bodyHTML = `<div class="paper-wrap"><div class="pro-header"><div class="pro-logo"><div class="pro-logo-inner">LOGO</div></div><div class="pro-info"><div class="pro-info-name">${(ed.institutionName || 'INSTITUTION NAME').toUpperCase()}</div><div class="pro-info-divider"></div>${infoLines}</div></div><div class="pro-meta-row"><span><strong>Subject:</strong> ${ed.subject || '—'}</span><span><strong>Class:</strong> ${ed.class || '—'}</span><span><strong>Date:</strong> ${dateStr}</span><span><strong>Duration:</strong> ${ed.duration || '3 Hrs'}</span><span><strong>Max. Marks:</strong> ${totalMarks || ed.totalMarks || '—'}</span></div><div class="thin-div"></div><div class="paper-title">${ed.examType || 'Question Paper'}</div><div class="thin-div"></div>${sectionsHTML}<div class="thin-div"></div><div class="sig-block"><div class="sig-line"><div>Subject Teacher</div></div><div class="sig-line"><div>HOD / Principal</div></div><div class="sig-line"><div>Exam Controller</div></div></div></div>`;
  } else {
    bodyHTML = `<div class="paper-wrap"><div class="header"><div class="inst-name">${ed.institutionName || 'Institution Name'}</div>${ed.institutionAddress ? `<div class="inst-addr">${ed.institutionAddress}</div>` : ''}</div><div class="thick-div"></div><table class="meta-table"><tr><td><strong>Subject:</strong> ${ed.subject || '—'}</td><td style="text-align:right"><strong>Date:</strong> ${dateStr}</td></tr><tr><td><strong>Class:</strong> ${ed.class || '—'}</td><td style="text-align:right"><strong>Duration:</strong> ${ed.duration || '3 Hours'}</td></tr><tr><td><strong>Max. Marks:</strong> ${totalMarks || ed.totalMarks || '—'}</td><td style="text-align:right"></td></tr></table><div class="thin-div"></div><div class="paper-title">${ed.examType || 'Question Paper'}</div>${instructionsHTML}${sectionsHTML}<div class="thick-div"></div></div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${paperTitle}</title>
<style>${css}</style>
</head>
<body>
${bodyHTML}
</body>
</html>`;
}