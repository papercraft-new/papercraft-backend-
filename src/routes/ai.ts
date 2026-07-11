import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import type { Section, Question } from '../types';

const router = Router();
router.use(authenticate);

const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 100 });

// ─────────────────────────────────────────
// CLAUDE SONNET HELPER (chat, generate, analyze, bloom)
// ─────────────────────────────────────────

async function callClaude(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 2000,
  temperature = 0.7
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured.');
  }

  logger.info('Calling Claude Sonnet API...');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    logger.error(`Claude API error ${response.status}:`, errText);
    throw new Error(`Claude API error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);

  const text = data.content?.[0]?.text || '';
  if (!text) throw new Error('Claude returned empty response');

  logger.info(`Claude response: ${text.length} chars`);
  return text;
}

// ─────────────────────────────────────────
// AI CHAT
// POST /api/ai/chat
// ─────────────────────────────────────────

router.post(
  '/chat',
  aiLimiter,
  [
    body('message').trim().isLength({ min: 1, max: 2000 }),
    body('history').optional().isArray(),
    body('paperId').optional().isString(),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = (req as any).user.userId;
    const { message, history = [], paperId } = req.body;

    try {
      // Load paper context if provided
      let paperContext = '';
      if (paperId) {
        try {
          const paper = await prisma.paper.findFirst({
            where: { id: paperId, userId },
            select: { title: true, examDetails: true, totalMarks: true },
          });
          if (paper) {
            const ed = (paper.examDetails as Record<string, unknown>) || {};
            paperContext = 'Current paper: ' + paper.title + ', Subject: ' + (ed.subject || '-') + ', Class: ' + (ed.class || '-') + ', Marks: ' + (paper.totalMarks || '-');
          }
        } catch { /* paper context is optional */ }
      }

      const sysLines = [
        `You are Paptrix AI — an elite Indian educational examiner and question paper expert with 20+ years of experience across CBSE, ICSE, all State Boards, JEE, NEET, UPSC, and University examinations.`,

        `YOUR CORE EXPERTISE:
- Designing question papers that are perfectly syllabus-aligned and age-appropriate
- Generating high-quality MCQ, Short Answer, Long Answer, Fill in the Blank, True/False and Numerical questions
- Following official board patterns (CBSE, ICSE, State Boards) and marking schemes exactly
- Applying Bloom's Taxonomy (Remember, Understand, Apply, Analyze, Evaluate, Create)
- Differentiating difficulty levels (Easy/Medium/Hard) with professional precision
- Balancing question paper sections with proper marks distribution
- Identifying weak/strong questions and suggesting improvements`,

        `HOW YOU GENERATE QUESTIONS:
- Use precise, formal examination language — never casual
- Questions test real understanding, not just word-for-word recall
- MCQ options are plausible distractors based on common misconceptions
- Short answer questions use action verbs: Define, State, Explain, Differentiate, Justify
- Long answer questions use: Discuss, Analyze, Compare, Evaluate, Describe with examples
- Every question is unique — never repeat similar ideas
- Questions feel like they belong on a real board examination paper`,

        `SUPPORTED BOARDS & LEVELS:
- Primary (Class 1–5): Simple language, basic recall
- Middle School (Class 6–8): Application-based, conceptual
- Secondary (Class 9–10): Board pattern, marks-weighted
- Senior Secondary (Class 11–12): Advanced, JEE/NEET aligned
- Degree/University: Technical, framework-based, analytical`,

        paperContext ? `CURRENT PAPER CONTEXT: ${paperContext}` : '',

        `RESPONSE STYLE:
- Be concise and practical — teachers are busy
- When generating questions, format them clearly with question numbers and marks
- When asked to improve a question, explain WHY the new version is better
- For marks distribution advice, give specific section-wise breakdowns
- Always confirm board/class before generating to ensure perfect alignment
- If something is unclear, ask ONE clarifying question before proceeding`,
      ];
      const systemPrompt = sysLines.filter(Boolean).join('\n\n');

      const messages = [
        ...(history as Array<{ role: 'user' | 'assistant'; content: string }>).slice(-10),
        { role: 'user' as const, content: message },
      ];

      logger.info('Calling Claude for chat, message length: ' + message.length);
      const response = await callClaude(systemPrompt, messages, 4000, 0.7);

      try {
        await prisma.usageLog.create({
          data: { userId, action: 'ai_chat', metadata: { paperId, messageLength: message.length } },
        });
      } catch { /* non-critical */ }

      res.json({
        success: true,
        data: { reply: response },
      });

    } catch (err: unknown) {
      console.error('AI chat raw error:', err);
      const errMsg = err instanceof Error ? (err.message || err.toString()) : String(err);
      logger.error('AI chat error: ' + errMsg);
      res.status(500).json({
        success: false,
        error: errMsg || 'AI service unavailable',
      });
    }
  })
);

// ─────────────────────────────────────────
// GENERATE QUESTIONS
// POST /api/ai/generate-questions
// ─────────────────────────────────────────

router.post(
  '/generate-questions',
  aiLimiter,
  [
    body('subject').trim().isLength({ min: 1, max: 100 }),
    body('topic').trim().isLength({ min: 1, max: 200 }),
    body('count').isInt({ min: 1, max: 20 }),
    body('type').isIn(['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'FILL_IN_BLANK', 'TRUE_FALSE', 'NUMERICAL']),
    body('difficulty').optional().isIn(['EASY', 'MEDIUM', 'HARD', 'MIXED']),
    body('marks').optional().isInt({ min: 1, max: 20 }),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { subject, topic, count, type, difficulty = 'MIXED', class: cls, marks = 1, board } = req.body;

    const classNum = parseInt(cls || '10');
    const isHigherEd = classNum > 12;
    const boardLabel = board || (classNum <= 10 ? 'CBSE' : classNum <= 12 ? 'CBSE/State Board' : 'University');

    const diffGuide =
      difficulty === 'EASY'   ? 'All questions should be straightforward recall and basic understanding. Students should be able to answer them confidently with textbook knowledge.' :
      difficulty === 'HARD'   ? 'All questions must be challenging — requiring deep analysis, multi-step reasoning, or application to unfamiliar scenarios. Designed for distinction-level students.' :
      difficulty === 'MEDIUM' ? 'Questions require understanding and application, not just recall. Include multi-concept questions that make students think.' :
      `Mix difficulty: ${Math.round(count * 0.3)} easy (recall/knowledge), ${Math.round(count * 0.4)} medium (application/understanding), ${Math.round(count * 0.3)} hard (analysis/evaluation).`;

    const typeInstructions: Record<string, string> = {
      MCQ: `RULES FOR MCQ:
- Exactly 4 options (a, b, c, d) — one clearly correct, three plausible distractors
- All options similar in length and grammatical structure
- No "All of the above" or "None of the above" unless absolutely necessary
- Question stem must be a complete, unambiguous sentence
- Distractors must be common misconceptions or related concepts — not obviously wrong
- Test understanding and application, not word-for-word textbook recall
- Mark exactly one option isCorrect: true`,

      SHORT_ANSWER: `RULES FOR SHORT ANSWER:
- Answerable in 3–5 lines / 2–4 sentences
- Use precise action verbs: Define, State, Explain, Differentiate, Give an example of, List, Justify
- Never use vague stems like "Write about..."
- Each question must test a specific, well-defined concept
- ${marks} mark(s) = expect ${marks * 2}–${marks * 3} key answer points`,

      LONG_ANSWER: `RULES FOR LONG ANSWER:
- Requires detailed answer of 10–15 lines
- Use higher-order action verbs: Discuss in detail, Compare and contrast, Critically analyze, Evaluate, Describe with examples, Justify with reasons
- May include structured sub-parts (a), (b), (c)
- ${marks} marks = expect ${marks * 2}–${marks * 3} key points
- Test synthesis and evaluation — not just recall`,

      FILL_IN_BLANK: `RULES FOR FILL IN THE BLANK:
- Exactly ONE blank per question shown as _______
- The blank must be a key term, formula, value or important concept
- Sentence must be meaningful and contextual without the blank
- Answer must be a single word or short phrase (max 4 words)
- Avoid blanks at the very beginning of sentences`,

      TRUE_FALSE: `RULES FOR TRUE/FALSE:
- Statement must be absolutely true OR absolutely false — no partial truths
- Test conceptual understanding, not trivial facts
- Avoid tricky wording or double negatives
- Mix of true (~50%) and false (~50%) statements
- False statements should be based on common misconceptions`,

      NUMERICAL: `RULES FOR NUMERICAL:
- Include all given data with proper units
- Single definite numerical answer
- Use realistic non-trivial values
- Clearly state the formula/concept being tested
- Easy = direct substitution; Medium = 2-step; Hard = multi-step derivation`,
    };

    const boardStyle = isHigherEd
      ? `University/Degree level: Use technical terminology, reference theoretical frameworks, expect comprehensive answers. Align with university examination standards.`
      : classNum >= 11
      ? `Class ${cls} ${boardLabel}: Align with NCERT/board syllabus strictly. Science: include numerical + conceptual. Commerce: include case-based. Humanities: include analytical questions. Match board exam pattern exactly.`
      : `Class ${cls} ${boardLabel}: Age-appropriate clear language. Classes 1-5: very simple language. Classes 6-8: include application. Classes 9-10: match board exam pattern with proper marks weightage.`;

    const systemPrompt = `You are a senior Indian academic examiner with 20+ years of experience setting question papers for CBSE, ICSE, State Boards, JEE, NEET and University examinations.

Your questions are known for:
- Perfect syllabus alignment with NCERT and board curriculum
- Clear, unambiguous language appropriate for the student level
- Genuine intellectual challenge that tests real understanding
- Following official board examination patterns exactly
- Using precise academic terminology and formal examination language
- Never generating trivial, repetitive or poorly worded questions

You generate questions that experienced teachers trust completely and students find fair, relevant and intellectually stimulating. Every question you generate feels like it belongs on an actual board examination paper.

CRITICAL: Return ONLY valid JSON array. No markdown. No explanation. No preamble. No trailing text.`;

    const prompt = `Generate ${count} high-quality ${type} exam questions.

EXAM CONTEXT:
- Subject: ${subject}
- Topic/Chapter: ${topic}
- Class/Level: ${cls || 'Not specified'}
- Board: ${boardLabel}
- Marks per question: ${marks}
- Difficulty: ${difficulty}

DIFFICULTY GUIDE:
${diffGuide}

QUESTION TYPE RULES:
${typeInstructions[type] || ''}

BOARD/LEVEL STYLE:
${boardStyle}

BLOOM'S TAXONOMY — distribute across questions:
- REMEMBER (recall): ~20% | UNDERSTAND (explain): ~25% | APPLY (use): ~30% | ANALYZE: ~15% | EVALUATE/CREATE: ~10%

MANDATORY QUALITY RULES:
1. Every question tests a DIFFERENT concept/sub-topic — no repetition of ideas
2. Formal examination language — no casual or conversational phrasing
3. Questions must be answerable from standard textbooks for this class/board
4. No ambiguous questions, no "from the above" cross-references
5. Each question complete and standalone
6. Do NOT include answers inside the question text
7. Every question must feel like it genuinely belongs on a real ${boardLabel} exam paper for Class ${cls || '10'}

Return ONLY this JSON array:
[
  {
    "id": "q_1",
    "number": 1,
    "type": "${type}",
    "text": "Complete question text in formal examination language",
    "marks": ${marks},
    ${type === 'MCQ' ? `"options": [
      {"label": "a", "text": "First plausible option", "isCorrect": false},
      {"label": "b", "text": "Correct answer option", "isCorrect": true},
      {"label": "c", "text": "Third plausible option", "isCorrect": false},
      {"label": "d", "text": "Fourth plausible option", "isCorrect": false}
    ],` : '"options": [],'}
    "difficulty": "EASY|MEDIUM|HARD",
    "bloomLevel": "REMEMBER|UNDERSTAND|APPLY|ANALYZE|EVALUATE|CREATE",
    "topic": "${topic}",
    "expectedAnswer": "Key answer points for teacher reference"
  }
]`;

    try {
      const response = await callClaude(
        systemPrompt,
        [{ role: 'user', content: prompt }],
        6000,
        0.65
      );

      let questions: Question[] = [];
      try {
        const cleaned = response
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
          questions = JSON.parse(match[0]);
        } else {
          questions = JSON.parse(cleaned);
        }
      } catch {
        return res.status(500).json({
          success: false,
          error: 'AI returned invalid format. Please try again.',
        });
      }

      res.json({ success: true, data: { questions, count: questions.length } });

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Generation failed';
      res.status(500).json({ success: false, error: errMsg });
    }
  })
);

// ─────────────────────────────────────────
// ENHANCE PAPER
// POST /api/ai/enhance
// ─────────────────────────────────────────

router.post(
  '/enhance',
  aiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { paperId } = req.body;

    const paper = await prisma.paper.findFirst({ where: { id: paperId, userId } });
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }

    const sections = paper.sections as unknown as Section[];
    const totalQ = sections.reduce((s, sec) => s + sec.questions.length, 0);

    const systemPrompt = `You are an expert educational assessment analyst. 
Analyze question papers and provide structured improvement suggestions in JSON format only.`;

    const prompt = `Analyze this exam paper and provide suggestions:

Title: ${paper.title}
Total Marks: ${paper.totalMarks}
Total Questions: ${totalQ}
Sections: ${sections.map(s => `${s.title} (${s.questions.length} questions)`).join(', ')}

Sample questions:
${sections.slice(0, 2).map(s =>
  s.questions.slice(0, 3).map(q => `- ${q.text} [${q.marks} marks]`).join('\n')
).join('\n')}

Return ONLY this JSON:
{
  "suggestions": [
    {
      "type": "balance",
      "severity": "medium",
      "description": "Issue description",
      "fix": "How to fix it"
    }
  ],
  "overallScore": 80,
  "marksBalance": {"easy": 30, "medium": 50, "hard": 20},
  "summary": "2 sentence overall assessment"
}`;

    try {
      const response = await callClaude(
        systemPrompt,
        [{ role: 'user', content: prompt }],
        1500,
        0.3
      );

      let analysis;
      try {
        const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        analysis = match ? JSON.parse(match[0]) : { suggestions: [], summary: response, overallScore: 75 };
      } catch {
        analysis = { suggestions: [], summary: 'Analysis complete.', overallScore: 75 };
      }

      res.json({ success: true, data: analysis });

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Enhancement failed';
      res.status(500).json({ success: false, error: errMsg });
    }
  })
);

// ─────────────────────────────────────────
// BLOOM TAG
// POST /api/ai/bloom-tag
// ─────────────────────────────────────────

router.post(
  '/bloom-tag',
  aiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { questions } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: 'Questions array required' });
    }

    const systemPrompt = `You are an educational taxonomy expert. Tag questions with Bloom's Taxonomy levels. Return JSON only.`;

    const prompt = `Tag each question with Bloom's level and difficulty:

${questions.map((q: { id: string; text: string }, i: number) => `${i + 1}. [${q.id}] ${q.text}`).join('\n')}

Return ONLY this JSON array:
[
  {
    "id": "question_id",
    "bloomLevel": "REMEMBER|UNDERSTAND|APPLY|ANALYZE|EVALUATE|CREATE",
    "difficulty": "EASY|MEDIUM|HARD"
  }
]`;

    try {
      const response = await callClaude(
        systemPrompt,
        [{ role: 'user', content: prompt }],
        1000,
        0.2
      );

      let tags;
      try {
        const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const match = cleaned.match(/\[[\s\S]*\]/);
        tags = match ? JSON.parse(match[0]) : [];
      } catch {
        return res.status(500).json({ success: false, error: 'Tagging failed. Try again.' });
      }

      res.json({ success: true, data: { tags } });

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Tagging failed';
      res.status(500).json({ success: false, error: errMsg });
    }
  })
);

export default router;