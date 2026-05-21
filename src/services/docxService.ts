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
  school: {
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
  college: {
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
  coaching: {
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
  competitive: {
    fontFamily: 'Times New Roman',
    titleFontSize: 13,
    bodyFontSize: 11,
    questionFontSize: 10,
    primaryColor: '003366',
    outerBorderStyle: 'double',
    showLogo: false,
    showSignatureBlock: false,
  },
  luxury: {
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

  const primaryHex = config.primaryColor || '1A2E5A';
  const font = config.fontFamily || 'Times New Roman';
  const titleSize = (config.titleFontSize || 16) * 2;
  const bodySize = (config.bodyFontSize || 12) * 2;
  const qSize = (config.questionFontSize || 11) * 2;

  // ── INSTITUTION NAME ──────────────────────
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

  // ── THICK BORDER LINE ─────────────────────
  children.push(
    new Paragraph({
      spacing: { before: 40, after: 80 },
      border: {
        bottom: { style: BorderStyle.DOUBLE, size: 6, color: primaryHex },
      },
      children: [new TextRun({ text: '' })],
    })
  );

  // ── META INFO TABLE ───────────────────────
  const dateStr = examDetails.date
    ? new Date(examDetails.date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      })
    : '—';

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

  

  const metaTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: metaRows.map(row =>
      new TableRow({
        children: row.map((cell, idx) =>
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.NONE },
              bottom: { style: BorderStyle.NONE },
              left: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE },
            },
            children: [
              new Paragraph({
                alignment: idx === 1 ? AlignmentType.RIGHT : AlignmentType.LEFT,
                children: [
                  new TextRun({
                    text: cell,
                    size: bodySize - 2,
                    font,
                    bold: cell.startsWith('Max') || cell.startsWith('Date'),
                  }),
                ],
              }),
            ],
          })
        ),
      })
    ),
  });

  children.push(metaTable);

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
      // Fix options if needed
      const { cleanedText, fixedOptions } = getCleanedQuestion(question);

      // Question text row with marks on right
      const questionTable = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            children: [
              // Number cell
              new TableCell({
                width: { size: 5, type: WidthType.PERCENTAGE },
                borders: noBorders(),
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: `${question.number}.`,
                        bold: true,
                        size: qSize,
                        font,
                      }),
                    ],
                  }),
                ],
              }),
              // Question text cell
              new TableCell({
                width: { size: 88, type: WidthType.PERCENTAGE },
                borders: noBorders(),
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: cleanedText,
                        size: qSize,
                        font,
                      }),
                    ],
                  }),
                ],
              }),
              // Marks cell
              new TableCell({
                width: { size: 7, type: WidthType.PERCENTAGE },
                borders: noBorders(),
                children: [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: [
                      new TextRun({
                        text: `[${question.marks}]`,
                        bold: true,
                        size: qSize - 2,
                        font,
                        color: primaryHex,
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });

      children.push(questionTable);

      // MCQ Options in 2x2 grid
if (question.type === 'MCQ' && fixedOptions.length > 0) {
  const opts =
    fixedOptions.length >= 4
      ? fixedOptions
      : [
          ...fixedOptions,
          ...Array(4 - fixedOptions.length).fill({ label: '?', text: '___', isCorrect: false }),
        ];

  const optionRows = [];

  for (let i = 0; i < opts.length; i += 2) {
    const rowOpts = opts.slice(i, i + 2);

    while (rowOpts.length < 2) {
      rowOpts.push({ label: '', text: '', isCorrect: false });
    }

    optionRows.push(
      new TableRow({
        children: rowOpts.map(opt =>
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: noBorders(),
            margins: {
              top: 40,
              bottom: 40,
              left: 60,
              right: 60,
            },
            children: [
              new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                layout: TableLayoutType.FIXED,
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({
                        width: { size: 12, type: WidthType.PERCENTAGE },
                        borders: noBorders(),
                        children: [
                          new Paragraph({
                            alignment: AlignmentType.LEFT,
                            spacing: { before: 0, after: 0 },
                            children: [
                              new TextRun({
                                text: opt.label ? `(${opt.label})` : '',
                                bold: true,
                                size: qSize - 2,
                                font,
                                color: '222222',
                              }),
                            ],
                          }),
                        ],
                      }),
                      new TableCell({
                        width: { size: 88, type: WidthType.PERCENTAGE },
                        borders: noBorders(),
                        children: [
                          new Paragraph({
                            alignment: AlignmentType.LEFT,
                            spacing: { before: 0, after: 0 },
                            children: [
                              new TextRun({
                                text: opt.text || '_______________',
                                size: qSize - 2,
                                font,
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          })
        ),
      })
    );
  }

  const optTable = new Table({
    width: { size: 90, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: optionRows,
    margins: {
      left: convertInchesToTwip(0.3),
    },
  });

  children.push(optTable);
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

  // ── SIGNATURE BLOCK ───────────────────────
  children.push(makeDivider(BorderStyle.DOUBLE, primaryHex, 4));

  const signatureTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        children: ['Subject Teacher', 'HOD / Principal', 'Exam Controller'].map(label =>
          new TableCell({
            width: { size: 33, type: WidthType.PERCENTAGE },
            borders: noBorders(),
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 600, after: 60 },
                border: {
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: '333333' },
                },
                children: [new TextRun({ text: ' ', size: bodySize, font })],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: label,
                    size: bodySize - 4,
                    font,
                    color: '555555',
                  }),
                ],
              }),
            ],
          })
        ),
      }),
    ],
  });

  children.push(signatureTable);

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