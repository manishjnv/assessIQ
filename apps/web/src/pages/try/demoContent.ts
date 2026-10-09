// Fixed, bundled content + deterministic client-side scoring for the public
// /try demo. NOTHING here touches the network: no api.ts, no fetch, no AI.
// Scoring mirrors modules/09-scoring/src/mcq.ts (numeric = absolute tolerance,
// multi-select = exact set or partial) but is re-implemented here because that
// module pulls server-only deps. The questions are demo-only dummy content.

export type DemoType = 'mcq' | 'numeric' | 'multi_select' | 'written' | 'log';

export interface DemoQuestion {
  id: string;
  type: DemoType;
  /** Human label for the type chip. */
  typeLabel: string;
  prompt: string;
  /** Preformatted excerpt (log item). */
  excerpt?: string;
  options?: string[];
  unit?: string;
  /** mcq/log: option index. multi_select: option indexes. numeric: the number. */
  correct?: number | number[];
  tolerance?: number;
  partial?: boolean;
  /** Points available; 0 = not scored in the demo (written). */
  points: number;
  modelAnswer: string;
  why?: string;
}

export const DEMO_MINUTES = 10;
export const PASS_PERCENT = 60;

export const DEMO_QUESTIONS: DemoQuestion[] = [
  {
    id: 'd1', type: 'mcq', typeLabel: 'Multiple choice', points: 10,
    prompt: 'A shirt costs ₹800 after a 20% discount. What was the original price?',
    options: ['₹960', '₹1,000', '₹1,040', '₹1,200'],
    correct: 1,
    modelAnswer: '₹1,000',
    why: '800 is 80% of the original, so the original is 800 / 0.8 = 1,000.',
  },
  {
    id: 'd2', type: 'numeric', typeLabel: 'Numeric', points: 10, unit: 'km/h', tolerance: 0.5,
    prompt: 'A 150 m long train passes a pole in 10 seconds. What is its speed in km/h?',
    correct: 54,
    modelAnswer: '54 km/h (answers within 0.5 are accepted)',
    why: '150 m / 10 s = 15 m/s, and 15 × 3.6 = 54 km/h.',
  },
  {
    id: 'd3', type: 'multi_select', typeLabel: 'Select all that apply', points: 10, partial: true,
    prompt: 'Which of these numbers are prime?',
    options: ['2', '9', '11', '15', '17'],
    correct: [0, 2, 4],
    modelAnswer: '2, 11 and 17',
    why: '9 = 3 × 3 and 15 = 3 × 5. Partial credit: each wrong pick cancels a right one.',
  },
  {
    id: 'd4', type: 'mcq', typeLabel: 'Multiple choice', points: 10,
    prompt: 'Which HTTP status code means the request lacks valid authentication credentials?',
    options: ['301', '401', '404', '503'],
    correct: 1,
    modelAnswer: '401 Unauthorized',
    why: '301 is a redirect, 404 means not found, 503 means the service is unavailable.',
  },
  {
    id: 'd5', type: 'log', typeLabel: 'Log analysis', points: 10,
    prompt: 'Read this authentication log excerpt. What is the most likely explanation?',
    excerpt: [
      '10:02:11 sshd[412]: Failed password for root from 203.0.113.45',
      '10:02:12 sshd[413]: Failed password for admin from 203.0.113.45',
      '10:02:12 sshd[414]: Failed password for test from 203.0.113.45',
      '10:02:13 sshd[415]: Failed password for ubuntu from 203.0.113.45',
      '10:02:14 sshd[416]: Failed password for user from 203.0.113.45',
    ].join('\n'),
    options: [
      'One employee mistyping their password',
      'A brute-force attempt from a single IP address',
      'A normal scheduled backup login',
      'A distributed attack from many IP addresses',
    ],
    correct: 1,
    modelAnswer: 'A brute-force attempt from a single IP address',
    why: 'Five different usernames in four seconds from one address is automated guessing, not a person mistyping.',
  },
  {
    id: 'd6', type: 'numeric', typeLabel: 'Numeric', points: 10, tolerance: 0,
    prompt: 'What comes next in the series 2, 6, 12, 20, ?',
    correct: 30,
    modelAnswer: '30',
    why: 'The gaps are 4, 6, 8, so the next gap is 10 and 20 + 10 = 30.',
  },
  {
    id: 'd7', type: 'written', typeLabel: 'Written answer', points: 0,
    prompt: 'In two or three sentences, explain why a password-reset link should expire after a short time.',
    modelAnswer:
      'An unused reset link is a live credential. If it sits in an inbox or browser history it can be found or forwarded and used to take over the account, so a short expiry (and single use) limits how long an attacker has to exploit it.',
  },
];

export type DemoAnswer = number | number[] | string | null | undefined;
export type DemoAnswers = Record<string, DemoAnswer>;

export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 0..1 fraction of the question's points earned. Written is never scored. */
export function fractionFor(q: DemoQuestion, a: DemoAnswer): number {
  if (q.type === 'written' || a == null) return 0;
  if (q.type === 'mcq' || q.type === 'log') return a === q.correct ? 1 : 0;
  if (q.type === 'numeric') {
    const n = parseNumber(a);
    if (n === null || typeof q.correct !== 'number') return 0;
    return Math.abs(n - q.correct) <= (q.tolerance ?? 0) + 1e-9 ? 1 : 0;
  }
  // multi_select
  const key = new Set(q.correct as number[]);
  const picked = new Set(Array.isArray(a) ? (a as number[]) : []);
  let right = 0;
  let wrong = 0;
  for (const i of picked) {
    if (key.has(i)) right++;
    else wrong++;
  }
  if (q.partial) return Math.max(0, (right - wrong) / key.size);
  return right === key.size && wrong === 0 ? 1 : 0;
}

export function isAnswered(a: DemoAnswer): boolean {
  return a != null && a !== '' && !(Array.isArray(a) && a.length === 0);
}

export interface DemoResult {
  earned: number;
  max: number;
  percent: number;
  passed: boolean;
  rows: { q: DemoQuestion; earned: number; answered: boolean }[];
}

export function scoreDemo(answers: DemoAnswers, questions = DEMO_QUESTIONS): DemoResult {
  const rows = questions.map((q) => {
    const a = answers[q.id];
    return {
      q,
      earned: Math.round(fractionFor(q, a) * q.points * 100) / 100,
      answered: isAnswered(a),
    };
  });
  const max = questions.reduce((s, q) => s + q.points, 0);
  const earned = Math.round(rows.reduce((s, r) => s + r.earned, 0) * 100) / 100;
  const percent = max === 0 ? 0 : Math.round((earned / max) * 1000) / 10;
  return { earned, max, percent, passed: percent >= PASS_PERCENT, rows };
}

/** Readable form of the candidate's answer for the breakdown. */
export function describeAnswer(q: DemoQuestion, a: DemoAnswer): string {
  if (!isAnswered(a)) return 'Not answered';
  if (q.type === 'written') return String(a);
  if (q.type === 'numeric') return `${a}${q.unit ? ' ' + q.unit : ''}`;
  const opts = q.options ?? [];
  if (Array.isArray(a)) return a.map((i) => opts[i]).join(', ');
  return opts[a as number] ?? 'Not answered';
}

export const SHARE_URL = 'https://assessiq.in/try';

export function shareLinks(percent: number | null): Record<'linkedin' | 'x' | 'whatsapp', string> {
  const text =
    percent == null
      ? 'I tried the AssessIQ sample assessment, no signup needed.'
      : `I scored ${percent}% on the AssessIQ sample assessment. Try it, no signup needed.`;
  const u = encodeURIComponent(SHARE_URL);
  return {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${u}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text} ${SHARE_URL}`)}`,
  };
}
