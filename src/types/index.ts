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
}

// ── QUESTIONS ─────────────────────────────

export interface McqOption {
  label: string;   // a, b, c, d
  text: string;
  isCorrect?: boolean;
}

export interface Question {
  id: string;
  number: number;
  type: QuestionType;
  text: string;
  marks: number;
  options?: McqOption[];        // for MCQ
  subQuestions?: SubQuestion[]; // for multi-part
  imageUrl?: string;
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
  headerLayout: 'centered' | 'left' | 'two-column';
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
