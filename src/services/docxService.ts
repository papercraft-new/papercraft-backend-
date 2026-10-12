import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  AlignmentType,
  convertInchesToTwip,
  UnderlineType,
  ShadingType,
  TableLayoutType,
  ImageRun,
  RunProperties,
} from "docx";
import type { PaperData, Section, Question, TemplateConfig } from '../types';
import { logger } from '../utils/logger';
import { normalizeOptions, mcqOptionWidth, withBlank, imageWidthPct, QUESTION_IMAGE_PCT, OPTION_IMAGE_PCT, tableGrid, tableHasHeader, tableColumnPercents, splitMath, MATH_LIMITS, matchColumns, matchLetter } from './paperRenderer';
import { renderMathPicture } from './mathImage';
import type { MathPicture } from './mathImage';
import type { CleanOption } from './paperRenderer';
import { fetchImageForDocx } from '../utils/imageFetch';
import type { FetchedImage } from '../utils/imageFetch';

// ─────────────────────────────────────────
// TEMPLATE CONFIGS
// ─────────────────────────────────────────

const TEMPLATE_CONFIGS: Record<string, Partial<TemplateConfig>> = {
  'tpl_school': {
    fontFamily: 'Times New Roman',
    titleFontSize: 11,   // paper title (institution name is sized separately, larger)
    bodyFontSize: 11,    // meta info, instructions, section headers
    questionFontSize: 10, // question text + options — matches PDF's unified 13px
    primaryColor: '1A2E5A',
    outerBorderStyle: 'double',
    outerBorderWidth: 3,
    innerBorderStyle: 'single',
    showLogo: true,
    showSignatureBlock: true,
    headerLayout: 'centered',
  },
  'tpl_college': {
    fontFamily: 'Arial',
    titleFontSize: 20,
    bodyFontSize: 14,
    questionFontSize: 16,
    primaryColor: '1C3A6E',
    outerBorderStyle: 'single',
    outerBorderWidth: 2,
    innerBorderStyle: 'none',
    showLogo: true,
    showSignatureBlock: true,
    headerLayout: 'two-column',
  },
  minimal: {
    fontFamily: 'Calibri',
    titleFontSize: 20,
    bodyFontSize: 14,
    questionFontSize: 16,
    primaryColor: '000000',
    outerBorderStyle: 'none',
    innerBorderStyle: 'none',
    showLogo: false,
    showSignatureBlock: true,
    headerLayout: 'centered',
  },
  'tpl_coaching': {
    fontFamily: 'Arial',
    titleFontSize: 20,
    bodyFontSize: 14,
    questionFontSize: 16,
    primaryColor: '8B0000',
    outerBorderStyle: 'double',
    outerBorderWidth: 3,
    showLogo: true,
    showSignatureBlock: true,
  },
  'tpl_competitive': {
    fontFamily: 'Times New Roman',
    titleFontSize: 14,
    bodyFontSize: 11,
    questionFontSize: 14,
    primaryColor: '003366',
    outerBorderStyle: 'double',
    showLogo: false,
    showSignatureBlock: false,
  },
  'tpl_luxury': {
    fontFamily: 'Palatino Linotype',
    titleFontSize: 22,
    bodyFontSize: 14,
    questionFontSize: 16,
    primaryColor: '4A0E00',
    outerBorderStyle: 'double',
    showLogo: true,
    showSignatureBlock: true,
    headerLayout: 'centered',
  },
  // ── CLASSIC TEMPLATE ────────────────────
  'tpl_classic': {
    fontFamily: 'Times New Roman',
    titleFontSize: 11,
    bodyFontSize: 11,
    questionFontSize: 10,
    primaryColor: '111111',
    outerBorderStyle: 'none',
    outerBorderWidth: 0,
    innerBorderStyle: 'none',
    showLogo: false,
    showSignatureBlock: false,
    headerLayout: 'classic-minimal',
  },
  // ── WORKSHEET TEMPLATE ──────────────────
  // Slightly smaller to fit more Qs per page, but still legible
  'tpl_worksheet': {
    fontFamily: 'Calibri',
    titleFontSize: 11,
    bodyFontSize: 8,
    questionFontSize: 10,
    primaryColor: '1F2937',
    outerBorderStyle: 'single',
    outerBorderWidth: 2,
    innerBorderStyle: 'none',
    showLogo: false,
    showSignatureBlock: false,
    headerLayout: 'worksheet',
  },
  // ── PROFESSIONAL TEMPLATE ───────────────
  'tpl_professional': {
    fontFamily: 'Arial',
    titleFontSize: 11,
    bodyFontSize: 9,
    questionFontSize: 10,
    primaryColor: '1F2937',
    outerBorderStyle: 'single',
    outerBorderWidth: 2,
    innerBorderStyle: 'none',
    showLogo: true,
    showSignatureBlock: true,
    headerLayout: 'professional',
  },
};

// ─────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// IMAGES (question + option pictures)
// ─────────────────────────────────────────

const TWIPS_PER_MM = 56.69;
const TWIPS_PER_PX = 15;
const TOTAL_IMAGE_BYTES_CAP = 80 * 1024 * 1024; // keeps a picture-heavy paper from exhausting memory

type LoadedImages = Map<string, FetchedImage | null>;
type PictureSpec = { url?: string; size?: 'small' | 'medium' | 'large' | 'full'; alt?: string };

/** Downloads every picture used by the paper once (5 at a time). Papers without pictures do nothing here. */
async function loadDocxImages(sections: Section[]): Promise<LoadedImages> {
  const urls = new Set<string>();
  for (const s of sections) {
    for (const q of s.questions || []) {
      for (const im of Array.isArray(q.images) ? q.images : []) if (im?.url) urls.add(im.url);
      for (const o of Array.isArray(q.options) ? q.options : []) if (o?.image?.url) urls.add(o.image.url);
    }
  }
  const loaded: LoadedImages = new Map();
  const list = [...urls];
  let next = 0;
  let bytes = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, list.length) }, async () => {
      while (next < list.length) {
        const url = list[next++];
        const img = bytes < TOTAL_IMAGE_BYTES_CAP ? await fetchImageForDocx(url) : null;
        if (img) bytes += img.data.length;
        loaded.set(url, img);
      }
    })
  );
  return loaded;
}

/** A picture sized with the same rule as the PDF: chosen size, capped in height, never stretched. */
function pictureRun(img: FetchedImage, spec: PictureSpec, kind: 'question' | 'option', containerTwip: number): ImageRun {
  const sizes = kind === 'question' ? QUESTION_IMAGE_PCT : OPTION_IMAGE_PCT;
  const basePct = sizes[spec.size || 'medium'] ?? sizes.medium;
  const pct = imageWidthPct(
    { id: '', url: '', width: img.width, height: img.height },
    basePct,
    containerTwip / TWIPS_PER_MM,
    kind === 'question' ? 110 : 45
  );
  const widthPx = Math.max(16, Math.round((containerTwip * pct) / 100 / TWIPS_PER_PX));
  const heightPx = Math.max(1, Math.round((widthPx * img.height) / img.width));
  return new ImageRun({
    data: img.data,
    transformation: { width: widthPx, height: heightPx },
    altText: { name: 'Question image', description: spec.alt || '', title: '' },
  });
}

/** Shown in place of a picture that could not be loaded, so a missing figure is never silent. */
function missingPicture(font: string, size: number): TextRun {
  return new TextRun({ text: '[Image could not be loaded]', italics: true, color: '888888', size, font });
}

/**
 * An equation picture that sits on the text baseline: Word has no baseline setting for a
 * picture, so the run is lowered by the equation's depth (fractions, sums and so on hang below).
 */
class MathRun extends ImageRun {
  constructor(pic: MathPicture, latex: string) {
    super({
      data: pic.png,
      transformation: { width: Math.max(1, Math.round(pic.width)), height: Math.max(1, Math.round(pic.height)) },
      altText: { name: 'Equation', description: latex, title: '' },
    });
    const lowerHalfPoints = Math.round(pic.depth * 0.75 * 2); // w:position is in half-points
    if (lowerHalfPoints >= 1) {
      const lowered = new RunProperties({ position: `-${lowerHalfPoints}` as any });
      ((lowered as any).root as unknown[]).forEach(child => (this as any).properties.push(child));
    }
  }
}

export async function generateDocx(paper: PaperData, templateKey = 'school'): Promise<Buffer> {
  const config = { ...TEMPLATE_CONFIGS.school, ...TEMPLATE_CONFIGS[templateKey] };
  const { examDetails, sections } = paper;
  const totalMarks = sections.reduce((sum, s) => sum + s.totalMarks, 0);

  logger.info(`Generating DOCX for: ${paper.title}, template: ${templateKey}`);

  const children: (Paragraph | Table)[] = [];
  const images = await loadDocxImages(sections);

  const isClassic = templateKey === 'tpl_classic';
  const isWorksheet = templateKey === 'tpl_worksheet';
  const isProfessional = templateKey === 'tpl_professional';
  const primaryHex = config.primaryColor || '1A2E5A';
  const font = config.fontFamily || 'Times New Roman';
  const titleSize = (config.titleFontSize || 16) * 2;
  const bodySize = (config.bodyFontSize || 12) * 2;
  const qSize = (config.questionFontSize || 11) * 2;

  // ── Equations: $...$ in any text becomes a picture, drawn on first use ──
  const emPx = (qSize / 2) * (96 / 72);
  const mathPics = new Map<string, MathPicture | null>();
  let mathDrawn = 0;
  const mathPicture = (latex: string, display: boolean): MathPicture | null => {
    const key = `${display ? 'd' : 'i'}|${latex}`;
    if (mathPics.has(key)) return mathPics.get(key) ?? null;
    let pic: MathPicture | null = null;
    if (mathDrawn < MATH_LIMITS.perPaper) {
      mathDrawn++;
      try {
        pic = renderMathPicture(latex, display, emPx);
      } catch (err) {
        logger.warn(`DOCX equation skipped (shown as text): ${latex.slice(0, 60)}`);
      }
    }
    mathPics.set(key, pic);
    return pic;
  };
  /** Text as runs: plain text stays one TextRun (as before); equations become inline pictures. */
  const textRuns = (text: string, extra: { bold?: boolean; color?: string } = {}): (TextRun | ImageRun)[] => {
    if (!text || text.indexOf('$') === -1) return [new TextRun({ text, size: qSize, font, ...extra })];
    return splitMath(text).map(p => {
      if (p.kind === 'text') return new TextRun({ text: p.text, size: qSize, font, ...extra });
      const pic = mathPicture(p.latex, p.display);
      return pic
        ? new MathRun(pic, p.latex)
        : new TextRun({ text: p.display ? `$$${p.latex}$$` : `$${p.latex}$`, size: qSize, font, ...extra });
    });
  };

  const dateStr = examDetails.date
    ? new Date(examDetails.date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      })
    : '—';

  if (isClassic) {
    // ── CLASSIC HEADER: institution name → divider → meta row → divider ──
    const classicPageWidth = convertInchesToTwip(8.27 - 1.25 - 1.25);

    // Institution name (centered, bold, uppercase) — sized independently of paper-title
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 60 },
        children: [
          new TextRun({
            text: (examDetails.institutionName || 'INSTITUTION NAME').toUpperCase(),
            bold: true,
            size: titleSize + 12,
            font,
            color: '111111',
          }),
        ],
      })
    );
    children.push(makeDivider(BorderStyle.SINGLE, '888888', 2));

    // Meta row: Name / Class / Date / Marks in one line via tab stops.
    // Carries its own bottom border (matches PDF's .classic-meta-row) —
    // no separate divider needed right after it.
    // Tab stops start at an even 4-column split and are pushed right only as far as
    // the real text needs, so "Max. Marks" always has room and never wraps.
    const classicTabs = layoutMetaTabStops(
      ['Name: ___________________', `Class: ${examDetails.class || '—'}`, `Date: ${dateStr}`, maxMarksText(totalMarks || examDetails.totalMarks || '—')],
      classicPageWidth,
      bodySize - 2,
    );
    children.push(
      new Paragraph({
        spacing: { before: 60, after: 100 },
        tabStops: [
          ...classicTabs.map(position => ({ type: 'left' as const, position })),
          { type: 'right', position: classicPageWidth },
        ],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, color: '888888' },
        },
        children: [
          new TextRun({ text: 'Name: ___________________', size: bodySize - 2, font }),
          new TextRun({ text: `	Class: ${examDetails.class || '—'}`, size: bodySize - 2, font }),
          new TextRun({ text: `	Date: ${dateStr}`, size: bodySize - 2, font }),
          new TextRun({ text: `\t${maxMarksText(totalMarks || examDetails.totalMarks || '—')}`, size: bodySize - 2, font, bold: true }),
        ],
      })
    );
  } else if (isWorksheet) {
    // ── WORKSHEET HEADER ─────────────────────────────────────────────────────
    // Paper title centred, then Name | Date row with borders top+bottom
    const wsPageWidth = convertInchesToTwip(8.27 - 1.25 - 1.25);

    // Worksheet title — centred, bold, uppercase
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [
          new TextRun({
            text: (paper.title || examDetails.examType || 'WORKSHEET').toUpperCase(),
            bold: true,
            size: titleSize + 2,
            font,
            color: primaryHex,
          }),
        ],
      })
    );

    // Name | Date row — bordered top and bottom
    children.push(
      new Paragraph({
        spacing: { before: 40, after: 40 },
        tabStops: [{ type: 'right', position: wsPageWidth }],
        border: {
          top: { style: BorderStyle.SINGLE, size: 4, color: primaryHex },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: primaryHex },
        },
        children: [
          new TextRun({ text: 'Name: _____________________________', size: bodySize, font }),
          new TextRun({ text: `\tDate: ${dateStr}`, size: bodySize - 2, font }),
        ],
      })
    );
  } else if (isProfessional) {
    // ── PROFESSIONAL HEADER ──────────────────────────────────────────────────
    // Left: logo circle placeholder  |  Right: institution info box
    const proPageWidth = convertInchesToTwip(8.27 - 1.25 - 1.25);
    const logoColWidth = convertInchesToTwip(1.4);
    const infoColWidth = proPageWidth - logoColWidth - convertInchesToTwip(0.2);

    const institutionLines = [
      (examDetails.institutionName || 'INSTITUTION NAME').toUpperCase(),
      examDetails.institutionAddress || '',
      examDetails.department ? `Dept. of ${examDetails.department}` : '',
      examDetails.facultyName ? `Faculty: ${examDetails.facultyName}` : '',
    ].filter(Boolean);

    const logoCell = new TableCell({
      width: { size: logoColWidth, type: WidthType.DXA },
      borders: {
        top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 60, after: 10 },
          children: [new TextRun({ text: '◯', size: 96, font: 'Arial', color: 'BBBBBB' })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 0 },
          children: [new TextRun({ text: 'LOGO', size: 16, font, color: 'AAAAAA' })],
        }),
      ],
    });

    // Info box: institution name in shaded top row, then detail lines below
    const detailLines = [
      examDetails.institutionAddress,
      examDetails.department ? `Dept. of ${examDetails.department}` : '',
      examDetails.facultyName ? `Faculty: ${examDetails.facultyName}` : '',
    ].filter(Boolean) as string[];

    const infoCellChildren: Paragraph[] = [
      // Institution name — shaded band at top
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { before: 60, after: 60 },
        indent: { left: convertInchesToTwip(0.12) },
        shading: { type: ShadingType.SOLID, color: primaryHex },
        children: [
          new TextRun({
            text: (examDetails.institutionName || 'INSTITUTION NAME').toUpperCase(),
            bold: true,
            size: bodySize + 6,
            font,
            color: 'FFFFFF',
          }),
        ],
      }),
      // Detail lines
      ...detailLines.map(line =>
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 30, after: 30 },
          indent: { left: convertInchesToTwip(0.12) },
          children: [
            new TextRun({ text: line, size: bodySize - 4, font, color: '333333' }),
          ],
        })
      ),
    ];

    const infoCell = new TableCell({
      width: { size: infoColWidth, type: WidthType.DXA },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
        bottom: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
        left: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
        right: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
      },
      children: infoCellChildren,
    });

    children.push(
      new Table({
        width: { size: proPageWidth, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        borders: {
          top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
          left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
          insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
        },
        rows: [new TableRow({ children: [logoCell, infoCell] })],
      })
    );

    // Meta row below header: Subject | Class | Date | Duration | Marks — single shaded line
    const metaPageWidth = convertInchesToTwip(8.27 - 1.25 - 1.25);
    const proTabs = layoutMetaTabStops(
      [
        `Subject: ${examDetails.subject || '—'}`,
        `Class: ${examDetails.class || '—'}`,
        `Date: ${dateStr}`,
        `Duration: ${examDetails.duration || '3 Hrs'}`,
        maxMarksText(totalMarks || examDetails.totalMarks || '—'),
      ],
      metaPageWidth,
      bodySize - 2,
    );
    children.push(
      new Paragraph({
        spacing: { before: 80, after: 60 },
        shading: { type: ShadingType.SOLID, color: 'F3F4F6' },
        tabStops: [
          ...proTabs.map(position => ({ type: 'left' as const, position })),
          { type: 'right', position: metaPageWidth },
        ],
        children: [
          new TextRun({ text: `Subject: ${examDetails.subject || '—'}`, size: bodySize - 2, font }),
          new TextRun({ text: `\tClass: ${examDetails.class || '—'}`, size: bodySize - 2, font }),
          new TextRun({ text: `\tDate: ${dateStr}`, size: bodySize - 2, font }),
          new TextRun({ text: `\tDuration: ${examDetails.duration || '3 Hrs'}`, size: bodySize - 2, font }),
          new TextRun({ text: `\t${maxMarksText(totalMarks || examDetails.totalMarks || '—')}`, size: bodySize - 2, font, bold: true }),
        ],
      })
    );
  } else {
    // ── DEFAULT HEADER ────────────────────────
    // Institution Name
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [
          new TextRun({
            text: (examDetails.institutionName || 'INSTITUTION NAME').toUpperCase(),
            bold: true,
            size: titleSize + 4,
            font,
            color: primaryHex,
          }),
        ],
      })
    );

    // Institution Address
    if (examDetails.institutionAddress) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 40 },
          children: [
            new TextRun({
              text: examDetails.institutionAddress,
              size: bodySize - 4,
              font,
              color: '666666',
            }),
          ],
        })
      );
    }

    // Department
    if (examDetails.department) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 60 },
          children: [
            new TextRun({
              text: `Department of ${examDetails.department}`,
              size: bodySize - 4,
              font,
              color: '444444',
            }),
          ],
        })
      );
    }

    // Thick border line
    children.push(
      new Paragraph({
        spacing: { before: 40, after: 80 },
        border: {
          bottom: { style: BorderStyle.DOUBLE, size: 6, color: primaryHex },
        },
        children: [new TextRun({ text: '' })],
      })
    );

    // Meta info table
    const metaRows = [
      [
        `Subject: ${examDetails.subject || '—'}${examDetails.subjectCode ? ` (${examDetails.subjectCode})` : ''}`,
        `Date: ${dateStr}`,
      ],
      [
        `Class: ${examDetails.class || '—'}${examDetails.branch ? ` | ${examDetails.branch}` : ''}`,
        `Duration: ${examDetails.duration || '3 Hours'}`,
      ],
      [
        `Exam Type: ${examDetails.examType || '—'}`,
        maxMarksText(totalMarks || examDetails.totalMarks || '—'),
      ],
    ];

    if (examDetails.academicYear) {
      metaRows.push([`Academic Year: ${examDetails.academicYear}`, examDetails.facultyName ? `Faculty: ${examDetails.facultyName}` : '']);
    }

    // Meta rows as plain paragraphs — left label, right value via tab stop
    const metaPageWidth = convertInchesToTwip(8.27 - 1.25 - 1.25);
    metaRows.forEach(row => {
      children.push(
        new Paragraph({
          spacing: { before: 20, after: 20 },
          tabStops: [{ type: 'right', position: metaPageWidth }],
          children: [
            new TextRun({ text: row[0], size: bodySize - 2, font }),
            new TextRun({ text: `	${row[1]}`, size: bodySize - 2, font, bold: true }),
          ],
        })
      );
    });
  }

  // ── PAPER TITLE (worksheet's own title already serves this role — skip) ──
  if (!isWorksheet) {
    // Pre-title divider: classic already has a border under its meta row,
    // so an extra line here would double up (matches the PDF fix).
    if (!isClassic) {
      children.push(makeDivider(BorderStyle.SINGLE, primaryHex, 2));
    }

    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 80 },
        children: [
          new TextRun({
            text: (examDetails.examType || 'QUESTION PAPER').toUpperCase(),
            bold: true,
            size: titleSize,
            font,
            color: primaryHex,
            ...(!isClassic ? { underline: { type: UnderlineType.SINGLE } } : {}),
          }),
        ],
      })
    );

    // Post-title divider: default's title is already underlined, so an
    // extra line right below it would double up (matches the PDF fix).
    // Classic and professional keep it.
    if (isClassic || isProfessional) {
      children.push(makeDivider(BorderStyle.SINGLE, primaryHex, 2));
    }
  }

  // ── INSTRUCTIONS (not shown for worksheet or professional) ──────────────
  if (examDetails.instructions && examDetails.instructions.length > 0 && !isWorksheet && !isProfessional) {
    children.push(
      new Paragraph({
        spacing: { before: 80, after: 40 },
        children: [
          new TextRun({
            text: 'General Instructions:',
            bold: true,
            size: bodySize,
            font,
            underline: { type: UnderlineType.SINGLE },
          }),
        ],
      })
    );

    examDetails.instructions.forEach((inst, idx) => {
      children.push(
        new Paragraph({
          spacing: { after: 30 },
          indent: { left: convertInchesToTwip(0.3) },
          children: [
            new TextRun({
              text: `${idx + 1}. ${inst}`,
              size: bodySize - 2,
              font,
            }),
          ],
        })
      );
    });

    children.push(makeDivider(BorderStyle.SINGLE, 'AAAAAA', 1));
  }

  // ── SECTIONS & QUESTIONS ──────────────────
  sections.forEach((section) => {
    // Section Header — shaded box (compact for worksheet)
    const marksInfo = section.marksPerQuestion
      ? ` (${section.marksPerQuestion} Mark${section.marksPerQuestion > 1 ? 's' : ''} Each)`
      : section.totalMarks
      ? ` [Total: ${section.totalMarks} Marks]`
      : '';

    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: isWorksheet ? 60 : 140, after: isWorksheet ? 30 : 80 },
        shading: {
          type: ShadingType.SOLID,
          color: isWorksheet ? 'F3F4F6' : 'EEF2FF',
        },
        border: {
          top: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
          bottom: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
          left: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
          right: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
        },
        children: [
          new TextRun({
            text: section.title.toUpperCase(),
            bold: true,
            size: bodySize,
            font,
            color: primaryHex,
          }),
          new TextRun({
            // PDF shows the whole heading in capitals via CSS text-transform: match it.
            text: marksInfo.toUpperCase(),
            size: bodySize - 2,
            font,
            color: '444444',
          }),
        ],
      })
    );

    if (section.description) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: section.description,
              size: bodySize - 2,
              font,
              italics: true,
              color: '555555',
            }),
          ],
        })
      );
    }

    // Questions
    section.questions.forEach((question) => {
      const { cleanedText, fixedOptions } = getCleanedQuestion(question);

      // ── QUESTION ROW: plain paragraph with hanging indent ──
      // Number + text on left, marks right-aligned via tab stop
      const pageWidthTwip = convertInchesToTwip(8.27 - 1.25 - 1.25); // A4 minus margins
      const questionPictures = (Array.isArray(question.images) ? question.images : []).filter(im => im?.url);
      const questionTables = Array.isArray(question.tables) ? question.tables : [];
      const matchCols = question.type === 'MATCH_FOLLOWING' ? matchColumns(question.match) : null;
      const questionLead = {
        spacing: { before: isWorksheet ? 30 : 90, after: isWorksheet ? 15 : 40 },
        indent: { left: convertInchesToTwip(0.35), hanging: convertInchesToTwip(0.35) },
        tabStops: [{ type: 'right' as const, position: pageWidthTwip }],
        ...(questionPictures.length > 0 || questionTables.length > 0 || matchCols || fixedOptions.some(o => o.image?.url) ? { keepNext: true } : {}), // keep the text with its tables and pictures
      };
      const numberRun = new TextRun({ text: `${question.number}.  `, bold: true, size: qSize, font });
      const questionParts = cleanedText.indexOf('$') === -1 ? [] : splitMath(cleanedText);
      if (!questionParts.some(p => p.kind === 'math' && p.display)) {
        children.push(new Paragraph({ ...questionLead, children: [numberRun, ...textRuns(cleanedText)] }));
      } else {
        // A display equation ($$...$$) gets its own centred line, like the PDF; the text goes on around it.
        let runs: (TextRun | ImageRun)[] = [numberRun];
        let leadDone = false;
        const flushText = () => {
          children.push(
            new Paragraph(
              leadDone
                ? { spacing: { before: 0, after: 40 }, indent: { left: convertInchesToTwip(0.35) }, children: runs }
                : { ...questionLead, children: runs }
            )
          );
          leadDone = true;
          runs = [];
        };
        questionParts.forEach(p => {
          if (p.kind === 'math' && p.display) {
            if (runs.length > 0) flushText();
            const pic = mathPicture(p.latex, true);
            children.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 40, after: 40 },
                indent: { left: convertInchesToTwip(0.35) },
                keepLines: true,
                children: [pic ? new MathRun(pic, p.latex) : new TextRun({ text: `$$${p.latex}$$`, size: qSize, font })],
              })
            );
          } else if (p.kind === 'text') {
            runs.push(new TextRun({ text: p.text, size: qSize, font }));
          } else {
            const pic = mathPicture(p.latex, false);
            runs.push(pic ? new MathRun(pic, p.latex) : new TextRun({ text: `$${p.latex}$`, size: qSize, font }));
          }
        });
        if (runs.length > 0) flushText();
      }

      // ── QUESTION TABLES: native Word tables under the question text ──
      // Same column widths as the PDF (tableColumnPercents); header row repeats on a new page.
      questionTables.forEach(t => {
        const grid = tableGrid(t);
        if (!grid.length || !grid[0].length) return;
        const indentTwip = convertInchesToTwip(0.35);
        const tableTwip = pageWidthTwip - indentTwip;
        const widths = tableColumnPercents(grid).map(p => Math.floor((p / 100) * tableTwip));
        widths[widths.length - 1] += tableTwip - widths.reduce((a, b) => a + b, 0);
        const hasHead = tableHasHeader(t);
        const line = { style: BorderStyle.SINGLE, size: 4, color: '333333' };
        children.push(
          new Table({
            width: { size: tableTwip, type: WidthType.DXA },
            columnWidths: widths,
            layout: TableLayoutType.FIXED,
            indent: { size: indentTwip, type: WidthType.DXA },
            rows: grid.map((cells, r) => {
              const head = hasHead && r === 0;
              return new TableRow({
                cantSplit: true,
                ...(head ? { tableHeader: true } : {}),
                children: cells.map((text, c) =>
                  new TableCell({
                    width: { size: widths[c], type: WidthType.DXA },
                    borders: { top: line, bottom: line, left: line, right: line },
                    margins: { top: 40, bottom: 40, left: 80, right: 80 },
                    ...(head ? { shading: { type: ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' } } : {}),
                    children: text.split('\n').map(
                      l =>
                        new Paragraph({
                          spacing: { before: 0, after: 0 },
                          children: textRuns(l, { bold: head }),
                        })
                    ),
                  })
                ),
              });
            }),
          })
        );
        children.push(new Paragraph({ spacing: { before: 0, after: 40 }, children: [new TextRun({ text: '', size: 8, font })] }));
      });

      // ── QUESTION PICTURES: under the question text, side by side, wrapping ──
      if (questionPictures.length > 0) {
        const blockTwip = pageWidthTwip - convertInchesToTwip(0.35);
        const runs: Array<ImageRun | TextRun> = [];
        questionPictures.forEach((im, k) => {
          if (k > 0) runs.push(new TextRun({ text: '   ', size: qSize, font }));
          const loaded = images.get(im.url);
          runs.push(loaded ? pictureRun(loaded, im, 'question', blockTwip) : missingPicture(font, qSize));
        });
        children.push(
          new Paragraph({
            spacing: { before: 40, after: 40 },
            indent: { left: convertInchesToTwip(0.35) },
            keepLines: true,
            children: runs,
          })
        );
      }

      // ── MATCH THE FOLLOWING: borderless columns, same widths as the PDF ──
      if (matchCols) {
        const indentTwip = convertInchesToTwip(0.35);
        const tableTwip = pageWidthTwip - indentTwip;
        const fractions = matchCols.answerBox ? [0.34, 0.16, 0.5] : [0.5, 0.5];
        const widths = fractions.map(f => Math.floor(f * tableTwip));
        widths[widths.length - 1] += tableTwip - widths.reduce((a, b) => a + b, 0);
        const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
        const cell = (w: number, paras: Paragraph[], bottom?: { style: typeof BorderStyle.SINGLE; size: number; color: string }) =>
          new TableCell({
            width: { size: w, type: WidthType.DXA },
            borders: { top: none, left: none, right: none, bottom: bottom ?? none },
            margins: { top: 20, bottom: 20, left: 0, right: 120 },
            children: paras,
          });
        const oneLine = (t: string) => t.replace(/\s*\n\s*/g, ' ');
        const itemPara = (label: string, text: string | undefined) =>
          new Paragraph({
            spacing: { before: 0, after: 0 },
            indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.3) },
            children:
              text && text.trim()
                ? [new TextRun({ text: `${label}\t`, bold: true, size: qSize, font }), ...textRuns(oneLine(text))]
                : [new TextRun({ text: '', size: qSize, font })],
          });
        const plain = (t: string, bold = false, center = false) =>
          new Paragraph({
            spacing: { before: 0, after: 0 },
            alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
            children: [new TextRun({ text: t, bold, size: qSize, font })],
          });
        const underline = { style: BorderStyle.SINGLE, size: 4, color: '333333' };
        const rows: TableRow[] = [];
        if (matchCols.leftTitle || matchCols.rightTitle) {
          rows.push(
            new TableRow({
              cantSplit: true,
              children: [
                cell(widths[0], [plain(matchCols.leftTitle, true)], underline),
                ...(matchCols.answerBox ? [cell(widths[1], [plain('')], underline)] : []),
                cell(widths[widths.length - 1], [plain(matchCols.rightTitle, true)], underline),
              ],
            })
          );
        }
        for (let r = 0; r < matchCols.rows; r++) {
          const hasLeft = !!(matchCols.left[r] && matchCols.left[r].trim());
          rows.push(
            new TableRow({
              cantSplit: true,
              children: [
                cell(widths[0], [itemPara(`${r + 1}.`, matchCols.left[r])]),
                ...(matchCols.answerBox ? [cell(widths[1], [plain(hasLeft ? '(\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0)' : '', false, true)])] : []),
                cell(widths[widths.length - 1], [itemPara(`(${matchLetter(r)})`, matchCols.right[r])]),
              ],
            })
          );
        }
        children.push(
          new Table({
            width: { size: tableTwip, type: WidthType.DXA },
            columnWidths: widths,
            layout: TableLayoutType.FIXED,
            indent: { size: indentTwip, type: WidthType.DXA },
            borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
            rows,
          })
        );
        children.push(new Paragraph({ spacing: { before: 0, after: 40 }, children: [new TextRun({ text: '', size: 8, font })] }));
      }

      // ── MCQ OPTIONS ──
      // Only the real options are shown (no "(?) ___" padding). Layout follows the same
      // rule as the PDF (mcqOptionWidth): short options 4 per row, medium 2, long 1.
      if (question.type === 'MCQ' && fixedOptions.length > 0) {
        const perRow = ({ '25%': 4, '50%': 2, '100%': 1 } as const)[mcqOptionWidth(fixedOptions)];
        const optIndent = convertInchesToTwip(0.5);
        const labelHang = convertInchesToTwip(0.3);
        const afterBlock = isWorksheet ? 20 : 80;
        const optionRuns = (opt: { label: string; text: string }) => [
          new TextRun({ text: `(${opt.label})`, bold: true, size: qSize, font, color: '222222' }),
          new TextRun({ text: '\t', size: qSize, font }),
          ...textRuns(opt.text),
        ];
        // One option as paragraph(s): label + text, and its picture beside the label (no text)
        // or on its own line under the text. `textIndent` is where the option text starts.
        const optionParagraphs = (
          opt: (typeof fixedOptions)[number],
          textIndent: number,
          contentTwip: number,
          afterSpacing: number
        ): Paragraph[] => {
          const hasPicture = !!opt.image?.url;
          const loaded = hasPicture ? images.get(opt.image!.url) : undefined;
          const picture: ImageRun | TextRun | null = hasPicture
            ? loaded ? pictureRun(loaded, opt.image!, 'option', contentTwip) : missingPicture(font, qSize)
            : null;
          const below = picture !== null && !!opt.text;
          const paragraphs = [
            new Paragraph({
              spacing: { before: 40, after: below ? 0 : afterSpacing },
              indent: { left: textIndent, hanging: labelHang },
              tabStops: [{ type: 'left', position: textIndent }],
              children: [...optionRuns(opt), ...(picture !== null && !below ? [picture] : [])],
            }),
          ];
          if (below && picture !== null) {
            paragraphs.push(
              new Paragraph({
                spacing: { before: 20, after: afterSpacing },
                indent: { left: textIndent },
                keepLines: true,
                children: [picture],
              })
            );
          }
          return paragraphs;
        };

        if (perRow === 1) {
          // One option per line; wrapped lines hang under the option text.
          fixedOptions.forEach((opt, i) => {
            children.push(
              ...optionParagraphs(
                opt,
                optIndent + labelHang,
                pageWidthTwip - optIndent - labelHang,
                i === fixedOptions.length - 1 ? afterBlock : 0
              )
            );
          });
        } else {
          // 2 or 4 per row: a borderless fixed-width grid, so a long option wraps inside its
          // own column instead of pushing the next option out of line.
          const colWidth = Math.floor((pageWidthTwip - optIndent) / perRow);
          const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
          const cellBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
          const rows: TableRow[] = [];
          for (let i = 0; i < fixedOptions.length; i += perRow) {
            const isLastRow = i + perRow >= fixedOptions.length;
            const cells: TableCell[] = [];
            for (let c = 0; c < perRow; c++) {
              const opt = fixedOptions[i + c];
              cells.push(
                new TableCell({
                  width: { size: colWidth, type: WidthType.DXA },
                  borders: cellBorders,
                  margins: { top: 0, bottom: 0, left: 0, right: 0 },
                  children: opt
                    ? optionParagraphs(opt, labelHang, colWidth - labelHang, isLastRow ? afterBlock : 0)
                    : [
                        new Paragraph({
                          spacing: { before: 40, after: isLastRow ? afterBlock : 0 },
                          indent: { left: labelHang, hanging: labelHang },
                          tabStops: [{ type: 'left', position: labelHang }],
                          children: [],
                        }),
                      ],
                })
              );
            }
            rows.push(new TableRow({ cantSplit: true, children: cells }));
          }
          children.push(
            new Table({
              width: { size: colWidth * perRow, type: WidthType.DXA },
              columnWidths: Array(perRow).fill(colWidth),
              indent: { size: optIndent, type: WidthType.DXA },
              layout: TableLayoutType.FIXED,
              borders: {
                top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
                insideHorizontal: noBorder, insideVertical: noBorder,
              },
              rows,
            })
          );
        }
      }
      // True/False options
      if (question.type === 'TRUE_FALSE') {
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            indent: { left: convertInchesToTwip(0.35) },
            children: [
              new TextRun({ text: '(a)  True          ', bold: true, size: qSize, font }),
              new TextRun({ text: '(b)  False', bold: true, size: qSize, font }),
            ],
          })
        );
      }

      // Answer lines — matches the PDF templates: Short/Long answer questions
      // get no blank lines (the next question follows directly), Diagram
      // gets 8, Fill-in-blank gets 1 (none if its blank is already in the text), everything else gets 2.
      if (question.type !== 'MCQ' && question.type !== 'TRUE_FALSE') {
        const lineCount =
          question.type === 'LONG_ANSWER' || question.type === 'SHORT_ANSWER' || matchCols
            ? 0
            : question.type === 'DIAGRAM'
            ? 8
            : question.type === 'FILL_IN_BLANK'
            ? (withBlank('FILL_IN_BLANK', cleanedText) === cleanedText ? 0 : 1) // blank already inline -> no extra line
            : examDetails.answerLines === 'none'
            ? 0
            : 2;

        for (let i = 0; i < lineCount; i++) {
          children.push(
            new Paragraph({
              spacing: { before: isWorksheet ? 20 : 40, after: isWorksheet ? 20 : 40 },
              indent: { left: convertInchesToTwip(0.3) },
              border: {
                bottom: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
              },
              children: [new TextRun({ text: ' ', size: qSize, font })],
            })
          );
        }
      }

      // Space after question
      children.push(new Paragraph({ spacing: { after: isWorksheet ? 20 : 60 }, children: [new TextRun({ text: '' })] }));
    });
  });

  // ── SIGNATURE BLOCK (default + professional only) — no tables, pure paragraphs ──
  if (!isClassic && !isWorksheet) {
    children.push(makeDivider(BorderStyle.DOUBLE, primaryHex, 4));

    // Spacing paragraph
    children.push(new Paragraph({ spacing: { before: 400, after: 0 }, children: [new TextRun({ text: '' })] }));

    const pageWidthTwip = convertInchesToTwip(8.27 - 1.25 - 1.25);
    const third = Math.floor(pageWidthTwip / 3);
    const twoThird = third * 2;

    // Signature lines paragraph — three underlines via tab stops
    children.push(
      new Paragraph({
        spacing: { before: 0, after: 60 },
        tabStops: [
          { type: 'center', position: third },
          { type: 'center', position: twoThird },
          { type: 'right', position: pageWidthTwip },
        ],
        border: { bottom: { style: BorderStyle.NONE } },
        children: [
          new TextRun({ text: '_____________________', size: bodySize, font, color: 'AAAAAA' }),
          new TextRun({ text: '	_____________________', size: bodySize, font, color: 'AAAAAA' }),
          new TextRun({ text: '	_____________________', size: bodySize, font, color: 'AAAAAA' }),
        ],
      })
    );

    // Labels paragraph
    children.push(
      new Paragraph({
        spacing: { before: 40, after: 0 },
        tabStops: [
          { type: 'center', position: third },
          { type: 'center', position: twoThird },
          { type: 'right', position: pageWidthTwip },
        ],
        children: [
          new TextRun({ text: 'Subject Teacher', size: bodySize - 4, font, color: '555555' }),
          new TextRun({ text: '	HOD / Principal', size: bodySize - 4, font, color: '555555' }),
          new TextRun({ text: '	Exam Controller', size: bodySize - 4, font, color: '555555' }),
        ],
      })
    );
  }

  // ── BUILD DOCUMENT ────────────────────────
  // Page margins match each template's actual PDF padding (18mm default/
  // classic/professional, 14mm worksheet). No decorative page-border frame
  // is drawn — the PDF templates don't have one either. No repeating
  // header/footer bars either, to match the PDF's plain page.
  const pageMarginIn = isWorksheet ? 0.551 : 0.709;
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(pageMarginIn),
              bottom: convertInchesToTwip(pageMarginIn),
              left: convertInchesToTwip(pageMarginIn),
              right: convertInchesToTwip(pageMarginIn),
            },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  logger.info(`DOCX generated: ${buffer.length} bytes`);
  return buffer;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/** "Max. Marks: 60" with non-breaking spaces, so the label and number can never be split across lines. */
function maxMarksText(value: string | number): string {
  return `Max.\u00A0Marks:\u00A0${value}`;
}

/**
 * Conservative width estimate (twips) of a line of text, used only to place tab stops.
 * Deliberately a little wide (about Arial metrics, which are wider than Times New Roman),
 * so a column is never placed too close to the text before it.
 */
function estimateTextWidthTwips(text: string, sizeHalfPoints: number, bold = false): number {
  const pt = sizeHalfPoints / 2;
  let em = 0;
  for (const ch of text) {
    if (ch === ' ') em += 0.28;
    else if (/[0-9_]/.test(ch)) em += 0.56;
    else if (/[A-Z]/.test(ch)) em += 0.72;
    else if (/[a-z]/.test(ch)) em += 0.5;
    else em += 0.45;
  }
  return Math.ceil(em * pt * 20 * (bold ? 1.08 : 1));
}

/**
 * Tab stops for a one-line "meta row" of N items where the last item (Max. Marks) is
 * right-aligned at the page edge. Returns the LEFT tab positions for items 2..N-1.
 * Each starts at an even N-way split of the page (so rows with short text look exactly
 * as before) and is pushed right only if the text before it is too wide to fit, which
 * keeps every later item, including the right-aligned one, on the same line.
 */
function layoutMetaTabStops(items: string[], pageWidth: number, sizeHalfPoints: number, minGap = 140): number[] {
  const n = items.length;
  const widths = items.map((s, i) => estimateTextWidthTwips(s, sizeHalfPoints, i === n - 1));
  const positions: number[] = [];
  let prevStart = 0;
  for (let k = 1; k <= n - 2; k++) {
    const ideal = Math.floor((pageWidth * k) / n);
    const pos = Math.max(ideal, prevStart + widths[k - 1] + minGap);
    positions.push(pos);
    prevStart = pos;
  }
  return positions;
}

function makeDivider(
  style: (typeof BorderStyle)[keyof typeof BorderStyle],
  color: string,
  size: number
): Paragraph {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    border: {
      bottom: { style, size, color },
    },
    children: [new TextRun({ text: '' })],
  });
}
function noBorders() {
  return {
    top: { style: BorderStyle.NONE },
    bottom: { style: BorderStyle.NONE },
    left: { style: BorderStyle.NONE },
    right: { style: BorderStyle.NONE },
    insideH: { style: BorderStyle.NONE },
    insideV: { style: BorderStyle.NONE },
  };
}

// Option / question-text clean-up now comes from the shared renderer, so Word and
// PDF always agree on which options a question has. The Word layout below is unchanged.
function getCleanedQuestion(question: Question): {
  cleanedText: string;
  fixedOptions: CleanOption[];
} {
  const { cleanedQuestionText, fixedOptions } = normalizeOptions(question.options, question.text || '');
  // Marks markers such as "[2]" or "(2 marks)" never print in the question text
  const cleanedText = cleanedQuestionText.replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '').trim();
  return { cleanedText, fixedOptions };
}