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
  Header,
  Footer,
  PageNumber,
  UnderlineType,
  ShadingType,
  TableLayoutType,
  PageBorderDisplay,
  PageBorderOffsetFrom,
} from "docx";
import type { PaperData, Section, Question, TemplateConfig } from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────
// TEMPLATE CONFIGS
// ─────────────────────────────────────────

const TEMPLATE_CONFIGS: Record<string, Partial<TemplateConfig>> = {
  'tpl_school': {
    fontFamily: 'Times New Roman',
    titleFontSize: 16,
    bodyFontSize: 12,
    questionFontSize: 11,
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
    titleFontSize: 14,
    bodyFontSize: 11,
    questionFontSize: 11,
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
    titleFontSize: 14,
    bodyFontSize: 11,
    questionFontSize: 11,
    primaryColor: '000000',
    outerBorderStyle: 'none',
    innerBorderStyle: 'none',
    showLogo: false,
    showSignatureBlock: true,
    headerLayout: 'centered',
  },
  'tpl_coaching': {
    fontFamily: 'Arial',
    titleFontSize: 15,
    bodyFontSize: 12,
    questionFontSize: 11,
    primaryColor: '8B0000',
    outerBorderStyle: 'double',
    outerBorderWidth: 3,
    showLogo: true,
    showSignatureBlock: true,
  },
  'tpl_competitive': {
    fontFamily: 'Times New Roman',
    titleFontSize: 13,
    bodyFontSize: 11,
    questionFontSize: 10,
    primaryColor: '003366',
    outerBorderStyle: 'double',
    showLogo: false,
    showSignatureBlock: false,
  },
  'tpl_luxury': {
    fontFamily: 'Palatino Linotype',
    titleFontSize: 16,
    bodyFontSize: 12,
    questionFontSize: 11,
    primaryColor: '4A0E00',
    outerBorderStyle: 'double',
    showLogo: true,
    showSignatureBlock: true,
    headerLayout: 'centered',
  },
  // ── CLASSIC TEMPLATE ────────────────────
  // Minimal top header (name, class, date, marks only) + MCQ all 4 in one line
  'tpl_classic': {
    fontFamily: 'Times New Roman',
    titleFontSize: 14,
    bodyFontSize: 11,
    questionFontSize: 11,
    primaryColor: '111827',
    outerBorderStyle: 'none',
    outerBorderWidth: 0,
    innerBorderStyle: 'none',
    showLogo: false,
    showSignatureBlock: false,
    headerLayout: 'classic-minimal',
  },
};

// ─────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────

export async function generateDocx(paper: PaperData, templateKey = 'school'): Promise<Buffer> {
  const config = { ...TEMPLATE_CONFIGS.school, ...TEMPLATE_CONFIGS[templateKey] };
  const { examDetails, sections } = paper;
  const totalMarks = sections.reduce((sum, s) => sum + s.totalMarks, 0);

  logger.info(`Generating DOCX for: ${paper.title}, template: ${templateKey}`);

  const children: (Paragraph | Table)[] = [];

  const isClassic = templateKey === 'tpl_classic';
  const primaryHex = config.primaryColor || '1A2E5A';
  const font = config.fontFamily || 'Times New Roman';
  const titleSize = (config.titleFontSize || 16) * 2;
  const bodySize = (config.bodyFontSize || 12) * 2;
  const qSize = (config.questionFontSize || 11) * 2;

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

    // Institution name (centered, bold, uppercase)
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 60 },
        children: [
          new TextRun({
            text: (examDetails.institutionName || 'INSTITUTION NAME').toUpperCase(),
            bold: true,
            size: titleSize,
            font,
            color: '111827',
          }),
        ],
      })
    );
    children.push(makeDivider(BorderStyle.SINGLE, '888888', 2));

    // Meta row: Name / Class / Date / Marks in one line via tab stops
    const q1 = Math.floor(classicPageWidth / 4);
    children.push(
      new Paragraph({
        spacing: { before: 60, after: 60 },
        tabStops: [
          { type: 'left', position: q1 },
          { type: 'left', position: q1 * 2 },
          { type: 'right', position: classicPageWidth },
        ],
        children: [
          new TextRun({ text: 'Name: ___________________', size: bodySize - 2, font }),
          new TextRun({ text: `	Class: ${examDetails.class || '—'}`, size: bodySize - 2, font }),
          new TextRun({ text: `	Date: ${dateStr}`, size: bodySize - 2, font }),
          new TextRun({ text: `	Max. Marks: ${totalMarks || examDetails.totalMarks || '—'}`, size: bodySize - 2, font, bold: true }),
        ],
      })
    );
    children.push(makeDivider(BorderStyle.SINGLE, '888888', 2));
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
        `Max. Marks: ${totalMarks || examDetails.totalMarks || '—'}`,
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

  // ── THIN DIVIDER ──────────────────────────
  children.push(makeDivider(BorderStyle.SINGLE, primaryHex, 2));

  // ── PAPER TITLE ───────────────────────────
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
          underline: { type: UnderlineType.SINGLE },
        }),
      ],
    })
  );

  children.push(makeDivider(BorderStyle.SINGLE, primaryHex, 2));

  // ── INSTRUCTIONS ──────────────────────────
  if (examDetails.instructions && examDetails.instructions.length > 0) {
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
    // Section Header — shaded box
    const marksInfo = section.marksPerQuestion
      ? ` (${section.marksPerQuestion} Mark${section.marksPerQuestion > 1 ? 's' : ''} Each)`
      : section.totalMarks
      ? ` [Total: ${section.totalMarks} Marks]`
      : '';

    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 120 },
        shading: {
          type: ShadingType.SOLID,
          color: 'EEF2FF',
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
            text: marksInfo,
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
      children.push(
        new Paragraph({
          spacing: { before: 120, after: 60 },
          indent: { left: convertInchesToTwip(0.35), hanging: convertInchesToTwip(0.35) },
          tabStops: [{ type: 'right', position: pageWidthTwip }],
          children: [
            new TextRun({ text: `${question.number}.  `, bold: true, size: qSize, font }),
            new TextRun({ text: cleanedText, size: qSize, font }),
          ],
        })
      );

      // ── MCQ OPTIONS ──
      if (question.type === 'MCQ' && fixedOptions.length > 0) {
        const opts =
          fixedOptions.length >= 4
            ? fixedOptions
            : [...fixedOptions, ...Array(4 - fixedOptions.length).fill({ label: '?', text: '___', isCorrect: false })];

        if (isClassic) {
          // Classic: all 4 in one line via tabs
          const colWidth = Math.floor(pageWidthTwip / 4);
          children.push(
            new Paragraph({
              spacing: { before: 40, after: 80 },
              indent: { left: convertInchesToTwip(0.5) },
              tabStops: [
                { type: 'left', position: colWidth },
                { type: 'left', position: colWidth * 2 },
                { type: 'left', position: colWidth * 3 },
              ],
              children: opts.slice(0, 4).flatMap((opt, i) => [
                ...(i > 0 ? [new TextRun({ text: '	', size: qSize - 2, font })] : []),
                new TextRun({ text: `(${opt.label}) `, bold: true, size: qSize - 2, font, color: '222222' }),
                new TextRun({ text: opt.text || '___', size: qSize - 2, font }),
              ]),
            })
          );
        } else {
          // Default: 2x2 — two options per line via tab
          const halfWidth = Math.floor(pageWidthTwip / 2);
          for (let i = 0; i < opts.length; i += 2) {
            const a = opts[i];
            const b = opts[i + 1];
            children.push(
              new Paragraph({
                spacing: { before: 40, after: b ? 0 : 80 },
                indent: { left: convertInchesToTwip(0.5) },
                tabStops: [{ type: 'left', position: halfWidth }],
                children: [
                  new TextRun({ text: `(${a.label}) `, bold: true, size: qSize - 2, font, color: '222222' }),
                  new TextRun({ text: a.text || '___', size: qSize - 2, font }),
                  ...(b ? [
                    new TextRun({ text: '	', size: qSize - 2, font }),
                    new TextRun({ text: `(${b.label}) `, bold: true, size: qSize - 2, font, color: '222222' }),
                    new TextRun({ text: b.text || '___', size: qSize - 2, font }),
                  ] : []),
                ],
              })
            );
          }
        }
      }
      // True/False options
      if (question.type === 'TRUE_FALSE') {
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            indent: { left: convertInchesToTwip(0.35) },
            children: [
              new TextRun({ text: '(a)  True          ', bold: true, size: qSize - 2, font }),
              new TextRun({ text: '(b)  False', bold: true, size: qSize - 2, font }),
            ],
          })
        );
      }

      // Answer lines
      if (question.type !== 'MCQ' && question.type !== 'TRUE_FALSE') {
        const lineCount =
          question.type === 'LONG_ANSWER' ? 6
          : question.type === 'DIAGRAM' ? 8
          : question.type === 'FILL_IN_BLANK' ? 1
          : 2;

        for (let i = 0; i < lineCount; i++) {
          children.push(
            new Paragraph({
              spacing: { before: 80, after: 80 },
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
      children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: '' })] }));
    });
  });

  // ── SIGNATURE BLOCK (default only) — no tables, pure paragraphs ──
  if (!isClassic) {
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
  const doc = new Document({
    sections: [
      {
        properties: {
  page: {
    margin: {
      top: convertInchesToTwip(1.15),
      bottom: convertInchesToTwip(1.15),
      left: convertInchesToTwip(1.25),
      right: convertInchesToTwip(1.25),
    },
    ...(isClassic ? {} : {
      borders: {
        pageBorders: {
          display: PageBorderDisplay.ALL_PAGES,
          offsetFrom: PageBorderOffsetFrom.TEXT,
        },
        pageBorderTop: {
          style: BorderStyle.DOUBLE,
          size: 12,
          color: primaryHex,
          space: 36,
        },
        pageBorderBottom: {
          style: BorderStyle.DOUBLE,
          size: 12,
          color: primaryHex,
          space: 36,
        },
        pageBorderLeft: {
          style: BorderStyle.DOUBLE,
          size: 12,
          color: primaryHex,
          space: 24,
        },
        pageBorderRight: {
          style: BorderStyle.DOUBLE,
          size: 12,
          color: primaryHex,
          space: 24,
        },
      },
    }),
  },
},
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: {
                  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
                },
                children: [
                  new TextRun({
                    text: `${examDetails.subject || 'Subject'} | ${examDetails.class || 'Class'} | ${examDetails.examType || 'Exam'}`,
                    size: 18,
                    color: '999999',
                    font,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                border: {
                  top: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
                },
                children: [
                  new TextRun({ text: 'Page ', size: 18, color: '999999', font }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '999999' }),
                  new TextRun({ text: ' of ', size: 18, color: '999999' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '999999' }),
                  new TextRun({ text: `  |  ${examDetails.institutionName || ''}`, size: 18, color: '999999', font }),
                ],
              }),
            ],
          }),
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

function splitInlineOptions(text: string): Array<{ label: string; text: string; isCorrect: boolean }> {
  const options: Array<{ label: string; text: string; isCorrect: boolean }> = [];
  const pattern = /\(([abcdABCD])\)\s*(.*?)(?=\s*\([abcdABCD]\)\s|\s*$)/gi;
  const matches = [...text.matchAll(pattern)];

  if (matches.length >= 2) {
    matches.forEach(m => {
      const label = m[1].toLowerCase();
      const optText = m[2].trim()
        .replace(/\s*\([abcdABCD]\)\s*$/, '')
        .trim();
      if (!options.find(o => o.label === label)) {
        options.push({ label, text: optText, isCorrect: false });
      }
    });
  }
  return options;
}

function getCleanedQuestion(question: Question): {
  cleanedText: string;
  fixedOptions: Array<{ label: string; text: string; isCorrect: boolean }>;
} {
  let cleanedText = question.text || '';
  let fixedOptions = (question.options || []).map(o => ({ ...o, isCorrect: o.isCorrect ?? false }));

  // Remove marks from text
  cleanedText = cleanedText.replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '').trim();

  // Fix: all crammed in one option
  if (fixedOptions.length === 1 && fixedOptions[0].text.length > 20) {
    const split = splitInlineOptions(fixedOptions[0].text);
    if (split.length >= 2) fixedOptions = split;
  }

  // Fix: no options but text has inline options
  if (fixedOptions.length === 0) {
    const split = splitInlineOptions(cleanedText);
    if (split.length >= 2) {
      const idx = cleanedText.search(/\s*\([abcdABCD]\)/i);
      if (idx > 0) cleanedText = cleanedText.substring(0, idx).trim();
      fixedOptions = split;
    }
  }

  // Clean option texts
  fixedOptions = fixedOptions
    .map(opt => ({
      ...opt,
      text: opt.text
        .replace(/\s*\([abcdABCD]\)\s*.*$/i, '')
        .replace(/\s+[abcdABCD]\)\s*.*$/i, '')
        .trim(),
    }))
    .filter(opt => opt.text.length > 0);

  fixedOptions.sort((a, b) => a.label.localeCompare(b.label));

  return { cleanedText, fixedOptions };
}