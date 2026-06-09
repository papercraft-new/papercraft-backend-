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
        'You are Paptrix AI, an expert educational assistant for Indian schools and colleges.',
        'You help teachers create and improve exam question papers.',
        'You can: generate MCQ/short/long answer questions, analyze papers, suggest improvements, tag Bloom levels.',
        'Supported boards: CBSE, ICSE, State Boards, JEE, NEET, UPSC.',
        paperContext,
        'Keep responses concise and practical. Format questions clearly with numbers and marks.',
      ];
      const systemPrompt = sysLines.filter(Boolean).join(' ');

      const messages = [
        ...(history as Array<{ role: 'user' | 'assistant'; content: string }>).slice(-10),
        { role: 'user' as const, content: message },
      ];

      logger.info('Calling Claude for chat, message length: ' + message.length);
      const response = await callClaude(systemPrompt, messages, 2000, 0.7);

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

    const { subject, topic, count, type, difficulty = 'MIXED', class: cls, marks = 1 } = req.body;

    const systemPrompt = `You are an expert question paper setter for Indian schools and colleges.
Generate exam questions in strict JSON format only. No markdown. No explanation.`;

    const prompt = `Generate ${count} ${type} questions for:
Subject: ${subject}
Topic: ${topic}
Class: ${cls || 'Not specified'}
Difficulty: ${difficulty}
Marks per question: ${marks}

Return ONLY a valid JSON array:
[
  {
    "id": "q_1",
    "number": 1,
    "type": "${type}",
    "text": "Question text here",
    "marks": ${marks},
    ${type === 'MCQ' ? `"options": [
      {"label": "a", "text": "Option A", "isCorrect": false},
      {"label": "b", "text": "Option B", "isCorrect": false},
      {"label": "c", "text": "Option C", "isCorrect": false},
      {"label": "d", "text": "Option D", "isCorrect": false}
    ],` : '"options": [],'}
    "difficulty": "MEDIUM",
    "bloomLevel": "UNDERSTAND",
    "topic": "${topic}"
  }
]`;

    try {
      const response = await callClaude(
        systemPrompt,
        [{ role: 'user', content: prompt }],
        4000,
        0.3
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