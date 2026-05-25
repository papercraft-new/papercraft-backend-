import { Router, Request, Response } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { processOcrJob } from '../services/ocrService';
import { uploadToCloudinary } from '../utils/cloudinary';
import { logger } from '../utils/logger';
import type { Section } from '../types';


const router = Router();
router.use(authenticate);

const ocrLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 50 });

type OcrResult = {
  rawText: string;
  cleanedText: string;
  sections: Section[];
  confidence: number;
  questionsFound: number;
  sectionsFound: number;
  processingMs: number;
  warnings?: string[];
};

type SuccessfulOcrFileResult = OcrResult & {
  success: true;
  filename: string;
  jobId: string;
};

type FailedOcrFileResult = {
  success: false;
  filename: string;
  jobId: string;
  error: string;
  sections: Section[];
  questionsFound: number;
  sectionsFound: number;
};

type OcrFileResult = SuccessfulOcrFileResult | FailedOcrFileResult;

function isSuccessfulResult(result: OcrFileResult): result is SuccessfulOcrFileResult {
  return result.success;
}

// Allow multiple files — max 10 files, 50MB each
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '50') * 1024 * 1024,
    files: 10,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/tiff',
      'image/webp', 'image/heic', 'application/pdf',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Use JPG, PNG, PDF, TIFF, or HEIC.'));
    }
  },
});

// ─────────────────────────────────────────
// PROCESS SINGLE FILE
// POST /api/ocr/upload
// ─────────────────────────────────────────

router.post(
  '/upload',
  ocrLimiter,
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const userId = (req as any).user.userId;
    const { paperId } = req.body;

    const job = await prisma.ocrJob.create({
      data: {
        userId,
        paperId: paperId || null,
        status: 'PROCESSING',
        inputType: req.file.mimetype.includes('pdf') ? 'pdf' : 'image',
      },
    });

    let fileUrl: string;
    try {
      fileUrl = await uploadToCloudinary(req.file.buffer, req.file.mimetype, `ocr/${userId}`);
    } catch (uploadErr) {
      await prisma.ocrJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorMessage: 'File upload failed' },
      });
      throw uploadErr;
    }

    try {
      const inputType = req.file.mimetype.includes('pdf') ? 'pdf' : 'image';
      const result = await processOcrJob(inputType, fileUrl);

      await prisma.ocrJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          inputUrl: fileUrl,
          rawText: result.rawText,
          cleanedText: result.cleanedText,
          extractedData: result.sections as object[],
          confidence: result.confidence,
          questionsFound: result.questionsFound,
          sectionsFound: result.sectionsFound,
          processingMs: result.processingMs,
        },
      });

      await prisma.usageLog.create({
        data: {
          userId,
          action: 'ocr_processed',
          metadata: { jobId: job.id, inputType, questionsFound: result.questionsFound },
        },
      });

      res.json({ success: true, data: { jobId: job.id, ...result } });

    } catch (ocrErr: unknown) {
      const errorMessage = ocrErr instanceof Error ? ocrErr.message : 'OCR processing failed';
      await prisma.ocrJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorMessage },
      });
      throw ocrErr;
    }
  })
);

// ─────────────────────────────────────────
// PROCESS MULTIPLE FILES
// POST /api/ocr/upload-multiple
// ─────────────────────────────────────────

router.post(
  '/upload-multiple',
  ocrLimiter,
  upload.array('files', 10),
  asyncHandler(async (req: Request, res: Response) => {
   const files = req.files as any[];

    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const userId = (req as any).user.userId;
    const { paperId } = req.body;

    logger.info(`Processing ${files.length} files in parallel for user ${userId}`);

    // Process all files in parallel
    const results: OcrFileResult[] = await Promise.all(
      files.map(async (file, index): Promise<OcrFileResult> => {
        const inputType = file.mimetype.includes('pdf') ? 'pdf' : 'image';

        // Create job record
        const job = await prisma.ocrJob.create({
          data: {
            userId,
            paperId: paperId || null,
            status: 'PROCESSING',
            inputType,
          },
        });

        try {
          // Upload to Cloudinary
          const fileUrl = await uploadToCloudinary(
            file.buffer,
            file.mimetype,
            `ocr/${userId}`
          );

          // Process OCR
          const result = await processOcrJob(inputType, fileUrl);

          // Update job
          await prisma.ocrJob.update({
            where: { id: job.id },
            data: {
              status: 'COMPLETED',
              inputUrl: fileUrl,
              rawText: result.rawText,
              cleanedText: result.cleanedText,
              extractedData: result.sections as object[],
              confidence: result.confidence,
              questionsFound: result.questionsFound,
              sectionsFound: result.sectionsFound,
              processingMs: result.processingMs,
            },
          });

          logger.info(`File ${index + 1}/${files.length} (${file.originalname}): ${result.questionsFound} questions found`);

          return {
            success: true,
            filename: file.originalname,
            jobId: job.id,
            ...result,
          };

        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : 'OCR failed';
          await prisma.ocrJob.update({
            where: { id: job.id },
            data: { status: 'FAILED', errorMessage },
          });

          logger.warn(`File ${index + 1}/${files.length} (${file.originalname}) failed: ${errorMessage}`);

          return {
            success: false,
            filename: file.originalname,
            jobId: job.id,
            error: errorMessage,
            sections: [],
            questionsFound: 0,
            sectionsFound: 0,
          };
        }
      })
    );

    // Merge all successful results into one combined result
    const successful = results.filter(isSuccessfulResult);
    const failed = results.filter((r): r is FailedOcrFileResult => !r.success);

    logger.info(`Multiple OCR complete: ${successful.length} succeeded, ${failed.length} failed`);

    if (successful.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'All files failed to process',
        details: failed.map(f => ({ filename: f.filename, error: f.error })),
      });
    }

    // Merge sections from all files
    const mergedSections = mergeAllSections(successful);
    const totalQuestions = mergedSections.reduce((sum, s) => sum + s.questions.length, 0);

    await prisma.usageLog.create({
      data: {
        userId,
        action: 'ocr_processed_multiple',
        metadata: {
          filesCount: files.length,
          successCount: successful.length,
          questionsFound: totalQuestions,
        },
      },
    });

    res.json({
      success: true,
      data: {
        filesProcessed: files.length,
        filesSucceeded: successful.length,
        filesFailed: failed.length,
        sections: mergedSections,
        questionsFound: totalQuestions,
        sectionsFound: mergedSections.length,
        rawText: successful.map(r => r.rawText).join('\n\n---\n\n'),
        cleanedText: successful.map(r => r.cleanedText).join('\n\n---\n\n'),
        confidence: successful.reduce((sum, r) => sum + r.confidence, 0) / successful.length,
        results: results.map(r => ({
  filename: r.filename,
  success: r.success,
  questionsFound: r.questionsFound || 0,
  error: (r as { error?: string }).error,
}))
,
      },
    });
  })
);

// ─────────────────────────────────────────
// MERGE SECTIONS FROM MULTIPLE FILES
// ─────────────────────────────────────────

function mergeAllSections(results: Array<{ sections: Section[] }>): Section[] {
  const allSections: Section[] = [];
  let questionCounter = 1;

  results.forEach((result, fileIndex) => {
    const sections = result.sections;

    sections.forEach((section) => {
      // Check if section with same title already exists
      const existingSection = allSections.find(
        (s) => s.title === section.title
      );

      if (existingSection) {
        // Merge questions into existing section
        const newQuestions = section.questions.map(q => ({
          ...q,
          number: questionCounter++,
        }));
        existingSection.questions.push(...newQuestions);
        existingSection.totalMarks += section.totalMarks;
      } else {
        // Add as new section with updated question numbers
        const newSection: Section = {
          ...section,
          id: `${section.id}_file${fileIndex}`,
          questions: section.questions.map(q => ({
            ...q,
            number: questionCounter++,
          })),
        };
        allSections.push(newSection);
      }
    });
  });

  return allSections;
}

// ─────────────────────────────────────────
// PROCESS RAW TEXT
// POST /api/ocr/text
// ─────────────────────────────────────────

router.post(
  '/text',
  ocrLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { text, paperId } = req.body;

    if (!text || text.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'Text must be at least 10 characters' });
    }

    const job = await prisma.ocrJob.create({
      data: {
        userId,
        paperId: paperId || null,
        status: 'PROCESSING',
        inputType: 'text',
        rawText: text,
      },
    });

    try {
      const result = await processOcrJob('text', text);

      await prisma.ocrJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          cleanedText: result.cleanedText,
          extractedData: result.sections as object[],
          confidence: result.confidence,
          questionsFound: result.questionsFound,
          sectionsFound: result.sectionsFound,
          processingMs: result.processingMs,
        },
      });

      res.json({ success: true, data: { jobId: job.id, ...result } });

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Processing failed';
      await prisma.ocrJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorMessage },
      });
      throw err;
    }
  })
);

// GET /api/ocr/:jobId
router.get(
  '/:jobId',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { jobId } = req.params;
    const job = await prisma.ocrJob.findFirst({ where: { id: jobId, userId } });
    if (!job) return res.status(404).json({ success: false, error: 'OCR job not found' });
    res.json({ success: true, data: job });
  })
);

// GET /api/ocr
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const [jobs, total] = await Promise.all([
      prisma.ocrJob.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, status: true, inputType: true,
          questionsFound: true, sectionsFound: true,
          confidence: true, processingMs: true, createdAt: true,
        },
      }),
      prisma.ocrJob.count({ where: { userId } }),
    ]);
    res.json({
      success: true,
      data: jobs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

export default router;