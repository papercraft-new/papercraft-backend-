// ─────────────────────────────────────────
// PaperCraft AI - Core TypeScript Types
// ─────────────────────────────────────────

// ── AUTH ──────────────────────────────────

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  avatarUrl: string | null;
  subscription?: {
    plan: string;
    status: string;
    papersUsed: number;
    papersLimit: number;
  };
}

// ── EXAM DETAILS ──────────────────────────

export interface ExamDetails {
  institutionName: string;
  institutionAddress?: string;
  logoUrl?: string;
  subject: string;
  subjectCode?: string;
  examType: string;       // Final, Mid-term, Unit Test, etc.
  class: string;          // Class X, Grade 10, B.Tech 2nd Year
  branch?: string;
  academicYear: string;
  date: string;           // ISO date string
  duration: string;       // "3 Hours", "2:30 Hours"
  totalMarks: number;
  internalMarks?: number;
  externalMarks?: number;
  facultyName?: string;
  department?: string;
  instructions: string[]; // array of instruction strings
  watermarkText?: string;
  showAnswerSpace?: boolean;
  answerLines?: 'none' | 'two';   // absent (older papers) = two blank lines after calculation-type questions
}

// ── QUESTIONS ─────────────────────────────

/** An image attached to a question or to one MCQ option. Only `id` and `url` are required. */
export interface QuestionImage {
  id: string;
  url: string;
  width?: number;   // natural pixels
  height?: number;
  size?: 'small' | 'medium' | 'large' | 'full';   // print size, default medium
  alt?: string;
}

/** A grid of plain-text cells under a question. Only `rows` is required. */
export interface QuestionTable {
  id?: string;
  rows: string[][];
  headerRow?: boolean;   // first row is a header, default true
}

/** Columns of a match-the-following question. Only `left` and `right` are required. */
export interface QuestionMatch {
  leftTitle?: string;    // absent = "Column A", '' = no heading
  rightTitle?: string;   // absent = "Column B", '' = no heading
  left: string[];
  right: string[];
  answerBox?: boolean;   // "(      )" after each left item, default true
}

/**
 * Where a diagram sits on an uploaded page, as fractions (0 to 1) of the page width and height.
 * Only in the extraction response: the browser cuts the picture out and attaches it as a
 * question image, then drops this field, so it is never saved.
 */
export interface FigureBox {
  sourceIndex?: number;  // which uploaded file (0 = first)
  page: number;          // 1-based page (always 1 for an image)
  x: number;
  y: number;
  w: number;
  h: number;
  caption?: string;
}

export interface McqOption {
  label: string;   // a, b, c, d
  text: string;
  isCorrect?: boolean;
  image?: QuestionImage;   // optional picture for this option
}

export interface Question {
  id: string;
  number: number;
  type: QuestionType;
  text: string;
  marks: number;
  options?: McqOption[];        // for MCQ
  subQuestions?: SubQuestion[]; // for multi-part
  imageUrl?: string;            // legacy, unused
  images?: QuestionImage[];     // pictures shown under the question text (max 5)
  tables?: QuestionTable[];     // tables shown under the question text (max 3)
  match?: QuestionMatch;        // columns of a MATCH_FOLLOWING question (max 10 items per column)
  figureBoxes?: FigureBox[];    // extraction response only, never saved (see FigureBox)
  hint?: string;
  bloomLevel?: BloomLevel;
  difficulty?: DifficultyLevel;
  topic?: string;
  answerKey?: string;           // for answer schemes
}

export interface SubQuestion {
  id: string;
  label: string;   // (i), (ii), (a), (b)
  text: string;
  marks: number;
  type: QuestionType;
  imageUrl?: string;
}

export type QuestionType =
  | 'MCQ'
  | 'SHORT_ANSWER'
  | 'LONG_ANSWER'
  | 'FILL_IN_BLANK'
  | 'TRUE_FALSE'
  | 'MATCH_FOLLOWING'
  | 'DIAGRAM'
  | 'NUMERICAL';

export type DifficultyLevel = 'EASY' | 'MEDIUM' | 'HARD';

export type BloomLevel =
  | 'REMEMBER'
  | 'UNDERSTAND'
  | 'APPLY'
  | 'ANALYZE'
  | 'EVALUATE'
  | 'CREATE';

// ── SECTIONS ──────────────────────────────

export interface Section {
  id: string;
  title: string;            // "Section A", "Part I", "SECTION-A"
  description?: string;     // "Answer all questions"
  questionType?: QuestionType;
  marksPerQuestion?: number;
  totalMarks: number;
  questions: Question[];
}

// ── PAPER ─────────────────────────────────

export interface PaperData {
  id?: string;
  title: string;
  examDetails: ExamDetails;
  sections: Section[];
  templateId?: string;
  totalMarks: number;
  questionCount: number;
  status: 'DRAFT' | 'PROCESSING' | 'READY' | 'ARCHIVED';
  tags?: string[];
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

// ── TEMPLATES ─────────────────────────────

export interface TemplateConfig {
  // Typography
  fontFamily: string;
  titleFontSize: number;
  bodyFontSize: number;
  questionFontSize: number;

  // Colors
  primaryColor: string;
  secondaryColor: string;
  borderColor: string;
  backgroundColor: string;

  // Borders
  outerBorderStyle: 'none' | 'single' | 'double' | 'triple' | 'decorative';
  outerBorderWidth: number;
  innerBorderStyle: 'none' | 'single' | 'double';
  innerBorderWidth: number;
  sectionDividerStyle: 'solid' | 'dashed' | 'dotted' | 'double';

  // Layout
  pageMargins: { top: number; bottom: number; left: number; right: number };
  headerLayout: 'centered' | 'left' | 'two-column' | 'classic-minimal' | 'worksheet' | 'professional';
  questionSpacing: number;
  lineSpacing: number;

  // Features
  showLogo: boolean;
  showWatermark: boolean;
  showSignatureBlock: boolean;
  showQuestionTypeLabels: boolean;
  showDifficultyMarkers: boolean;
  questionNumberingStyle: 'numeric' | 'roman' | 'alpha';
}

// ── OCR ───────────────────────────────────

export interface OcrResult {
  jobId: string;
  rawText: string;
  cleanedText: string;
  confidence: number;
  sections: Section[];
  questionsFound: number;
  sectionsFound: number;
  processingMs: number;
  warnings: string[];
}

// ── API RESPONSES ─────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// ── AI CHAT ───────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ── EXPORT ────────────────────────────────

export interface ExportOptions {
  format: 'PDF' | 'DOCX';
  includeAnswerKey?: boolean;
  includeWatermark?: boolean;
  copies?: number;
}

// ── ADMIN ANALYTICS ───────────────────────

export interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  totalPapers: number;
  totalExports: number;
  totalOcrJobs: number;
  mrr: number;
  usersByPlan: { plan: string; count: number }[];
  papersLastMonth: number;
  signupsLastMonth: number;
  topSubjects: { subject: string; count: number }[];
}