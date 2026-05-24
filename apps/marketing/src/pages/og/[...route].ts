// src/pages/og/[...route].png.ts — Dynamic OG image generation (ASMT-08)
// Uses astro-og-canvas + canvaskit-wasm (WASM, not a native binary).
// Produces branded 1200x630 PNGs at build time for every mapped page.
// Unmapped pages fall back to /og-default.png (set in BaseLayout.astro).
import { OGImageRoute } from 'astro-og-canvas';

// Page map: key = OG slug (used in BaseLayout to derive og:image URL),
// value = { title } used when rendering the image.
// Slug scheme: canonical path with leading slash removed, slashes replaced by '-'.
// Root "/" → "index"
const pages = {
  // Home
  'index': { title: 'Candidate & Team Assessment Platform for India' },

  // Top-level
  'about':       { title: 'About AssessIQ' },
  'pricing':     { title: 'Pricing — AssessIQ' },
  'contact':     { title: 'Contact AssessIQ' },
  'security':    { title: 'Security — AssessIQ' },
  'privacy':     { title: 'Privacy Policy — AssessIQ' },
  'terms':       { title: 'Terms of Service — AssessIQ' },
  'methodology': { title: 'Our Assessment Methodology' },
  'compare':     { title: 'AssessIQ vs Competitors' },
  'alternatives':{ title: 'AssessIQ Alternatives' },
  'glossary':    { title: 'Assessment Glossary' },
  'tests':       { title: 'Skill Tests Library' },
  'resources':   { title: 'Hiring Resources & Articles' },
  'solutions':   { title: 'Assessment Solutions' },

  // Solutions
  'solutions-it-hiring':               { title: 'IT & Technical Hiring Assessment Platform' },
  'solutions-campus-recruitment':      { title: 'Campus Recruitment Assessment Platform' },
  'solutions-educational-institutions':{ title: 'Online Assessments for Educational Institutions' },
  'solutions-team-skill-gap':          { title: 'Team Skill-Gap Analysis' },

  // Tests
  'tests-python':           { title: 'Python Skills Assessment Test' },
  'tests-java':             { title: 'Java Skills Assessment Test' },
  'tests-sql':              { title: 'SQL Skills Assessment Test' },
  'tests-javascript':       { title: 'JavaScript Skills Assessment Test' },
  'tests-react':            { title: 'React Skills Assessment Test' },
  'tests-aptitude':         { title: 'Aptitude Test for Hiring' },
  'tests-logical-reasoning':{ title: 'Logical Reasoning Assessment Test' },
  'tests-english':          { title: 'English Language Assessment Test' },

  // Tests — roles
  'tests-role-frontend-developer': { title: 'Frontend Developer Assessment Test' },
  'tests-role-backend-developer':  { title: 'Backend Developer Assessment Test' },
  'tests-role-full-stack-developer':{ title: 'Full-Stack Developer Assessment Test' },
  'tests-role-data-analyst':       { title: 'Data Analyst Assessment Test' },
  'tests-role-software-engineer':  { title: 'Software Engineer Assessment Test' },

  // Alternatives
  'alternatives-mettl':       { title: 'Mercer Mettl Alternative — AssessIQ' },
  'alternatives-hackerearth': { title: 'HackerEarth Alternative — AssessIQ' },
  'alternatives-hackerrank':  { title: 'HackerRank Alternative — AssessIQ' },
  'alternatives-imocha':      { title: 'iMocha Alternative — AssessIQ' },
  'alternatives-amcat':       { title: 'AMCAT Alternative — AssessIQ' },

  // Compare
  'compare-assessiq-vs-mettl':       { title: 'AssessIQ vs Mercer Mettl' },
  'compare-assessiq-vs-hackerearth': { title: 'AssessIQ vs HackerEarth' },
  'compare-assessiq-vs-imocha':      { title: 'AssessIQ vs iMocha' },

  // Glossary
  'glossary-adverse-impact':         { title: 'Adverse Impact — Glossary' },
  'glossary-criterion-validity':     { title: 'Criterion Validity — Glossary' },
  'glossary-construct-validity':     { title: 'Construct Validity — Glossary' },
  'glossary-reliability-coefficient':{ title: 'Reliability Coefficient — Glossary' },
  'glossary-item-response-theory':   { title: 'Item Response Theory — Glossary' },
  'glossary-computer-adaptive-testing':{ title: 'Computer Adaptive Testing — Glossary' },
  'glossary-percentile-rank':        { title: 'Percentile Rank — Glossary' },
  'glossary-norm-referenced-scoring':{ title: 'Norm-Referenced Scoring — Glossary' },
  'glossary-cut-score':              { title: 'Cut Score — Glossary' },
  'glossary-proctoring':             { title: 'Proctoring — Glossary' },

  // Resources
  'resources-technical-hiring-india-guide':   { title: 'Technical Hiring in India — Guide' },
  'resources-reducing-bias-technical-hiring': { title: 'Reducing Bias in Technical Hiring' },
  'resources-remote-proctoring-integrity':    { title: 'Remote Proctoring & Test Integrity' },

  // Tools (ASMT-22)
  'tools':                  { title: 'Free Tools for Hiring Teams' },
  'tools-cost-of-a-bad-hire':{ title: 'Cost of a Bad Hire Calculator (India, ₹)' },
};

// Brand color tokens (from tailwind.config.mjs)
// aiq-fg-primary  #0a0a0b  → [10, 10, 11]
// aiq-accent      #3177dc  → [49, 119, 220]
// aiq-bg-base     #ffffff  → [255, 255, 255]
// aiq-bg-raised   #fafafa  → [250, 250, 250]
// aiq-border      #e4e4e7  → [228, 228, 231]

export const { getStaticPaths, GET } = OGImageRoute({
  param: 'route',
  pages,
  getImageOptions: (_path, page) => {
    return {
      title: page.title,
      description: 'assessiq.in',
      // Brand gradient: accent blue → slightly darker for depth
      bgGradient: [
        [10, 10, 11],     // aiq-fg-primary (ink) — solid dark background
        [20, 20, 24],     // slightly lighter dark for the gradient end
      ],
      border: {
        color: [49, 119, 220],   // aiq-accent
        width: 20,
        side: 'inline-start',   // left border strip — brand mark
      },
      padding: 60,
      font: {
        title: {
          color: [255, 255, 255],  // white on dark bg
          size: 64,
          weight: 'Normal',
          lineHeight: 1.2,
        },
        description: {
          color: [113, 113, 122],  // aiq-fg-muted #71717a → [113, 113, 122]
          size: 36,
          weight: 'Normal',
          lineHeight: 1.4,
        },
      },
      // No custom fonts loaded — uses astro-og-canvas default (avoids font-loading
      // complexity at build time; default font is clean and renders reliably).
      // Serif Newsreader is web-only; TTF loading can be wired later if desired.
    };
  },
});
