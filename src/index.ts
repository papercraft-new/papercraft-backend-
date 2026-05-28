import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';
import { prisma } from './utils/prisma';

// Routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import paperRoutes from './routes/papers';
import ocrRoutes from './routes/ocr';
import templateRoutes from './routes/templates';
import exportRoutes from './routes/exports';
import paymentRoutes from './routes/payments';
import adminRoutes from './routes/admin';
import aiRoutes from './routes/ai';
import otpRoutes from './routes/otp';

// Add with other routes:


dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// ─────────────────────────────────────────
// SECURITY MIDDLEWARE
// ─────────────────────────────────────────

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
    },
  },
}));

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://paptrix.netlify.app',
    process.env.FRONTEND_URL || '',
  ].filter(Boolean),
  credentials: true,
}));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use(globalLimiter);

// ─────────────────────────────────────────
// GENERAL MIDDLEWARE
// ─────────────────────────────────────────

app.use(compression());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      database: 'connected',
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      database: 'disconnected',
      error: String(err),
    });
  }
});
// ─────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/papers', paperRoutes);
app.use('/api/ocr', ocrRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/otp', otpRoutes); 
// ─────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────

app.use(errorHandler);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`🚀 PaperCraft AI Server running on port ${PORT}`);
  logger.info(`📚 Environment: ${process.env.NODE_ENV}`);
  logger.info(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
});

export default app;
