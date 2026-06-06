// utils/seed.ts — Run with: npm run db:seed
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ── PLANS ────────────────────────────────
// ── FREE PLAN ──
const freePlan = await prisma.plan.upsert({
  where: { id: 'plan_free' },
  update: {
    papersPerMonth: 3,
    exportsPerMonth: 6,
    priceMonthly: 0,
    priceYearly: 0,
    hasDocxExport: false,
    hasCustomBranding: false,
    features: [
      '3 papers/month',
      '6 exports',
      'PDF export',
      'Basic OCR',
      'Claude AI',
      '3 templates',
    ],
  },
  create: {
    id: 'plan_free',
    name: 'Free',
    type: 'FREE',
    priceMonthly: 0,
    priceYearly: 0,
    papersPerMonth: 3,
    exportsPerMonth: 6,
    templatesCount: 3,
    hasDocxExport: false,
    hasCustomBranding: false,
    hasApiAccess: false,
    hasTeamAccess: false,
    maxTeamMembers: 1,
    storageMb: 100,
    features: [
      '3 papers/month',
      '6 exports',
      'PDF export',
      'Basic OCR',
      'Claude AI',
      '3 templates',
    ],
  },
});

// ── PRO PLAN ──
const proPlan = await prisma.plan.upsert({
  where: { id: 'plan_pro' },
  update: {
    papersPerMonth: 20,
    exportsPerMonth: 40,
    priceMonthly: 39900,
    priceYearly: 399000,
    hasDocxExport: true,
    hasCustomBranding: true,
    features: [
      '20 papers/month',
      '40 exports',
      'PDF + DOCX export',
      'All 6 templates',
      'Custom branding',
      'Priority OCR',
      'Priority support',
    ],
  },
  create: {
    id: 'plan_pro',
    name: 'Pro',
    type: 'PRO',
    priceMonthly: 39900,
    priceYearly: 399000,
    papersPerMonth: 20,
    exportsPerMonth: 40,
    templatesCount: 6,
    hasDocxExport: true,
    hasCustomBranding: true,
    hasApiAccess: false,
    hasTeamAccess: false,
    maxTeamMembers: 1,
    storageMb: 5000,
    features: [
      '20 papers/month',
      '40 exports',
      'PDF + DOCX export',
      'All 6 templates',
      'Custom branding',
      'Priority OCR',
      'Priority support',
    ],
  },
});

// ── INSTITUTION PLAN ──
const institutionPlan = await prisma.plan.upsert({
  where: { id: 'plan_institution' },
  update: {
    papersPerMonth: 50,
    exportsPerMonth: 100,
    priceMonthly: 89900,
    priceYearly: 899000,
    hasDocxExport: true,
    hasCustomBranding: true,
    hasTeamAccess: true,
    maxTeamMembers: 50,
    features: [
      '50 papers/month',
      '100 exports',
      'PDF + DOCX export',
      'All 6 templates',
      'Custom branding',
      '50 team members',
      'Priority support',
    ],
  },
  create: {
    id: 'plan_institution',
    name: 'Institution',
    type: 'INSTITUTION',
    priceMonthly: 89900,
    priceYearly: 899000,
    papersPerMonth: 50,
    exportsPerMonth: 100,
    templatesCount: -1,
    hasDocxExport: true,
    hasCustomBranding: true,
    hasApiAccess: false,
    hasTeamAccess: true,
    maxTeamMembers: 50,
    storageMb: 50000,
    features: [
      '50 papers/month',
      '100 exports',
      'PDF + DOCX export',
      'All 6 templates',
      'Custom branding',
      '50 team members',
      'Priority support',
    ],
  },
});

  console.log('✅ Plans created:', freePlan.name, proPlan.name, institutionPlan.name);

  // ── SYSTEM TEMPLATES ─────────────────────

  const systemTemplates = [
    {
      id: 'tpl_school',
      name: 'School Exam',
      description: 'Classic double-border layout for K-12 schools. CBSE/ICSE style.',
      category: 'school',
      isSystem: true,
      config: {
        fontFamily: 'Times New Roman',
        titleFontSize: 16,
        bodyFontSize: 12,
        questionFontSize: 11,
        primaryColor: '1A2E5A',
        outerBorderStyle: 'double',
        outerBorderWidth: 3,
        innerBorderStyle: 'single',
        innerBorderWidth: 1,
        headerLayout: 'centered',
        showLogo: true,
        showWatermark: false,
        showSignatureBlock: true,
        showQuestionTypeLabels: true,
        showDifficultyMarkers: false,
        questionNumberingStyle: 'numeric',
        lineSpacing: 1.5,
        questionSpacing: 12,
        pageMargins: { top: 72, bottom: 72, left: 90, right: 90 },
      },
    },
    {
      id: 'tpl_college',
      name: 'College Semester',
      description: 'University-style layout for semester and annual exams.',
      category: 'college',
      isSystem: true,
      config: {
        fontFamily: 'Arial',
        titleFontSize: 14,
        bodyFontSize: 11,
        questionFontSize: 11,
        primaryColor: '1C3A6E',
        outerBorderStyle: 'single',
        outerBorderWidth: 2,
        innerBorderStyle: 'none',
        headerLayout: 'two-column',
        showLogo: true,
        showWatermark: false,
        showSignatureBlock: true,
        questionNumberingStyle: 'numeric',
        lineSpacing: 1.5,
        pageMargins: { top: 72, bottom: 72, left: 72, right: 72 },
      },
    },
    {
      id: 'tpl_coaching',
      name: 'Coaching Center',
      description: 'Bold, high-contrast design for coaching institutes and test series.',
      category: 'coaching',
      isSystem: true,
      config: {
        fontFamily: 'Arial',
        titleFontSize: 15,
        bodyFontSize: 12,
        questionFontSize: 11,
        primaryColor: '8B0000',
        outerBorderStyle: 'triple',
        outerBorderWidth: 3,
        headerLayout: 'centered',
        showLogo: true,
        showWatermark: true,
        showSignatureBlock: true,
        questionNumberingStyle: 'numeric',
        lineSpacing: 1.4,
        pageMargins: { top: 60, bottom: 60, left: 72, right: 72 },
      },
    },
    {
      id: 'tpl_competitive',
      name: 'Competitive Exam',
      description: 'Strict, minimal layout for JEE, NEET, UPSC style papers.',
      category: 'competitive',
      isSystem: true,
      config: {
        fontFamily: 'Times New Roman',
        titleFontSize: 13,
        bodyFontSize: 11,
        questionFontSize: 10,
        primaryColor: '003366',
        outerBorderStyle: 'double',
        outerBorderWidth: 2,
        innerBorderStyle: 'none',
        headerLayout: 'centered',
        showLogo: false,
        showWatermark: false,
        showSignatureBlock: false,
        questionNumberingStyle: 'numeric',
        lineSpacing: 1.3,
        pageMargins: { top: 54, bottom: 54, left: 72, right: 72 },
      },
    },
    {
      id: 'tpl_minimal',
      name: 'Minimal',
      description: 'Clean, distraction-free design for modern educators.',
      category: 'minimal',
      isSystem: true,
      config: {
        fontFamily: 'Calibri',
        titleFontSize: 14,
        bodyFontSize: 11,
        questionFontSize: 11,
        primaryColor: '111827',
        outerBorderStyle: 'none',
        innerBorderStyle: 'none',
        headerLayout: 'left',
        showLogo: false,
        showWatermark: false,
        showSignatureBlock: true,
        questionNumberingStyle: 'numeric',
        lineSpacing: 1.6,
        pageMargins: { top: 72, bottom: 72, left: 90, right: 90 },
      },
    },
    {
      id: 'tpl_luxury',
      name: 'Luxury Premium',
      description: 'Decorative premium layout with ornate borders for prestigious institutions.',
      category: 'luxury',
      isSystem: true,
      config: {
        fontFamily: 'Palatino Linotype',
        titleFontSize: 16,
        bodyFontSize: 12,
        questionFontSize: 11,
        primaryColor: '4A0E00',
        outerBorderStyle: 'decorative',
        outerBorderWidth: 4,
        innerBorderStyle: 'double',
        headerLayout: 'centered',
        showLogo: true,
        showWatermark: true,
        showSignatureBlock: true,
        questionNumberingStyle: 'roman',
        lineSpacing: 1.6,
        pageMargins: { top: 90, bottom: 90, left: 108, right: 108 },
      },
    },
  ];

  for (const tpl of systemTemplates) {
    await prisma.template.upsert({
      where: { id: tpl.id },
      update: {},
      create: tpl,
    });
  }

  console.log(`✅ ${systemTemplates.length} system templates created`);

  // ── ADMIN USER ───────────────────────────

  const adminPasswordHash = await bcrypt.hash('admin@papercraft2025', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@papercraft.ai' },
    update: {},
    create: {
      email: 'admin@papercraft.ai',
      name: 'PaperCraft Admin',
      passwordHash: adminPasswordHash,
      role: 'ADMIN',
      emailVerified: true,
      subscription: {
        create: {
          planId: 'plan_institution',
          status: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
      },
    },
  });

  console.log(`✅ Admin user: ${admin.email}`);
  console.log('\n🎉 Seeding complete!');
  console.log('Admin login: admin@papercraft.ai / admin@papercraft2025');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
